import { createServer } from 'node:http';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { config } from './config.ts';
import type { Store } from './events/store.ts';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

// Only these subtrees of the agent home are ever served. The sqlite db lives outside
// them, so it can never be fetched even if a path guard were bypassed.
const servedRoots = config.home.served.map((name) => resolve(config.agentHome, name));

function resolveServedFile(rel: string): string | null {
  const candidate = resolve(join(config.agentHome, rel));
  const withinServed = servedRoots.some((root) => candidate === root || candidate.startsWith(root + sep));
  if (!withinServed || !existsSync(candidate) || !statSync(candidate).isFile()) return null;
  // Defeat symlinks that resolve outside the served roots (path math alone can't catch these).
  const real = realpathSync(candidate);
  const stillServed = servedRoots.some((root) => real === root || real.startsWith(root + sep));
  return stillServed ? real : null;
}

export function createHttpServer(store: Store) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);

    if (url.pathname === '/api/tasks') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(store.listTasks()));
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([\w-]+)$/);
    if (taskMatch) {
      const task = store.getTask(taskMatch[1]);
      res.setHeader('Content-Type', 'application/json');
      if (!task) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.end(JSON.stringify(task));
      return;
    }

    if (url.pathname === '/api/events') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          store.listEvents({
            taskId: url.searchParams.get('task_id') ?? undefined,
            beforeSeq: Number(url.searchParams.get('before_seq')) || undefined,
            limit: Number(url.searchParams.get('limit')) || undefined,
          }),
        ),
      );
      return;
    }

    if (url.pathname.startsWith('/files/')) {
      const rel = normalize(decodeURIComponent(url.pathname.slice('/files/'.length)));
      const filePath = resolveServedFile(rel);
      if (!filePath) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream');
      const stream = createReadStream(filePath);
      // A file removed between stat and read, or a disk error mid-stream, must not crash the daemon.
      stream.on('error', () => {
        if (!res.headersSent) res.statusCode = 404;
        res.end();
      });
      stream.pipe(res);
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });
}
