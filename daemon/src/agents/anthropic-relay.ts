import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { config } from '../config.ts';

/** A per-session credential reaches only this fixed Messages route. The provider key
 * stays in the daemon; redirects and arbitrary upstream URLs are never accepted. */
export function createAnthropicRelay(fetcher: typeof fetch = fetch) {
  const token = randomBytes(32).toString('hex');
  const active = new Set<AbortController>();
  let closed = false;
  return {
    token,
    close() { closed = true; for (const abort of active) abort.abort(); },
    async handle(req: IncomingMessage, res: ServerResponse) {
      const route = req.url?.split('?')[0];
      if (closed || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      if (req.method !== 'POST' || !['/anthropic/v1/messages', '/anthropic/v1/messages/count_tokens'].includes(route ?? '')) {
        res.writeHead(404).end(); return;
      }
      const abort = new AbortController();
      active.add(abort);
      res.on('close', () => abort.abort());
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 64 * 1024 * 1024) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        let body: Record<string, unknown>;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { res.writeHead(400).end(); return; }
        if (!body || body.model !== config.models.worker) { res.writeHead(400).end('Unsupported coding model'); return; }
        const headers: Record<string, string> = {
          'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
        };
        if (typeof req.headers['anthropic-beta'] === 'string') headers['anthropic-beta'] = req.headers['anthropic-beta'];
        const upstream = await fetcher(`https://api.anthropic.com${route!.slice('/anthropic'.length)}`, {
          method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(config.models.requestTimeoutMs)]),
        });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        if (upstream.body) for await (const chunk of upstream.body) {
          if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal });
        }
        res.end();
      } catch {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      } finally { active.delete(abort); }
    },
  };
}
