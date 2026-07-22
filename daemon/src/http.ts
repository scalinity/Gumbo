import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { config } from './config.ts';
import { forgetHost, listHosts, rememberHost, validHostEntry } from './mac/hosts.ts';
import { localDay } from './usage/recorder.ts';
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

// DNS-rebinding guard (CWE-350): the daemon binds loopback, but a malicious page can serve
// JS from attacker.com:<port>, rebind attacker.com → 127.0.0.1, and fetch the daemon
// same-origin — the browser still sends `Host: attacker.com`, which CORS won't block. So
// every request's Host hostname must be a loopback literal (the real dashboard/shell always
// send 127.0.0.1 or localhost). The PORT is not pinned: tests and any future rebind bind a
// different port, but the attacker's hostname can never be a loopback literal.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);
function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

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
    // One outer guard: a synchronous throw in any route (a sqlite read hiccup, a JSON
    // stringify failure) becomes a 500 instead of an uncaughtException that crashes the
    // daemon — Node does not wrap the request listener. The async callbacks below keep
    // their own guards; this covers the synchronous dispatch.
    try {
    // Host allowlist first — before any route runs, so a rebinding page can't reach even
    // a read endpoint. Loopback bind alone doesn't authenticate the Host header.
    if (!hostAllowed(req.headers.host)) {
      res.statusCode = 403;
      res.end('forbidden host');
      return;
    }
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
        // CSRF guard (CWE-352): this mutation writes the computer-use exfil allowlist, so it
        // must not be drivable by a hostile page the user happens to have open. A cross-site
        // POST is a CORS "simple request" (no preflight), so the browser WOULD deliver it to
        // loopback — mirror ws/hub.ts verifyClient: a present Origin must be allowlisted; an
        // ABSENT Origin is the native shell / same-origin proxy and is allowed.
        const origin = req.headers.origin;
        if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'cross-origin request refused' }));
          return;
        }
        let body = '';
        let tooLarge = false;
        req.on('data', (chunk) => {
          if (tooLarge) return; // stop accumulating — bounds memory even before the socket tears down
          body += chunk;
          if (body.length > 4096) { // a hostname payload is tiny — cap the stream
            tooLarge = true;
            res.statusCode = 413;
            res.end(JSON.stringify({ error: 'body too large' }));
            req.destroy(); // loopback: the 413 flushes first; a RST-before-read race is moot here
          }
        });
        req.on('end', () => {
          if (tooLarge) return;
          let host = '';
          try {
            host = String((JSON.parse(body || '{}') as { host?: unknown }).host ?? '').trim().toLowerCase();
          } catch {
            // fall through to the 400
          }
          // A bare hostname with a dot — not a URL, not a bare TLD (validHostEntry).
          if (!validHostEntry(host)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'pass {"host":"example.com"} (bare hostname with a dot)' }));
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
      // Validate limit as a 1..1000 integer BEFORE it reaches SQLite: a negative value
      // (e.g. ?limit=-1) is treated as an unbounded LIMIT and would dump the whole log.
      const rawLimit = Number(url.searchParams.get('limit'));
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : undefined;
      res.end(
        JSON.stringify(
          store.listEvents({
            taskId: url.searchParams.get('task_id') ?? undefined,
            beforeSeq: Number(url.searchParams.get('before_seq')) || undefined,
            limit,
          }),
        ),
      );
      return;
    }

    // Usage analytics: day-bucketed aggregates, default window ~120 days. Read-only like
    // /api/tasks (no Origin guard needed); the dashboard rolls days into weeks/months.
    if (url.pathname === '/api/usage') {
      res.setHeader('Content-Type', 'application/json');
      const fromParam = url.searchParams.get('from');
      const fromDay =
        fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam)
          ? fromParam
          : localDay(Date.now() - 120 * 24 * 60 * 60 * 1000);
      res.end(JSON.stringify(store.usageByDay(fromDay)));
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
      // Client aborted the download mid-transfer → tear the read stream down promptly so its
      // fd doesn't linger until GC.
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    res.statusCode = 404;
    res.end('not found');
    } catch (err) {
      console.error('http handler failed:', err);
      if (!res.headersSent) res.statusCode = 500;
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
}
