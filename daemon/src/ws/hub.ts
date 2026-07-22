import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { config } from '../config.ts';
import type { ClientRole, InboundMessage, OutboundMessage } from './protocol.ts';

type MessageHandler = (msg: InboundMessage, role: ClientRole) => void;
type BinaryHandler = (frame: Buffer, role: ClientRole) => void;
type HelloHandler = (role: ClientRole) => void;

const ROLES: ReadonlySet<string> = new Set(['shell', 'dashboard']);

export interface HubOptions {
  /** When set, a hello claiming the privileged 'shell' role MUST carry a matching token
   *  (the daemon's 0600 secret). Omitted in tests that don't exercise auth. */
  shellToken?: string;
}

export class Hub {
  private clients = new Map<WebSocket, ClientRole>();
  private handlers: MessageHandler[] = [];
  private binaryHandlers: BinaryHandler[] = [];
  private helloHandlers: HelloHandler[] = [];
  private closeHandlers: HelloHandler[] = [];
  private shellToken?: string;

  constructor(server: Server, opts: HubOptions = {}) {
    this.shellToken = opts.shellToken;
    const wss = new WebSocketServer({
      server,
      path: '/ws',
      // Browsers always send Origin; a hostile page's Origin won't be in the allowlist,
      // which blocks cross-origin WebSocket drive-by attacks (WS is exempt from same-origin
      // policy). The future native Swift shell sends no Origin (undefined) → allowed.
      verifyClient: ({ origin }: { origin?: string }) =>
        origin === undefined || config.allowedOrigins.includes(origin),
    });
    // A connection emits 'error' on ECONNRESET/EPIPE and on a failed send; Node throws if
    // 'error' has no listener, and the daemon has no uncaughtException net — so one stray
    // socket reset (a dashboard tab crash, a broadcast mid-close) would crash the WHOLE
    // daemon (voice, tasks, scheduler). Same guard the egress proxy already carries. Cleanup
    // rides the paired 'close' event, which still fires after 'error'.
    wss.on('error', () => {});
    wss.on('connection', (socket) => {
      socket.on('error', () => {});
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          const role = this.clients.get(socket);
          if (!role) return; // must hello first
          const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
          for (const handler of this.binaryHandlers) handler(frame, role);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return;
        }
        // A text frame of `null`, a scalar, or an array all parse cleanly — reading
        // `.type` off `null` then throws a TypeError out of this handler (uncaught → the
        // whole daemon dies on one malformed frame). Require a plain object with a string
        // `type` before dispatch; anything else is silently ignored.
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || typeof (parsed as { type?: unknown }).type !== 'string') {
          return;
        }
        const msg = parsed as InboundMessage;
        if (msg.type === 'hello') {
          if (!ROLES.has(msg.role)) return;
          // The privileged 'shell' role must prove it can read the daemon's 0600 token
          // file — loopback + Origin gate a browser, but not a native no-Origin process
          // claiming shell (which could approve confirms or forge Mac results). A bad or
          // missing token closes the socket instead of silently admitting it. The browser
          // 'dashboard' role has no file access, so it stays Origin-gated and token-free.
          const helloToken = typeof (msg as { token?: unknown }).token === 'string' ? (msg as { token?: string }).token : undefined;
          if (msg.role === 'shell' && this.shellToken && helloToken !== this.shellToken) {
            socket.close(4001, 'unauthorized shell role');
            return;
          }
          this.clients.set(socket, msg.role);
          for (const handler of this.helloHandlers) handler(msg.role);
          return;
        }
        const role = this.clients.get(socket);
        if (!role) return; // must hello first
        for (const handler of this.handlers) handler(msg, role);
      });
      socket.on('close', () => {
        const role = this.clients.get(socket);
        this.clients.delete(socket);
        if (role) for (const handler of this.closeHandlers) handler(role);
      });
    });
  }

  onMessage(handler: MessageHandler) {
    this.handlers.push(handler);
  }

  onBinary(handler: BinaryHandler) {
    this.binaryHandlers.push(handler);
  }

  /** Fires after a client identifies itself — reconnects included (shell relaunches and
   *  tsx-watch restarts are routine, so state like bubbles must be re-syncable). */
  onHello(handler: HelloHandler) {
    this.helloHandlers.push(handler);
  }

  /** Fires when an identified client disconnects (e.g. clear shell-owned state like
   *  playback-draining so a dead shell can't wedge the session state machine). */
  onClose(handler: HelloHandler) {
    this.closeHandlers.push(handler);
  }

  hasRole(role: ClientRole): boolean {
    for (const r of this.clients.values()) if (r === role) return true;
    return false;
  }

  sendBinary(frame: Uint8Array, to: ClientRole) {
    for (const [socket, role] of this.clients) {
      if (role !== to) continue;
      // Callback swallows a write error (e.g. a socket that closed between the readyState
      // check and the send) so it doesn't surface as a connection 'error' event.
      if (socket.readyState === WebSocket.OPEN) socket.send(frame, { binary: true }, () => {});
    }
  }

  broadcast(msg: OutboundMessage, to: ClientRole | 'all' = 'all') {
    const data = JSON.stringify(msg);
    for (const [socket, role] of this.clients) {
      if (to !== 'all' && role !== to) continue;
      if (socket.readyState === WebSocket.OPEN) socket.send(data, () => {});
    }
  }
}
