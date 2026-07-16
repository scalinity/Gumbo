import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';

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

/** Split a CONNECT target ("host:port", or "[::1]:443") into host + port. */
function parseTarget(target: string): { host: string; port: number } {
  const idx = target.lastIndexOf(':');
  if (idx === -1) return { host: target, port: 443 };
  return { host: target.slice(0, idx), port: Number(target.slice(idx + 1)) || 443 };
}

/**
 * Start the loopback CONNECT filtering proxy. `allowed` is the flow-freely allowlist;
 * `onUnknown(host)` is invoked once per non-allowlisted host (the runner routes it to the
 * supervisor's notch confirm) and its decision is memoized for the session — a host approved
 * (or denied) once isn't re-prompted, and concurrent connects to the same host share one
 * in-flight decision. Binds 127.0.0.1 on an ephemeral port. Never throws from a socket error
 * (the daemon must not crash because a session's connection broke).
 */
export async function startEgressProxy(
  allowed: readonly string[],
  onUnknown: (host: string) => Promise<boolean>,
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
    const { host, port } = parseTarget(req.url ?? '');

    const tunnel = () => {
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
    };
    const refuse = () => {
      clientSock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSock.end();
    };

    if (hostAllowed(host, allowed)) {
      tunnel();
      return;
    }
    let decision = decided.get(host);
    if (!decision) {
      decision = onUnknown(host).catch(() => false); // escalation failure → deny (fail-closed)
      decided.set(host, decision);
    }
    decision.then((ok) => (ok ? tunnel() : refuse())).catch(refuse);
  });

  // A malformed CONNECT/handshake surfaces here — destroy the socket, never let it throw.
  proxy.on('clientError', (_e, sock) => sock.destroy());

  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
  const addr = proxy.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  if (!port) {
    proxy.close();
    throw new Error('egress proxy failed to bind a loopback port');
  }
  return { port, close: () => proxy.close() };
}
