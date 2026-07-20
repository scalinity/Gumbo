import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { config } from './config.ts';
import { forgetHost, listHosts, rememberHost } from './mac/hosts.ts';
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

    // M7: the computer-use host allowlist (browser lane + script-lane URL gate). GET
    // lists base (config-owned) + remembered; POST/DELETE manage the remembered set —
    // {"host": "example.com"} — matching the notch confirm's "remember" write-through.
    // Loopback-only server, same trust model as every other /api route.
    if (url.pathname === '/api/hosts') {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') {
        res.end(JSON.stringify(listHosts()));
        return;
      }
      if (req.method === 'POST' || req.method === 'DELETE') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          let host = '';
          try {
            host = String((JSON.parse(body || '{}') as { host?: unknown }).host ?? '').trim();
          } catch {
            // fall through to the empty-host 400
          }
          // A bare hostname, not a URL — reject anything with a scheme/slash/space.
          if (!host || /[\s/:]/.test(host)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'pass {"host":"example.com"} (bare hostname)' }));
            return;
          }
          if (req.method === 'POST') rememberHost(host);
          else forgetHost(host);
          res.end(JSON.stringify(listHosts()));
        });
        return;
      }
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'GET, POST or DELETE' }));
      return;
    }

    // M5: the reminders list (upcoming first, then past) — the dashboard bootstraps from
    // here and live-updates off reminder.* events.
    if (url.pathname === '/api/schedule') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(store.listSchedules()));
      return;
    }

    // M5: gallery listing, newest first. The filesystem is the source of truth (images
    // outlive any event cap); only names travel — bytes stream via /files/images/<name>.
    if (url.pathname === '/api/images') {
      res.setHeader('Content-Type', 'application/json');
      let entries: Array<{ file: string; ts: number }> = [];
      try {
        entries = readdirSync(config.home.images)
          .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
          .flatMap((f) => {
            try {
              return [{ file: f, ts: statSync(join(config.home.images, f)).mtimeMs }];
            } catch {
              return []; // vanished between readdir and stat — costs one entry, not the gallery (review 🔵)
            }
          })
          .sort((a, b) => b.ts - a.ts);
      } catch {
        // images dir missing (fresh GUMBO_HOME) → empty gallery, not a 500
      }
      res.end(JSON.stringify(entries));
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
