import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

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

// The person Gumbo talks to. Optional — when unset, the voice persona never addresses
// anyone by name (see realtime/session.ts); it's never guessed or hardcoded.
const userName = process.env.USER_NAME?.trim() || '';

// Organized agent home — never a flat dumping ground. Only `served` subtrees are
// reachable over /files; `db` and future private state stay off the wire.
export const home = {
  root: agentHome,
  tasks: join(agentHome, 'tasks'), // per-task workspaces + report.md
  images: join(agentHome, 'images'), // generated images (M5)
  notes: join(agentHome, 'notes'), // agent-curated notes / knowledge (self-organization)
  db: join(agentHome, 'db'), // sqlite — deliberately outside the /files-served subtree
  logs: join(agentHome, 'logs'), // append-only JSONL audit trails — private, never served
  // M7 automation-browser state: the persistent Chrome profile (live session cookies on
  // disk!) + the remembered host allowlist. Secret-class — never /files-served, and
  // read-denied to sandboxed Claude sessions (claude-runner readDenied) + the mac_do
  // secret-store gate.
  browser: join(agentHome, 'browser'),
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
export const secretEnvKeys = ['OPENAI_API_KEY', 'EXA_API_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY', 'XAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;

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

// The privileged 'shell' WS role authenticates with this token. Loopback bind + the WS
// Origin allowlist block browser drive-by, but NOT a native (no-Origin) local process
// claiming role:shell — which could approve notch confirms, forge Mac results, or drive
// privileged flows. The token is a high-entropy secret in a 0600 file both the daemon and
// the shell (same user, same machine) can read; a process that can't read it can't take
// the shell role. Persisted so the shell's re-read on reconnect stays valid across daemon
// restarts. Called once at boot by index.ts (never at import — keeps config side-effect-free
// for the test/sandbox lanes).
export function loadDaemonToken(): string {
  const tokenPath = join(agentHome, 'daemon.token');
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // missing / unreadable → mint a fresh one below
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

// Home-relative credential stores every read-gate shares: the Seatbelt read-deny
// (claude-runner), the mac_do/run_script confirm gate (mac/policy), and file presentation
// (files/present) all derive from THIS list, so a store added here is covered everywhere
// at once. Paths are relative to the user's home.
export const secretStoreNames = [
  '.ssh', '.aws', '.npmrc', '.netrc', '.gnupg', '.kube',
  '.docker/config.json', '.config/gh', '.config/gcloud',
] as const;

export const config = {
  port,
  host: '127.0.0.1', // loopback only — do not bind all interfaces
  allowedOrigins: [`http://localhost:${dashboardPort}`, `http://127.0.0.1:${dashboardPort}`],
  agentHome,
  userName,
  home,
  dbPath: join(home.db, 'gumbo.db'),
  models: {
    realtime: 'gpt-realtime-2.1',
    subagent: 'gpt-5.6-terra',
    supervisor: 'gpt-5.6-terra',
    // Hard per-request ceiling for Agents-SDK model calls (the SDK default is ~10 min —
    // a stalled call read as a silent hang on a live fallback run). Generous enough for
    // long reasoning turns; the client retries what the timeout exposes.
    requestTimeoutMs: 120_000,
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
  // Local (daemon-side) speech-energy gate on the armed mic stream (2026-07-16). Two jobs:
  // 1. INSTANT barge-in. The SDK clears its interrupt tracking the moment audio GENERATION
  //    completes (response.output_audio.done → #resetAudioPlaybackState), but the shell
  //    drains the buffered audio for far longer — during that window the server-VAD
  //    barge-in path (speech_started → interrupt()) is a silent no-op, measured live as
  //    seconds of talking over Gumbo. The daemon detects speech energy on the armed mic
  //    frames itself and flushes shell playback immediately; it also covers cold TTS
  //    announcements, which have no session to interrupt at all.
  // 2. Silence gate. A PTT window with no speech-like energy is cleared, never committed —
  //    a silent ⌃⌥ hold used to commit an empty buffer and the model answered it with a
  //    generic "what can I do for you?" (live bug, seen twice).
  // Frames are post-AEC (the shell taps VPIO-processed input), so Gumbo's own speaker
  // output does not read as speech. RMS is over pcm16 (±32767): AGC'd speech lands around
  // 2000–4000; AEC residue and room noise sit well under 500.
  localVad: {
    rmsThreshold: 900,
    minSpeechMs: 90, // sustained AND consecutive — debounces keyboard clicks and breaths
  },
  // Session continuity (2026-07-16): sessions are short-lived by design (idle close above,
  // tsx-watch daemon restarts), but the CONVERSATION must not reset with them — a fresh
  // session's instructions carry the recent dialogue + active-task snapshot, rebuilt from
  // the event log at connect. Lookback bounds how far back the replay reaches; maxChars
  // bounds the instruction-size cost (oldest lines drop first).
  continuity: {
    lookbackMs: 45 * 60_000,
    maxChars: 4000,
  },
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
  // M6 computer use: budgets for the daemon⇄shell mac_action RPC and both script lanes.
  // Every lane has a hard timeout — Tahoe regressed Apple-Events timing (scripts hang to
  // the 2-min -1712 timeout on some apps), so nothing here waits on the OS's patience.
  mac: {
    rpcTimeoutMs: 15_000, // per mac_action (snapshot/act/health) — settle+diff finishes well under this
    hotScriptTimeoutMs: 10_000, // mac_do: a voice turn is waiting — fail fast, never stack
    scriptTimeoutMs: 60_000, // sub-agent run_script (osascript/shortcuts get more room than the hot path)
    confirmTimeoutMs: 30_000, // hot mac_do notch confirm — shorter than Claude's 60 s (a voice turn is waiting)
    snapshotMaxElements: 400, // interactive elements per compacted snapshot the model sees
    maxTurns: 100, // computer-mode sub-agent step budget (SPEC §M6); exhaustion ends as an honest partial report, never a crash
    outputMaxChars: 262_144, // defensive cap on any single shell result payload
    // M7 vision lane: one-shot ScreenCaptureKit capture (+ Vision OCR) budgets. The
    // first capture triggers the Screen Recording TCC prompt, which can sit for a while —
    // the RPC margin on top of this covers the round trip, and a denial comes back as
    // typed capture_denied, never a hang.
    captureTimeoutMs: 10_000,
    // screen_look's nested vision-model query (capture → ask → text answer). Screenshots
    // deliberately NEVER enter the loop context — this bounds the one-shot ask instead.
    visionTimeoutMs: 60_000,
    // M7 cooperative handoff: the user performs one step themselves (login, permission dialog,
    // captcha) and taps Done. Generous like planConfirmTimeoutMs — a login takes minutes,
    // not seconds. Deny-on-timeout stays: an unanswered handoff wraps the task up cleanly.
    handoffTimeoutMs: 300_000,
  },
  // M8 watch-me teaching: the shell's kill-switch tap flips to RECORD mode and streams
  // the user's demonstration back as semantic steps (role/label/identifier — never
  // coordinates, never secure-field content). Caps are LOUD stops, never silent
  // truncation (Law 5): hitting one ends the recording with the reason announced.
  teach: {
    maxSteps: 400, // a demonstration is dozens of steps; hundreds means a forgotten recorder
    maxDurationMs: 10 * 60_000, // auto-stop — a demo is minutes, not hours
    valueMaxChars: 400, // per-step typed-text cap (sanitize)
  },
  // M8 procedure memory: the one-shot compile (recording/trace → replayable procedure)
  // and its trace-condensation budget. Background work — generous like other one-shots.
  research: {
    // Deep mode is a different SHAPE, not just a bigger budget: search results come back
    // as a skim (no page bodies in the loop) and reads go through the note extractor, so
    // the orchestrating context holds evidence, never raw pages — that is what makes
    // reading 100+ sources reachable (full-text searches saturate a loop in ~4 turns).
    standardMaxTurns: 25,
    deepMaxTurns: 60,
    readBatchMax: 8, // pages per read_and_extract call (schema allows more; extras are named, never silently dropped)
    extractInputMaxChars: 60_000, // per-page window fed to the extractor; the note states when a page exceeded it
  },
  procedures: {
    compileTimeoutMs: 60_000,
    traceMaxChars: 24_000, // condensed tool.call/tool.result stream fed to the compiler
    // "Save that as a procedure" binds to the newest finished computer task — but only a
    // RECENT one without an explicit confirm (a stale match means "that" pointed at
    // something that never became a task, e.g. a spoken lookup).
    saveLastRunMaxAgeMs: 15 * 60_000,
    // Replay precondition resilience: if a step's target app isn't running (it was open
    // when taught, or a prior run left it closed), the engine launches it — a closed app
    // must never drift a faithful replay. Poll for readiness after the launch (a cold
    // app takes a beat) before giving up to the intelligent fallback.
    appLaunchAttempts: 4,
    appLaunchWaitMs: 1000,
    // Demo-measured replay pacing (2026-07-21 forensics): the pause before a resolve/act
    // retry, and the settle after re-pressing a revealer button re-opens its container.
    retrySleepMs: 800,
    revealerSettleMs: 600,
  },
  // M8 scheduled routines. The unattended policy is non-negotiable: a would-be-confirm
  // PAUSES the run (needs_input + pulse + parked notch confirm) until the user answers —
  // deny-on-timeout stays at pause scale, and NOTHING is ever auto-approved in absentia.
  routines: {
    pauseTimeoutMs: 60 * 60_000, // parked-confirm window before the standing deny fires
    queueWindowMs: 30 * 60_000, // a routine firing into a busy Mac retries this long, then skips LOUDLY
    retryIntervalMs: 60_000,
  },
  // M7 browser lane: Playwright/CDP on a DEDICATED PERSISTENT automation profile
  // (~/Gumbo/browser/profile) — never the user's live Chrome (locked decision: anti-bot
  // flags CDP sessions; a burned live profile is unacceptable blast radius). The profile
  // persists across tasks (2026-07-20): logins stick as the user types them, and extensions
  // they install once (uBlock) ride along — Chrome's password manager is disabled at
  // profile creation, so "no stored passwords, ever" holds. The browser is HEADED so
  // the user can watch and, in a handoff, act. Runs entirely in-daemon (no TCC involved),
  // so unlike the AX lane there is no shell RPC underneath.
  browser: {
    navTimeoutMs: 30_000, // page.goto budget — background lane, generous but bounded
    actTimeoutMs: 10_000, // per-element action (click/fill/…) incl. Playwright actionability wait
    settleTimeoutMs: 2_500, // post-action settle: poll until the tree stops changing
    settlePollMs: 150, // matches the AX executor's debounced-signature cadence
    snapshotMaxChars: 24_000, // aria snapshot cap the model sees (big pages truncate with a note)
    diffMaxLines: 80, // before/after diff cap — past this, advise a fresh snapshot
    // Base host allowlist (user-configured, like sandbox.allowedDomains). Bare domains
    // match subdomains. Remembered approvals persist in ~/Gumbo/browser/hosts.json —
    // unknown hosts escalate to a notch confirm (M4.1 egress posture), never a silent 403.
    allowedHosts: [] as string[],
  },
  // Grok (xAI) = live X/real-time-social lookups Exa/Tavily barely see inside X. Same
  // provider contract as the others (shared client, typed SearchError, one audit line,
  // keys in .env/daemon-only), routed by tool description: hot-path `x_lookup` (voice,
  // spoken) + background `x_search` (sub-agent, persisted). Uses the Agent Tools API
  // (POST /v1/responses + server-side web_search/x_search) — the old declarative Live
  // Search is decommissioned (HTTP 410). Sources are X + web (catch an announcement whether
  // it's a post OR a blog) but the tool wording is X-first so it never poaches Tavily's
  // general-facts lane.
  //
  // TIERED MODELS (measured live 2026-07-16): grok-4.5 is a REASONING model — its agentic
  // X search ran 28–45 s on the hot path (non-viable for voice; max_tool_calls doesn't bound
  // the reasoning between calls). So the voice hot path uses grok-4.20-NON-reasoning (~2–8 s
  // live — it skips the inner deliberation), while background research keeps grok-4.5 for
  // depth (30–45 s is fine off the voice turn). The hot-path timeout is the real guard: on
  // the rare slow query it fails to lookup_failed while the session speaks a filler.
  grok: {
    hotModel: 'grok-4.20-non-reasoning', // voice: fast, non-reasoning (live-verified: 2–11 s, typ ~2–8 s)
    backgroundModel: 'grok-4.5', // background: the user's pick, deeper reasoning (live-verified)
    // Headroom over the observed ~11 s tail so an occasional slow query succeeds instead of
    // spuriously timing out; the session speaks a filler, and a real timeout still degrades to
    // lookup_failed (offer to background it). Most lookups return in 2–8 s.
    quickLookupTimeoutMs: 15_000,
    backgroundTimeoutMs: 120_000,
    sources: ['x', 'web'] as ('x' | 'web')[],
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
    // Per-call budget for the supervisor model answering a Claude question. Must sit
    // comfortably BELOW hookTimeoutMs so a hung gpt-5.6-terra degrades to the safe default
    // (and releases nothing it shouldn't) before the CLI force-kills the whole hook.
    supervisorTimeoutMs: 90_000,
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
    // read-denied. Network is DEFAULT-DENY: the profile allows only loopback to an in-daemon
    // egress filtering proxy (egress-proxy.ts) that the CLI reaches via HTTPS_PROXY. Known
    // hosts (Anthropic + MCP + common dev/registry hosts) flow freely; an UNKNOWN host is
    // escalated to a notch confirm (deny-on-timeout) — closing the GET-exfil channel the open
    // posture left open. See IMPLEMENTATION_NOTES §M4.1 for the full rationale.
    sandbox: {
      enabled: true,
      // Fail closed: if Seatbelt is unavailable (non-macOS, or sandbox-exec missing), the
      // session refuses to run rather than silently running unconfined.
      failIfUnavailable: true,
      // Extra egress hosts the user wants flowing freely without a per-host confirm (in addition
      // to the built-in allowlist in claude-runner). Bare domains match subdomains too.
      allowedDomains: [] as string[],
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
    // Per-TASK cumulative page/URL budget across all map/crawl calls. Each Firecrawl page
    // is a billed credit, so a prompt-injected research agent looping expensive crawls is a
    // real cost. Generous for a genuine research task (a few crawls + maps), but a hard cap:
    // beyond it, acquisition is clamped or refused loudly (never silently). One task's spend
    // can't run away.
    taskPageBudget: 2000,
  },
  // M5 images: generation runs in the background off the voice turn (the tool acks
  // instantly), so the budget is generous like other background calls.
  images: {
    // Was 180 s — quality:high renders run long, and a timeout mid-render reads to
    // the user as a failed request. 300 s stays a hard bound (the failure IS spoken).
    timeoutMs: 300_000,
    // The voice model picks a shape; sizes verified against the live API (÷16 rule).
    sizes: { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' } as Record<string, string>,
    // Highest-fidelity default (the user, 2026-07-16 — their "highest quality" ask was
    // silently droppable when quality wasn't a knob). Probed live: quality takes
    // low|medium|high|auto on both generations and edits; no reasoning-class param
    // exists on this endpoint, and gpt-image-2 REJECTS gpt-image-1's input_fidelity
    // (live 400). The generate_image tool can still lower quality per request.
    quality: 'high' as 'low' | 'medium' | 'high' | 'auto',
  },
  // M5 scheduler: Gumbo's own timed-action primitive (kind 'reminder' for now). The poll
  // loop is the spoken-presence half; EventKit is the OS-durable half (fires even if the
  // daemon is off or the Mac is asleep — the poll loop just fires late, on wake).
  schedule: {
    pollIntervalMs: 20_000,
  },
  // How long a finished task's bubble lingers before the daemon sends bubble_remove.
  bubbleLingerMs: 12_000,
  // Report excerpt embedded in a live completion announcement. Was 2 500 — which sliced a
  // 14 k report mid-example and the model read right up to the cut edge, heard as "the
  // report cut off out of nowhere" (live failure 2026-07-16). Now matches reportMaxChars,
  // and session.ts cuts at a paragraph boundary + flags the truncation to the model.
  announceReportMaxChars: 12_000,
  reportMaxChars: 12_000,
  activityLogMaxChars: 500, // truncation for tool args / outputs in the activity log
};
