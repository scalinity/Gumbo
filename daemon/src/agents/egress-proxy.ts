import { createServer, type Server } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';

// Cap on distinct non-allowlisted hosts a single session may escalate. Past this, further novel
// hosts are refused without a confirm — bounds notch spam and the `decided` map from an attacker
// generating endless subdomains (review 🔵). Exported for the unit test.
export const MAX_ESCALATIONS = 20;

// M4.1 egress filtering proxy (network posture: default-deny + allowlist + escalate). The
// sandboxed Claude CLI runs under a Seatbelt profile that denies every DIRECT socket and
// re-allows ONLY loopback to this proxy (see claude-runner buildSandboxProfile), and its env
// carries HTTPS_PROXY=http://127.0.0.1:<port>. So the CLI *and* any bash it spawns are forced
// through here, where each CONNECT is checked: allowlisted host → tunnel; unknown host →
// escalate to the user (a notch confirm, deny-on-timeout headlessly). This closes the open-network
// exfil channel — a prompt-injected session can no longer GET-exfil a readable secret to an
// attacker host, because that host isn't on the allowlist and the confirm denies on timeout.

export interface EgressProxy {
  /** Loopback port the sandboxed CLI points HTTPS_PROXY at. */
  port: number;
  /** Stop listening (call when the session ends). */
  close(): void;
}

/** A host is allowed if it equals an allowlist domain or is a subdomain of one. Exported for
 *  unit tests. Case-insensitive; `github.com` matches `github.com` and `api.github.com`, never
 *  `notgithub.com` (the leading dot in the suffix check prevents that). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((d) => {
    const dd = d.toLowerCase();
    return h === dd || h.endsWith('.' + dd);
  });
}

/** Split a CONNECT target ("host:port" or bracketed IPv6 "[::1]:443") into host + port, or null
 *  if malformed. host is lowercased (case-insensitive for DNS/IPv6). Rejects an empty host and an
 *  out-of-range/non-integer port — an unvalidated port reaches `net.connect`, which throws
 *  ERR_SOCKET_BAD_PORT *synchronously* on the allowlisted path and would crash the daemon (🔴). */
function parseTarget(target: string): { host: string; port: number } | null {
  const idx = target.lastIndexOf(':');
  const rawHost = idx === -1 ? target : target.slice(0, idx);
  const port = idx === -1 ? 443 : Number(target.slice(idx + 1));
  // Strip brackets from an IPv6 literal so `net.connect`/allowlist see a bare address.
  const host = (rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost).toLowerCase();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Fold the numeric IP encodings the OS resolver still accepts to a dotted quad, so the
 *  loopback/private checks below can't be dodged by writing 127.0.0.1 as `2130706433`,
 *  `0x7f000001`, or `::ffff:127.0.0.1`. Non-numeric hosts (real hostnames) pass through
 *  unchanged. review 🔵. */
function canonicalIpLiteral(host: string): string {
  const mapped = /^::ffff:(.+)$/i.exec(host); // IPv4-mapped IPv6
  if (mapped) {
    const inner = mapped[1];
    if (isIP(inner) === 4) return inner;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(inner); // ::ffff:7f00:0001
    if (hex) {
      const n = (parseInt(hex[1], 16) * 0x10000 + parseInt(hex[2], 16)) >>> 0;
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    }
  }
  // Dotless integer / hex forms getaddrinfo maps to IPv4 (127.0.0.1 == 2130706433 == 0x7f000001).
  const asInt = /^\d+$/.test(host) ? Number(host) : /^0x[0-9a-f]+$/i.test(host) ? parseInt(host, 16) : NaN;
  if (Number.isInteger(asInt) && asInt >= 0 && asInt <= 0xffffffff) {
    return [(asInt >>> 24) & 255, (asInt >>> 16) & 255, (asInt >>> 8) & 255, asInt & 255].join('.');
  }
  return host;
}

/** Refuse loopback/private/link-local IP LITERALS outright (no confirm): they can only be the
 *  daemon's own control plane or a LAN pivot — never a legitimate external service (which is
 *  reached by hostname). Hostnames return false here and go through the allowlist/escalate path
 *  (the proxy resolves them upstream). review 🔵. */
function isForbiddenLiteral(host: string): boolean {
  const canon = canonicalIpLiteral(host);
  const v = isIP(canon);
  if (v === 4) {
    const [a, b] = canon.split('.').map(Number);
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (v === 6) {
    return canon === '::1' || canon === '::' || canon.startsWith('fe80') || canon.startsWith('fc') || canon.startsWith('fd');
  }
  return false; // not an IP literal → a hostname
}

/** From a host's RESOLVED addresses, the vetted IP to connect to, or null to refuse.
 *  Reject-if-ANY-forbidden (a rebinding/split-horizon host often returns a public AND a
 *  private record; either private one is disqualifying), then connect to the first — which,
 *  having passed the check, is safe. Exported for unit tests. */
export function vetResolvedAddresses(addresses: readonly string[]): string | null {
  if (addresses.length === 0) return null;
  if (addresses.some((a) => isForbiddenLiteral(a))) return null;
  return addresses[0];
}

/** Resolve a CONNECT host to the IP the proxy will actually dial, refusing (null) any host
 *  that resolves to a loopback/private/link-local address (scan MEDIUM: SSRF via DNS). DNS
 *  runs in the UNSANDBOXED daemon, so an allowlisted-or-approved hostname could otherwise
 *  resolve/rebind to 127.0.0.1 or RFC1918 and reach the daemon's own control plane or a LAN
 *  service. Connecting to the VETTED IP (not re-resolving) also closes the check-then-connect
 *  rebinding window. An IP literal was already vetted at the CONNECT gate, so it passes
 *  through unchanged; a hostname is looked up and every address checked. */
export type ResolveTarget = (host: string, port: number) => Promise<string | null>;
const defaultResolveTarget: ResolveTarget = async (host) => {
  if (isIP(host)) return isForbiddenLiteral(host) ? null : host; // literal — belt over the CONNECT-gate check
  try {
    const addrs = (await lookup(host, { all: true })).map((r) => r.address);
    return vetResolvedAddresses(addrs);
  } catch {
    return null; // resolution failed → refuse rather than hand a bare host to net.connect
  }
};

/**
 * Start the loopback CONNECT filtering proxy. `allowed` is the flow-freely allowlist;
 * `onUnknown(host)` is invoked once per non-allowlisted host (lowercased — the runner routes it to
 * the supervisor's notch confirm) and its decision is memoized for the session by that lowercased
 * host — a host approved (or denied) once isn't re-prompted, case variants don't re-prompt, and
 * concurrent connects to the same host share one in-flight decision. Binds 127.0.0.1 on an
 * ephemeral port. Never throws from a socket error (the daemon must not crash because a session's
 * connection broke).
 */
export async function startEgressProxy(
  allowed: readonly string[],
  onUnknown: (host: string) => Promise<boolean>,
  bindHost = '127.0.0.1', // loopback in prod; a unit test passes an unbindable address to exercise fail-closed
  resolveTarget: ResolveTarget = defaultResolveTarget, // injectable so tests can point a fake hostname at a loopback echo server
): Promise<EgressProxy> {
  // Only non-allowlisted hosts land here (allowlisted ones short-circuit). Stores the
  // in-flight promise so two concurrent connects can't spawn two notch confirms.
  const decided = new Map<string, Promise<boolean>>();
  // Live client + upstream sockets, so close() can tear down in-flight tunnels deterministically
  // at session end instead of relying on pipe end-propagation + the CLI subprocess dying.
  const liveSockets = new Set<Socket>();
  const track = (s: Socket) => {
    liveSockets.add(s);
    s.on('close', () => liveSockets.delete(s));
  };

  const proxy: Server = createServer((_req, res) => {
    // Plain HTTP (non-CONNECT). Everything real is HTTPS/CONNECT; refuse plain HTTP with a
    // clear 405 rather than build a second forwarding path (minimal — revisit if a tool needs it).
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('egress proxy: only HTTPS (CONNECT) is supported');
  });

  proxy.on('connect', (req, clientSock: Socket, head) => {
    // Attach the error handler FIRST — a client RST before we finish setup would otherwise
    // throw and crash the daemon (learned in the spike).
    clientSock.on('error', () => clientSock.destroy());
    track(clientSock);
    const refuse = () => {
      clientSock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSock.end();
    };

    const parsed = parseTarget(req.url ?? '');
    if (!parsed || isForbiddenLiteral(parsed.host)) return refuse();
    const { host, port } = parsed;

    const tunnel = async () => {
      // Resolve the host to a VETTED IP first (SSRF guard): a hostname that resolves to
      // loopback/private/link-local is refused, and we dial the checked IP so a rebind
      // between check and connect can't redirect us. null → refuse.
      let target: string | null;
      try {
        target = await resolveTarget(host, port);
      } catch {
        target = null;
      }
      if (!target) return refuse();
      // net.connect can throw synchronously (a bad host/port that slipped validation) — a throw
      // here escapes the 'connect' handler and, with no uncaughtException handler, crashes the
      // whole daemon. Guard it so a bad tunnel only drops that one connection (review 🔴).
      try {
        const up = connect(port, target, () => {
          clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          up.write(head);
          up.pipe(clientSock);
          clientSock.pipe(up);
        });
        track(up);
        up.on('error', () => {
          clientSock.destroy();
          up.destroy();
        });
        clientSock.on('error', () => up.destroy());
      } catch {
        clientSock.destroy();
      }
    };

    if (hostAllowed(host, allowed)) {
      void tunnel().catch(() => refuse());
      return;
    }
    // Unknown host → escalate (memoized per session by lowercased host, so at most one confirm).
    let decision = decided.get(host);
    if (!decision) {
      if (decided.size >= MAX_ESCALATIONS) return refuse(); // cap distinct escalations
      decision = onUnknown(host).then(
        (ok) => ok,
        () => {
          // Transient escalation error → deny THIS attempt but don't cache it, so a later connect
          // can re-escalate once the supervisor recovers (a genuine user-deny stays cached). 🔵
          decided.delete(host);
          return false;
        },
      );
      decided.set(host, decision);
    }
    decision.then((ok) => (ok ? tunnel() : refuse())).catch(refuse);
  });

  // A malformed CONNECT/handshake surfaces here — destroy the socket, never let it throw.
  proxy.on('clientError', (_e, sock) => sock.destroy());

  // A listen failure (EMFILE/fd exhaustion, loopback down) is emitted asynchronously as an
  // 'error' event. Without a listener Node throws it as an uncaught exception (the daemon has no
  // uncaughtException handler → crash), and the resolve-only promise would never settle — so the
  // runner's fail-closed CLAUDE_PROXY_ERROR throw would be unreachable on the exact failure it
  // exists for (review 🔴). Reject on the bind error; after a clean bind, swallow later server
  // errors so a broken connection can never crash the daemon.
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, bindHost, () => {
      proxy.removeListener('error', reject);
      proxy.on('error', () => {});
      resolve();
    });
  });
  const addr = proxy.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  if (!port) {
    proxy.close();
    throw new Error('egress proxy failed to bind a loopback port');
  }
  return {
    port,
    close: () => {
      for (const s of liveSockets) s.destroy();
      liveSockets.clear();
      proxy.close();
    },
  };
}
