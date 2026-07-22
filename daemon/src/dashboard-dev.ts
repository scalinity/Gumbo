import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The shell's notch/status-item click opens a WKWebView pointed at the Vite dev server.
// If nobody started it, that window is a blank white screen. Rather than make the user run
// `npm run dev:dashboard` in a terminal, the daemon starts it for him — so clicking the
// notch always Just Works.
const DASHBOARD_PORT = 5173;

/**
 * Best-effort: ensure the React dashboard dev server is reachable. Probes the port; if
 * nothing answers, starts Vite DETACHED so it survives the frequent tsx-watch daemon
 * reloads (and a daemon quit) — the port probe keeps a restart from double-starting it,
 * and a manually-started Vite is left untouched. Dev convenience only, and defensively
 * total: any failure (no npm, no dashboard dir, spawn error) is swallowed so a blank
 * dashboard can never take the daemon down. Opt out with GUMBO_NO_DASHBOARD.
 */
export function ensureDashboardDevServer(): void {
  if (process.env.GUMBO_NO_DASHBOARD) return;
  let settled = false;
  const probe = connect({ host: '127.0.0.1', port: DASHBOARD_PORT });
  const finish = (running: boolean) => {
    if (settled) return;
    settled = true;
    probe.destroy();
    if (!running) startVite();
  };
  probe.setTimeout(600);
  probe.once('connect', () => finish(true)); // already up (auto or manual) — leave it be
  probe.once('timeout', () => finish(false));
  probe.once('error', () => finish(false)); // ECONNREFUSED = nothing listening → start it
}

function startVite(): void {
  // Same repo-root derivation as config.ts (this file sits in daemon/src/).
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  // A packaged/headless deploy has no dashboard workspace to run — nothing to do.
  if (!existsSync(resolve(repoRoot, 'dashboard', 'package.json'))) return;
  try {
    // The exact invocation the dev:dashboard script uses; npm is on the daemon's PATH
    // because npm launched the daemon. Detached + ignored stdio + unref so the daemon
    // neither waits on it nor kills it on a tsx reload.
    const child = spawn('npm', ['run', 'dev', '--workspace', 'dashboard'], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.once('error', () => {}); // npm missing / spawn failure — stay best-effort
    child.unref();
    console.log(`starting dashboard dev server on http://localhost:${DASHBOARD_PORT} (auto — survives daemon restarts; set GUMBO_NO_DASHBOARD to disable)`);
  } catch {
    // A dev-convenience spawn must never be able to crash the daemon.
  }
}
