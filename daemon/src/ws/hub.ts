import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { config } from '../config.ts';
import type { ClientRole, InboundMessage, OutboundMessage } from './protocol.ts';

type MessageHandler = (msg: InboundMessage, role: ClientRole) => void;
type BinaryHandler = (frame: Buffer, role: ClientRole) => void;
type HelloHandler = (role: ClientRole) => void;

const ROLES: ReadonlySet<string> = new Set(['shell', 'dashboard']);

export class Hub {
  private clients = new Map<WebSocket, ClientRole>();
  private handlers: MessageHandler[] = [];
  private binaryHandlers: BinaryHandler[] = [];
  private helloHandlers: HelloHandler[] = [];
  private closeHandlers: HelloHandler[] = [];

  constructor(server: Server) {
    const wss = new WebSocketServer({
      server,
      path: '/ws',
      // Browsers always send Origin; a hostile page's Origin won't be in the allowlist,
      // which blocks cross-origin WebSocket drive-by attacks (WS is exempt from same-origin
      // policy). The future native Swift shell sends no Origin (undefined) → allowed.
      verifyClient: ({ origin }: { origin?: string }) =>
        origin === undefined || config.allowedOrigins.includes(origin),
    });
    wss.on('connection', (socket) => {
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          const role = this.clients.get(socket);
          if (!role) return; // must hello first
          const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
          for (const handler of this.binaryHandlers) handler(frame, role);
          return;
        }
        let msg: InboundMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.type === 'hello') {
          if (ROLES.has(msg.role)) {
            this.clients.set(socket, msg.role);
            for (const handler of this.helloHandlers) handler(msg.role);
          }
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
      if (socket.readyState === WebSocket.OPEN) socket.send(frame, { binary: true });
    }
  }

  broadcast(msg: OutboundMessage, to: ClientRole | 'all' = 'all') {
    const data = JSON.stringify(msg);
    for (const [socket, role] of this.clients) {
      if (to !== 'all' && role !== to) continue;
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }
}
