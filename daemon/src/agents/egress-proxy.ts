import { createServer, type Server } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';

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

/** Refuse loopback/private/link-local IP LITERALS outright (no confirm): they can only be the
 *  daemon's own control plane or a LAN pivot — never a legitimate external service (which is
 *  reached by hostname). Hostnames return false here and go through the allowlist/escalate path
 *  (the proxy resolves them upstream). review 🔵. */
function isForbiddenLiteral(host: string): boolean {
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (v === 6) {
    return host === '::1' || host === '::' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd');
  }
  return false; // not an IP literal → a hostname
}

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
): Promise<EgressProxy> {
  // Only non-allowlisted hosts land here (allowlisted ones short-circuit). Stores the
  // in-flight promise so two concurrent connects can't spawn two notch confirms.
  const decided = new Map<string, Promise<boolean>>();

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
    const refuse = () => {
      clientSock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSock.end();
    };

    const parsed = parseTarget(req.url ?? '');
    if (!parsed || isForbiddenLiteral(parsed.host)) return refuse();
    const { host, port } = parsed;

    const tunnel = () => {
      // net.connect can throw synchronously (a bad host/port that slipped validation) — a throw
      // here escapes the 'connect' handler and, with no uncaughtException handler, crashes the
      // whole daemon. Guard it so a bad tunnel only drops that one connection (review 🔴).
      try {
        const up = connect(port, host, () => {
          clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          up.write(head);
          up.pipe(clientSock);
          clientSock.pipe(up);
        });
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
      tunnel();
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
          // can re-escalate once the supervisor recovers (a genuine the user-deny stays cached). 🔵
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
  return { port, close: () => proxy.close() };
}
