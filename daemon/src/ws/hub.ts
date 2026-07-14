import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { config } from '../config.ts';
import type { ClientRole, InboundMessage, OutboundMessage } from './protocol.ts';

type MessageHandler = (msg: InboundMessage, role: ClientRole) => void;

const ROLES: ReadonlySet<string> = new Set(['shell', 'dashboard']);

export class Hub {
  private clients = new Map<WebSocket, ClientRole>();
  private handlers: MessageHandler[] = [];

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
        if (isBinary) return; // audio frames arrive in M2
        let msg: InboundMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.type === 'hello') {
          if (ROLES.has(msg.role)) this.clients.set(socket, msg.role);
          return;
        }
        const role = this.clients.get(socket);
        if (!role) return; // must hello first
        for (const handler of this.handlers) handler(msg, role);
      });
      socket.on('close', () => this.clients.delete(socket));
    });
  }

  onMessage(handler: MessageHandler) {
    this.handlers.push(handler);
  }

  broadcast(msg: OutboundMessage, to: ClientRole | 'all' = 'all') {
    const data = JSON.stringify(msg);
    for (const [socket, role] of this.clients) {
      if (to !== 'all' && role !== to) continue;
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }
}
