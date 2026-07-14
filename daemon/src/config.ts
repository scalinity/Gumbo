import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  process.loadEnvFile(join(repoRoot, '.env'));
} catch {
  // .env optional when vars are already in the environment
}

const port = 8737;
const dashboardPort = 5173;
const agentHome = process.env.GUMBO_HOME ?? join(homedir(), 'Gumbo');

// Organized agent home — never a flat dumping ground. Only `served` subtrees are
// reachable over /files; `db` and future private state stay off the wire.
export const home = {
  root: agentHome,
  tasks: join(agentHome, 'tasks'), // per-task workspaces + report.md
  images: join(agentHome, 'images'), // generated images (M5)
  notes: join(agentHome, 'notes'), // agent-curated notes / knowledge (self-organization)
  db: join(agentHome, 'db'), // sqlite — deliberately outside the /files-served subtree
  /** Subtrees exposed read-only via GET /files/<name>/… */
  served: ['tasks', 'images', 'notes'] as const,
};

export const config = {
  port,
  host: '127.0.0.1', // loopback only — do not bind all interfaces
  allowedOrigins: [`http://localhost:${dashboardPort}`, `http://127.0.0.1:${dashboardPort}`],
  agentHome,
  home,
  dbPath: join(home.db, 'gumbo.db'),
  models: {
    realtime: 'gpt-realtime-2.1',
    subagent: 'gpt-5.6-terra',
  },
  // M1 runs the orchestrator text-only; M2 flips this to ['audio']
  outputModalities: ['text'] as ('text' | 'audio')[],
  sessionIdleMs: 60_000,
  reportMaxChars: 12_000,
  activityLogMaxChars: 500, // truncation for tool args / outputs in the activity log
};
