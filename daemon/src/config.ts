import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  process.loadEnvFile(join(repoRoot, '.env'));
} catch {
  // .env optional when vars are already in the environment
}

const port = Number(process.env.GUMBO_PORT ?? 8737); // override for isolated test instances
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
  logs: join(agentHome, 'logs'), // append-only JSONL audit trails — private, never served
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
  // M2: the orchestrator speaks. Typed dashboard input still works — replies are spoken
  // and the transcript still streams to the dashboard via output_audio_transcript deltas.
  outputModalities: ['audio'] as ('text' | 'audio')[],
  voice: 'marin',
  // PTT turn model: the server VAD never auto-responds (createResponse: false — commit and
  // response are driven by ⌃⌥ release), but it DOES cut Gumbo off the moment the user actually
  // speaks while armed (interruptResponse: true → audio_interrupted → shell playback flush).
  // Input transcription is on so voice turns land in the store/dashboard with real user text.
  realtimeAudio: {
    input: {
      format: 'pcm16' as const, // 24 kHz mono pcm16 — the shell's exact wire format
      transcription: { model: 'gpt-4o-mini-transcribe' },
      turnDetection: { type: 'server_vad' as const, createResponse: false, interruptResponse: true },
    },
    output: { format: 'pcm16' as const },
  },
  // A ⌃⌥ tap shorter than this has no usable audio — the API rejects commits under ~100 ms.
  minPttAudioBytes: 4800, // 100 ms @ 24 kHz mono 16-bit (48 bytes/ms)
  sessionIdleMs: 60_000,
  // Web search providers: Tavily answers on the voice hot path (fail fast, no retries);
  // Exa does background research (full contents, retries allowed). Keys in repo .env.
  search: {
    tavilyDepth: 'fast' as 'basic' | 'advanced' | 'fast' | 'ultra-fast',
    // Hard cap — a voice turn is waiting on this. Spec asked for 2000, but measured Tavily
    // fast-depth latency with answer synthesis is 1.9–2.8 s on fresh queries (2026-07-15),
    // so 2000 timed out on roughly half of real lookups. Tighten if Tavily's fast lane improves.
    quickLookupTimeoutMs: 3000,
    quickLookupMaxResults: 5,
    backgroundNumResults: 10,
  },
  reportMaxChars: 12_000,
  activityLogMaxChars: 500, // truncation for tool args / outputs in the activity log
};
