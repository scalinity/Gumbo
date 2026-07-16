import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  process.loadEnvFile(join(repoRoot, '.env'));
} catch {
  // .env optional when vars are already in the environment
}

// Port override for isolated test instances. Malformed values fall back to the default:
// Number('') is 0 and Number('junk') is NaN — either would bind the wrong port entirely.
const envPort = Number(process.env.GUMBO_PORT);
const port = Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : 8737;
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

/** Today's date for model instructions — built fresh per session/run so long-lived
 *  daemons never drift; without it models assume their training-data "today". */
export function todayLabel(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

/** Local time of day for the orchestrator's instructions (M5): resolving "in 10 minutes"
 *  or "at 5" to an absolute fire time needs the clock, not just the date. Sessions are
 *  short-lived (60 s idle close), so session-creation time is fresh enough. */
export function timeLabel(): string {
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Daemon-held secrets that must NEVER reach a spawned subprocess (the Claude Code session
// needs none of them). Stripped from the subprocess env in claude-runner. Add any new
// provider key here the moment it lands in .env. ANTHROPIC_API_KEY is included because it
// silently outranks the claude.ai subscription login (spike finding).
export const secretEnvKeys = ['OPENAI_API_KEY', 'EXA_API_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY', 'ANTHROPIC_API_KEY'] as const;

// Secrets ON DISK a sandboxed Claude session must never touch (review 🟡 2026-07-16): the
// env strip above covers the subprocess environment, but the same provider keys live in the
// repo .env — and a session working on Gumbo itself has this repo as its cwd — while ~/.claude
// holds Claude Code state (session transcripts under projects/ can embed secrets). Since the
// M4.1 rebuild the WHOLE CLI runs under Seatbelt, so `.env` is OS read-denied for BOTH bash
// and the file tools (claude-runner `readDenied`). `~/.claude` is deliberately left OS-readable
// (the CLI needs its own state), so its protection is only the supervisor policy hard-deny of
// the file TOOLS (protectedPathHit) — bash reads of ~/.claude are the accepted open-network
// residual. Keep this list and `readDenied` in sync — both derive `.env` from here.
export const secretFilePaths = [join(repoRoot, '.env'), join(homedir(), '.claude')] as const;

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
    supervisor: 'gpt-5.6-terra',
    // M3 cold announcements. Verified live (2026-07-15): /v1/audio/speech accepts the
    // 'marin' voice on this model with response_format 'pcm' → 24 kHz mono pcm16, the
    // exact shell wire format — same voice as the realtime session, zero transcoding.
    tts: 'gpt-4o-mini-tts',
    // M5 image generation. Verified live (2026-07-16): /v1/images/generations accepts
    // this id (a dated snapshot gpt-image-2-2026-04-21 also exists) and returns
    // data[0].b64_json — base64 PNG (output_format defaults to png). Sizes are free-form
    // as long as width and height are divisible by 16 (probed via the API's own error).
    image: 'gpt-image-2',
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
  // M4 Claude Code sessions run in "auto mode" (the user's call, 2026-07-15): the pure
  // policy table gates everything; the supervisor MODEL is only invoked when Claude
  // actually asks a question (AskUserQuestion) — never per turn or per tool call.
  claude: {
    // Hard ceiling on supervisor answers per session. A Claude that keeps asking is
    // stuck, and each answer is a model call — past the cap the session pauses
    // (needs_input) and waits for the user instead of looping.
    maxInterventions: 5,
    // Notch confirm: deny on timeout so a missed prompt can't hang a session forever.
    confirmTimeoutMs: 60_000,
    // The PreToolUse hook legitimately blocks while an escalation confirm is pending, so its
    // own timeout must comfortably outlast confirmTimeoutMs — otherwise the CLI could kill the
    // hook mid-confirm and the escalate-class action could slip. Seconds at the SDK boundary.
    hookTimeoutMs: 120_000,
    maxTurns: 100, // runaway backstop, not a working budget
    // Plan-before-execute (the user, 2026-07-16): a fresh session first runs read-only in
    // plan mode, surfaces its plan for approval, and only then edits. Follow-ups (resumes)
    // skip planning — they're already a direct instruction. Flip false to disable globally.
    planFirst: true,
    // Plan approval is a deliberate review, not a fail-safe like a dangerous action — give
    // the user room to read the plan (in the dashboard/bubble) before the notch auto-denies.
    // A denied/timed-out plan parks needs_input; it's resumable, nothing is lost.
    planConfirmTimeoutMs: 900_000, // 15 min
    // M4.1: OS-level sandbox (macOS Seatbelt) around the WHOLE Claude CLI process —
    // deterministic filesystem containment for the file tools AND bash, UNDER the semantic
    // gates (plan mode, PreToolUse hook, notch escalations). The CLI is wrapped in
    // `sandbox-exec` via the SDK's spawnClaudeCodeProcess seam (see claude-runner.ts):
    // writes confined to cwd + the task workspace + the CLI's runtime dirs, on-disk secrets
    // read-denied. Network stays open at the OS level (the CLI needs Anthropic and a single
    // Seatbelt layer can't split CLI-vs-bash egress without an out-of-sandbox proxy) — bash
    // exfil remains gated by the supervisor policy's network-send escalation. See
    // IMPLEMENTATION_NOTES §M4.1 for the full rationale and the srt network-deny follow-up.
    sandbox: {
      enabled: true,
      // Fail closed: if Seatbelt is unavailable (non-macOS, or sandbox-exec missing), the
      // session refuses to run rather than silently running unconfined.
      failIfUnavailable: true,
    },
    // Docs MCP for headless sessions (the user, 2026-07-16): the sessions don't inherit
    // claude.ai connectors like Context7, so wire it explicitly for up-to-date library docs
    // during implementation. Added ON TOP of the ~/.claude MCP servers the session already
    // inherits (currently exa + playwright). CLIs the user has (e.g. firecrawl) work directly
    // under the sandbox via their own stored auth — no wiring needed.
    mcpServers: {
      context7: { type: 'http' as const, url: 'https://mcp.context7.com/mcp' },
    },
  },
  // Firecrawl: content acquisition (scrape/crawl/map/extract) for background sub-agents
  // only — never a search provider, never on the voice hot path. All budgets are generous
  // background budgets (Exa `deep` precedent: 180 s). Crawl breadth defaults are scope
  // bounds against runaway credit spend (verified 2026-07-15: 1 credit/page, and the API's
  // own `limit` default is 10 000 pages = 10 000 credits on a blind crawl).
  firecrawl: {
    scrapeTimeoutMs: 120_000, // single page, JS rendering included
    mapTimeoutMs: 60_000,
    mapDefaultLimit: 500, // URL-list discovery; bounded because map is billed per page listed
    requestTimeoutMs: 30_000, // each submit/poll/pagination call inside an async job
    cancelTimeoutMs: 10_000, // best-effort remote cancel of a dead crawl job
    jobPollIntervalMs: 3000, // crawl + extract; no documented recommended interval
    crawlJobBudgetMs: 600_000, // overall async-job budget: submit → poll → collect
    crawlDefaultMaxPages: 100,
    crawlDefaultMaxDepth: 3,
    extractJobBudgetMs: 300_000,
  },
  // M5 images: generation runs in the background off the voice turn (the tool acks
  // instantly), so the budget is generous like other background calls. Quality is left
  // to the API default deliberately — fewer knobs on a voice tool.
  images: {
    timeoutMs: 180_000,
    // The voice model picks a shape; sizes verified against the live API (÷16 rule).
    sizes: { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' } as Record<string, string>,
  },
  // M5 scheduler: Gumbo's own timed-action primitive (kind 'reminder' for now). The poll
  // loop is the spoken-presence half; EventKit is the OS-durable half (fires even if the
  // daemon is off or the Mac is asleep — the poll loop just fires late, on wake).
  schedule: {
    pollIntervalMs: 20_000,
  },
  // How long a finished task's bubble lingers before the daemon sends bubble_remove.
  bubbleLingerMs: 12_000,
  // Report excerpt embedded in a live completion announcement — enough for the model to
  // deliver the key finding without reciting the whole file (full cap: reportMaxChars).
  announceReportMaxChars: 2_500,
  reportMaxChars: 12_000,
  activityLogMaxChars: 500, // truncation for tool args / outputs in the activity log
};
