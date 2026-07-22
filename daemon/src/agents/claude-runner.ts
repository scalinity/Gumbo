import { query, type Query, type SDKUserMessage, type HookJSONOutput, type SpawnOptions, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { config, secretEnvKeys, secretFilePaths, secretStoreNames } from '../config.ts';
import { startEgressProxy, type EgressProxy } from './egress-proxy.ts';
import type { Store } from '../events/store.ts';
import type { Supervisor, GateResult } from './supervisor.ts';
import { recordUsage } from '../usage/recorder.ts';
import { priceClaudeEquivalent } from '../usage/pricing.ts';

// The usage slice of the SDK's result message (sdk.d.ts: modelUsage entries carry
// inputTokens/outputTokens/cacheReadInputTokens/cacheCreationInputTokens/costUSD;
// total_cost_usd + snake_case usage ride alongside). Fields optional-guarded — the
// runner must survive an SDK that stops reporting them.
export interface ResultUsageMessage {
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
  }>;
}

export interface ClaudeUsageTotals { in: number; out: number; read: number; write: number; cost: number }

/** Cumulative→delta conversion for one result message — result messages within one query()
 *  report CUMULATIVE session usage, so each result must record only the not-yet-recorded
 *  remainder. Advances `recorded` to the new cumulative totals as it goes. Prefers the
 *  per-model modelUsage map (top-level `usage` EXCLUDES subagent tokens); falls back to a
 *  single synthetic 'claude' entry from the snake_case usage. Exported for unit tests. */
export function claudeUsageDeltas(
  msg: ResultUsageMessage,
  recorded: Map<string, ClaudeUsageTotals>,
): Array<{ model: string; delta: ClaudeUsageTotals }> {
  const models = msg.modelUsage && Object.keys(msg.modelUsage).length > 0
    ? Object.entries(msg.modelUsage)
    : msg.usage
      ? ([['claude', {
          inputTokens: msg.usage.input_tokens ?? 0,
          outputTokens: msg.usage.output_tokens ?? 0,
          cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
          costUSD: msg.total_cost_usd ?? 0,
        }]] as const)
      : [];
  const deltas: Array<{ model: string; delta: ClaudeUsageTotals }> = [];
  for (const [model, u] of models) {
    if (!u || typeof u !== 'object') continue; // a null entry value must never throw here
    const prev = recorded.get(model) ?? { in: 0, out: 0, read: 0, write: 0, cost: 0 };
    const delta = {
      in: Math.max(0, (u.inputTokens ?? 0) - prev.in),
      out: Math.max(0, (u.outputTokens ?? 0) - prev.out),
      read: Math.max(0, (u.cacheReadInputTokens ?? 0) - prev.read),
      write: Math.max(0, (u.cacheCreationInputTokens ?? 0) - prev.write),
      cost: Math.max(0, (u.costUSD ?? 0) - prev.cost),
    };
    recorded.set(model, {
      in: prev.in + delta.in, out: prev.out + delta.out, read: prev.read + delta.read,
      write: prev.write + delta.write, cost: prev.cost + delta.cost,
    });
    deltas.push({ model, delta });
  }
  return deltas;
}

// Auth-failure markers: a not-logged-in / expired-subscription session comes back either
// as an assistant error field or as result text carrying these strings (verified during
// the risk-#2 spike, where a bad env produced a 'success' result whose text was the login
// error). Turned into a clear, actionable failure instead of a cryptic SDK error.
const AUTH_MARKER = /not logged in|please run\s*\/login|authentication_failed|oauth[^.]*\b(expired|invalid|revoked)\b/i;
export const CLAUDE_AUTH_ERROR = 'auth: Claude Code needs you to log in again — run `claude` in a terminal, then `/login`.';

// Result subtypes that mean "ran out of room," not "failed": the work is on disk and the
// session resumes with send_to_session, so the task parks for the user rather than failing.
const RESUMABLE_LIMIT_SUBTYPES = new Set(['error_max_turns', 'error_max_budget_usd']);

// Where the CLI persists its plan BEFORE calling ExitPlanMode (whose input is empty on
// current CLIs) — the runner captures the Write content as the plan-approval fallback.
const PLAN_DIR = join(homedir(), '.claude', 'plans');

// Prompt text recorded to the activity feed (claude.prompt) — larger than
// activityLogMaxChars because the brief IS the context the user may need to re-read.
const PROMPT_LOG_MAX_CHARS = 4000;

export const CLAUDE_SANDBOX_ERROR = "this Mac can't run the OS sandbox (Seatbelt unavailable), so the session refused to start rather than run unconfined.";

export const CLAUDE_PROXY_ERROR = "couldn't start the egress filtering proxy, so the session refused to start rather than run with unfiltered network.";

// M4.1 egress allowlist (flows freely, no per-host confirm). Generous by design — a headless
// session should research/install/git like an interactive one — so anything NOT here escalates
// to a notch confirm rather than a hard 403 (the user: "safety net, not a cage"). The MCP hosts
// wired in config are DERIVED at runtime (egressAllowlist) so a changed MCP URL stays in sync;
// this base covers Anthropic, the inherited ~/.claude MCPs, and common dev/registry hosts.
const EGRESS_BASE_ALLOWLIST = [
  'anthropic.com', // the CLI's control plane + subscription login
  'claude.ai',
  'mcp.exa.ai', // inherited ~/.claude MCP (exa) — not in config, so hardcoded
  'exa.ai',
  'github.com', // clone/push/gh, raw content, release assets
  'githubusercontent.com',
  'ghcr.io',
  'registry.npmjs.org', // npm
  'npmjs.org',
  'pypi.org', // pip
  'files.pythonhosted.org',
  'crates.io', // cargo
  'static.crates.io',
];

/** The full flow-freely allowlist: base + the hosts of the session's configured MCP servers
 *  (derived so a changed URL can't drift) + the user's config extras. */
function egressAllowlist(): string[] {
  const mcpHosts = Object.values(config.claude.mcpServers)
    .map((s) => {
      try {
        return new URL((s as { url?: string }).url ?? '').hostname;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  return [...EGRESS_BASE_ALLOWLIST, ...mcpHosts, ...config.claude.sandbox.allowedDomains];
}

// M4.1 (rebuilt 2026-07-16 — the review-follow-up discovery): the SDK's `sandbox` option
// only jails spawned BASH; the CLI's OWN file tools (Read/Write/Edit/Grep) run in the CLI's
// Node process and escape it. The only way to OS-confine the file tools too is to run the
// WHOLE CLI process under macOS Seatbelt — which we do by wrapping the spawn in
// `sandbox-exec` via the SDK's `spawnClaudeCodeProcess` seam. macOS forbids NESTING a second
// sandbox inside the first (sandbox_apply → EPERM), so this REPLACES the SDK `sandbox` option
// rather than layering under it. This is the same approach Anthropic's own
// `@anthropic-ai/sandbox-runtime` takes; we hand-roll the profile to avoid a beta dependency.

/** Absolute, symlink-resolved dir if it exists (Seatbelt matches real paths — /tmp is
 *  /private/tmp); otherwise the literal path (a not-yet-created dir the CLI may make). */
function realOrLiteral(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

/** Null when the OS sandbox is available; otherwise a human reason (→ fail-closed). */
export function sandboxUnavailableReason(): string | null {
  if (process.platform !== 'darwin') return `OS sandbox requires macOS Seatbelt; platform is ${process.platform}`;
  if (!existsSync('/usr/bin/sandbox-exec')) return 'sandbox-exec not found at /usr/bin/sandbox-exec';
  return null;
}

/**
 * Build the SBPL (Seatbelt) profile that confines the ENTIRE CLI process — file tools and
 * bash alike. The design goal (the user, 2026-07-16) is a SAFETY NET, not a capability cage:
 * the headless session should run like an interactive one (any CLI, MCP, package install,
 * research) but be unable to escape its task. So `allow default` keeps the CLI fully
 * functional (network, Keychain, node, reading libs/docs anywhere) and we SUBTRACT only the
 * two things that matter for a headless, prompt-injectable session:
 *   1. WRITES — confined to the project cwd + the task workspace + the runtime/cache dirs
 *      tools legitimately need (~/.claude for checkpoints, $TMPDIR, package caches). Writes to
 *      the user's documents, other projects, dotfiles, and system stay denied — the session
 *      can't clobber anything outside its task.
 *   2. SECRET READS — .env (repo provider keys), ~/.ssh, ~/.aws are unreadable, so there is
 *      little sensitive material to exfiltrate even though egress is open.
 * Exported for unit tests. `cwd` should already be realpath'd by the caller (the manager is).
 *
 * Network is DEFAULT-DENY: every direct socket is denied and ONLY loopback to the in-daemon
 * egress filtering proxy (on `proxyPort`) is re-allowed. The CLI reaches it via HTTPS_PROXY, so
 * the CLI *and* any bash it spawns are forced through the proxy, where known hosts flow freely
 * and unknown ones escalate to a notch confirm (egress-proxy.ts). This closes the GET-exfil
 * channel the old open posture left open — a readable secret can't be shipped to an attacker
 * host, because that host isn't allowlisted and the confirm denies on timeout. The supervisor
 * policy's network-SEND escalation stays as the semantic layer for approved-host sends (git push).
 */
export function buildSandboxProfile(cwd: string, taskId: string, proxyPort: number): string {
  // An empty cwd/taskId would emit `(allow file-write* (subpath ""))` — an empty prefix that
  // matches every path and silently defeats the deny-all. The manager always passes a non-empty
  // `dir || workspace`, but pin the precondition here so the safety property is local (review 🔵).
  if (!cwd || !taskId) throw new Error('buildSandboxProfile: cwd and taskId must be non-empty');
  // A zero/NaN port would emit `(allow network-outbound (remote ip "localhost:0"))` — matching
  // nothing, so the CLI couldn't reach the proxy and every request would fail. Pin it too.
  if (!Number.isInteger(proxyPort) || proxyPort <= 0) throw new Error('buildSandboxProfile: proxyPort must be a positive integer');
  const home = homedir();
  const claudeDir = realOrLiteral(join(home, '.claude'));
  const q = (p: string) => JSON.stringify(p); // SBPL uses double-quoted strings; JSON escaping is compatible
  const writable = [
    realOrLiteral(cwd),
    realOrLiteral(join(config.home.tasks, taskId)),
    claudeDir, // session state + file-checkpoint backups (undo)
    realOrLiteral(tmpdir()),
    '/private/tmp',
    '/private/var/folders',
    '/dev',
    // Package-manager + tool caches, so `npm/pip install` and caching CLIs work like they do
    // interactively (verified: without these, ~/.npm etc. EPERM and installs fail).
    realOrLiteral(join(home, '.npm')),
    realOrLiteral(join(home, '.cache')),
    realOrLiteral(join(home, 'Library', 'Caches')),
  ];
  // Re-deny the code-execution / persistence surfaces UNDER the (writable) ~/.claude, placed
  // AFTER the allow so SBPL last-match-wins takes them (verified: deny-after-allow works). A
  // bash-written hook/settings/plugin/skill here would run UNSANDBOXED in the user's next
  // interactive session — arbitrary code + durable escape (review 🔴). The supervisor policy
  // screens both the file tools AND bash strings on ~/.claude; this OS deny is the backstop
  // for what a string screen can't see. The old
  // `~/.claude.json` write-allow is dropped for the same reason (MCP/trust-injection surface).
  const claudeExecSurfaces = ['settings.json', 'settings.local.json', 'CLAUDE.md', 'plugins', 'agents', 'skills', 'commands', 'hooks'].map((name) =>
    join(claudeDir, name),
  );
  // Deny reading the on-disk secret stores a coding session never needs — the env-strip covers
  // the environment, but these are FILES a bash `cat` + the open network could exfiltrate as
  // live bearer tokens (review 🔴). .env is secretFilePaths[0]; the rest are what a real dev
  // machine has. ~/.claude is NOT denied (the CLI needs its own state) — the residual
  // Keychain/transcript reads under open network are documented (only the network-deny proxy
  // fully closes them).
  const readDenied = [
    realOrLiteral(secretFilePaths[0]), // repo .env (provider keys)
    realOrLiteral(config.home.browser), // M7 persistent automation profile = live session cookies on disk
    realOrLiteral(config.home.logs), // M7: audit trails carry full page URLs (possible query-string tokens)
    // The home credential stores — one shared list (config.secretStoreNames) also drives
    // the mac_do/run_script confirm gate and file presentation, so the sets can't drift.
    ...secretStoreNames.map((name) => realOrLiteral(join(home, name))),
  ];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    ...writable.map((p) => `(allow file-write* (subpath ${q(p)}))`),
    ...claudeExecSurfaces.map((p) => `(deny file-write* (subpath ${q(p)}))`), // after the allows — last-match-wins
    ...readDenied.map((p) => `(deny file-read* (subpath ${q(p)}))`),
    // Network default-deny, then re-allow ONLY loopback to the egress proxy (last-match-wins,
    // so these override `(allow default)`). The confined process only connects to
    // 127.0.0.1:<proxyPort> (a numeric literal — Node skips getaddrinfo for it) and sends
    // hostname CONNECTs the proxy resolves upstream, so it needs no local name resolution.
    '(deny network*)',
    `(allow network-outbound (remote ip "localhost:${proxyPort}"))`,
    // No network-bind allow: `(deny network*)` denies inbound anyway (a bound server couldn't
    // accept), and outbound is locked to the proxy port (a sandboxed client couldn't reach a
    // sandboxed server), so a bind rule would grant the headless session nothing usable — the
    // profile states only what it actually allows (review 🔵).
    // review 🔴: `(deny network*)` only blocks the process's OWN sockets. getaddrinfo/dns.lookup
    // resolve via mDNSResponder — a separate daemon reached over mach IPC that `(allow default)`
    // still permits — so DNS queries bypass the proxy entirely (verified: a DNS-label exfil of the
    // Keychain token worked before this deny). Deny the resolver's mach ports so ALL name
    // resolution is forced through the proxy. The blanket unix-socket egress allow is also dropped
    // (it exposed local network bridges like /var/run/docker.sock); verified the CLI still
    // auths/infers/MCPs through the proxy without it.
    '(deny mach-lookup (global-name "com.apple.mDNSResponder"))',
    '(deny mach-lookup (global-name "com.apple.mDNSResponder.dnsproxy"))',
    '', // trailing newline
  ].join('\n');
}

/** `spawnClaudeCodeProcess` implementation: launch the CLI under `sandbox-exec -p <profile>`
 *  so the whole process — file tools included — runs inside Seatbelt. A missing sandbox-exec
 *  would make spawn emit 'error', which the SDK surfaces as a failed session — fail-closed. */
function sandboxWrappedSpawn(profile: string): (opts: SpawnOptions) => SpawnedProcess {
  return (opts) =>
    spawn('/usr/bin/sandbox-exec', ['-p', profile, opts.command, ...opts.args], {
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      // stderr → 'inherit' (the daemon's stderr): the SDK only drains stderr on its OWN spawn
      // path, so a 'pipe' here would fill and backpressure-deadlock the session on a chatty CLI
      // (review 🟡). stdin/stdout stay piped — that's the SDK's JSON-over-stdio IPC channel.
      stdio: ['pipe', 'pipe', 'inherit'],
    }) as unknown as SpawnedProcess;
}

// Least privilege: hand the Claude subprocess the environment it needs (HOME/PATH/USER for
// the keychain login lookup, TMPDIR, locale, …) MINUS every daemon-held provider secret —
// the session needs none of them, and 'auto' mode auto-runs safe bash that could read them.
// Beyond the named provider keys, any variable whose NAME looks credential-shaped is
// stripped too (scan MEDIUM: a GH_TOKEN/AWS_SECRET_ACCESS_KEY inherited from the daemon's
// launch environment would survive a fixed denylist and be one `printenv` away from the
// transcript). The CLI's own needs (HOME, PATH, USER, proxy vars) never match this shape.
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSW|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|_AUTH\b|^AUTH_|^DATABASE_URL$/i;

/** Exported for offline unit tests. */
export function subprocessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of secretEnvKeys) delete env[key];
  for (const key of Object.keys(env)) {
    if (SECRET_ENV_NAME.test(key)) delete env[key];
  }
  return env;
}

// M4: one Claude Code session per task, on subscription auth (spike-verified 2026-07-15):
// the subprocess env must keep USER (keychain credential lookup resolves the login item by
// account name) and must NOT carry ANTHROPIC_API_KEY (it silently outranks the claude.ai
// login). Streaming input keeps the session open for supervisor answers and the user's
// mid-run redirects; the session id is persisted so send_to_session can resume after a
// daemon restart.

/** Push queue → async-generator streaming input for query(). Exported for unit tests. */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  /** Returns false once closed — callers fall back to the resume path. */
  push(text: string): boolean {
    if (this.closed) return false;
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.wake?.();
    return true;
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

// Claude runs headless — nobody watches its terminal — so the prompt must route questions
// through AskUserQuestion (the supervisor answers) instead of dangling them at run end,
// and the final message doubles as the spoken report.
function composePrompt(brief: string, cwd: string, planFirst: boolean): string {
  const planLine = planFirst
    ? `\nBefore changing anything, investigate read-only and present a concise plan via ExitPlanMode; the user reviews and approves it before you build. Once approved, execute the plan.`
    : '';
  return `You are working autonomously for Gumbo, the user's personal Mac agent. Nobody is watching a
terminal. Your working directory is ${cwd}.${planLine} If you genuinely need a decision you cannot
make from the brief, use the AskUserQuestion tool — a supervisor answers on the user's behalf; never
end your run with an unanswered question. When the work is done, end with a concise report of what
you did, what you verified, and where the changes live — it is saved verbatim as the task's report
and its key points are read aloud to the user.

Task: ${brief}`;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[]).map((p) => p.text ?? '').join('');
  }
  return '';
}

export interface ClaudeRunResult {
  /** True when the run stopped for the user (cap, unapproved plan, or a turn/budget limit)
   *  rather than finishing — the session stays resumable via send_to_session. */
  parked: boolean;
  /** Why it parked, for the needs_input status/announcement (undefined when not parked). */
  parkedReason?: string;
  report: string;
}

/** The surface TaskManager drives — lets tests inject a fake in place of a live query(). */
export interface ClaudeSessionRunner {
  readonly abort: AbortController;
  run(): Promise<ClaudeRunResult>;
  send(text: string): boolean;
  /** Rewind the session's file edits to its pre-run state (file checkpointing). */
  undo(): Promise<string>;
}

export interface ClaudeRunnerOpts {
  taskId: string;
  brief: string;
  /** Accumulated brief (original + follow-ups) persisted for the NEXT resume — on a
   *  resumed run `brief` is only the follow-up text and must not clobber the history. */
  persistBrief: string;
  cwd: string;
  store: Store;
  supervisor: Supervisor;
  /** Resume an earlier session (daemon restarted, or a follow-up on a finished task). */
  resumeSessionId?: string;
  /** Fresh sessions plan-then-execute; a resume is a direct instruction and skips planning. */
  planFirst?: boolean;
  /** Surface Claude's plan to the user and resolve their approval (false → don't execute). */
  onPlanReady?: (plan: string) => Promise<boolean>;
}

export class ClaudeRunner implements ClaudeSessionRunner {
  readonly abort = new AbortController();
  private input = new InputQueue();
  private opts: ClaudeRunnerOpts;
  // One result message arrives per user turn; the run is over only when every queued
  // turn has resolved — otherwise a mid-run send_to_session would be silently dropped.
  private turnsSent = 0;
  private turnsResolved = 0;
  private query: Query | null = null; // live handle for setPermissionMode / rewindFiles
  private firstUserMessageId: string | null = null; // rewind target for undo() (checkpointing)
  private planRejected = false; // the user declined the plan → park, don't fail
  private authFailed = false; // an assistant message reported an auth error
  // Per-model totals already recorded for this session run — result messages within one
  // query() report CUMULATIVE session usage, so each result records only the delta.
  private recordedModelUsage = new Map<string, { in: number; out: number; read: number; write: number; cost: number }>();
  private planFileContent: string | null = null; // last Write into ~/.claude/plans (see PLAN_DIR)

  // No parameter properties: daemon tests run node --test in strip-only mode.
  constructor(opts: ClaudeRunnerOpts) {
    this.opts = opts;
  }

  /** Queue a follow-up user turn; false once the session ended (caller resumes instead). */
  send(text: string): boolean {
    if (!this.input.push(text)) return false;
    this.turnsSent += 1;
    // The user's follow-ups belong in the activity feed too — without them the transcript
    // shows Claude reacting to instructions nobody can see.
    this.opts.store.addEvent(this.opts.taskId, 'claude.prompt', { text: text.slice(0, PROMPT_LOG_MAX_CHARS) });
    return true;
  }

  private get planning(): boolean {
    return this.opts.planFirst === true && !this.opts.resumeSessionId;
  }

  async run(): Promise<ClaudeRunResult> {
    const { taskId, brief, cwd, store, supervisor } = this.opts;
    const limit = config.activityLogMaxChars;

    // M4.1: wrap the whole CLI process in a Seatbelt sandbox (file tools included) and route
    // all its egress through the loopback filtering proxy. Fail closed BEFORE spawning — if the
    // platform can't sandbox, or the proxy won't bind, the session refuses to run (unconfined /
    // unfiltered) rather than silently dropping containment.
    let spawnClaudeCodeProcess: ((opts: SpawnOptions) => SpawnedProcess) | undefined;
    let proxy: EgressProxy | undefined;
    let proxyEnv: Record<string, string> = {};
    if (config.claude.sandbox.enabled) {
      const reason = sandboxUnavailableReason();
      if (reason) {
        if (config.claude.sandbox.failIfUnavailable) throw new Error(`${CLAUDE_SANDBOX_ERROR} (${reason})`);
        // failIfUnavailable off → the SDK spawns the CLI UNCONFINED. Inert with shipped
        // defaults (failIfUnavailable is true), but a config flip must never silently drop
        // the deterministic boundary — record it so an unconfined run is auditable (review 🟡).
        store.addEvent(taskId, 'claude.sandbox', { unconfined: true, reason });
      } else {
        // Start the proxy first — its port goes into BOTH the network rules and HTTPS_PROXY, so
        // the sandbox-forced egress lands on it. A proxy that won't bind means unfiltered
        // network, so fail closed (matches the sandbox-unavailable throw above).
        try {
          proxy = await startEgressProxy(egressAllowlist(), (host) => supervisor.escalateHost(host, this.abort.signal));
        } catch (err) {
          throw new Error(`${CLAUDE_PROXY_ERROR} (${String(err)})`);
        }
        // buildSandboxProfile can throw (its guards, or a realpathSync TOCTOU) BEFORE the run
        // loop's try/finally — a throw there would leak the listening proxy. Close it on failure
        // (review 🟡). query()'s spawn is lazy (first iteration, inside the try), so the profile
        // build is the only pre-loop throw that can leak.
        try {
          spawnClaudeCodeProcess = sandboxWrappedSpawn(buildSandboxProfile(cwd, taskId, proxy.port));
        } catch (err) {
          proxy.close();
          throw err;
        }
        const url = `http://127.0.0.1:${proxy.port}`;
        // Clear any inherited NO_PROXY/no_proxy: a match there makes the CLI attempt a DIRECT
        // connect (Seatbelt-denied, no escalation), and NO_PROXY=* would cut it off from Anthropic
        // entirely — either way a cryptic failure instead of routing through the proxy (review 🟡).
        proxyEnv = { HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url, NO_PROXY: '', no_proxy: '' };
      }
    }

    const initialPrompt = this.opts.resumeSessionId ? brief : composePrompt(brief, cwd, this.planning);
    this.input.push(initialPrompt);
    this.turnsSent += 1;
    // The session's opening instruction, in the feed — the transcript viewer was missing
    // the very thing Claude was responding to (live finding 2026-07-16).
    store.addEvent(taskId, 'claude.prompt', { text: initialPrompt.slice(0, PROMPT_LOG_MAX_CHARS) });

    const session = query({
      prompt: this.input,
      options: {
        cwd,
        resume: this.opts.resumeSessionId,
        abortController: this.abort,
        maxTurns: config.claude.maxTurns,
        // Plan-then-execute for fresh sessions: start read-only in plan mode; approving
        // the plan flips to 'auto' (handlePlan). Resumes are direct instructions → straight
        // to 'auto'. In 'auto' the CLI classifier auto-runs safe actions — but it BYPASSES
        // canUseTool, so the supervisor's hard escalations and question-answering ride a
        // PreToolUse hook (which fires in every mode) instead. canUseTool is left with only
        // the plan-approval mode switch (which happens in plan mode, where it does fire).
        permissionMode: this.planning ? 'plan' : 'auto',
        // File checkpointing: back up files before edits so undo() can rewind a session
        // that made a mess — the safety net for non-git project dirs.
        enableFileCheckpointing: true,
        canUseTool: (toolName, input) => this.gate(toolName, input),
        hooks: {
          // Explicit timeout (seconds) that outlasts an escalation confirm, so the CLI
          // can't kill the hook mid-confirm and let an escalate-class action slip.
          PreToolUse: [{ hooks: [(hookInput) => this.preToolUse(hookInput)], timeout: Math.ceil(config.claude.hookTimeoutMs / 1000) }],
        },
        // M4.1: the whole CLI runs under Seatbelt (spawnClaudeCodeProcess above) so the
        // hook/notch stay the semantic layer (git push confirms) while the OS sandbox is
        // the deterministic containment — for the file tools AND bash. undefined on a
        // non-macOS host with failIfUnavailable off (the throw above covers fail-closed).
        spawnClaudeCodeProcess,
        // Context7 docs MCP (the user's call) — headless sessions don't inherit claude.ai
        // connectors, so give them the same library-docs tool an interactive session has.
        // Merged with the ~/.claude MCP servers the session already inherits.
        mcpServers: config.claude.mcpServers,
        // Least-privilege env MINUS provider secrets, PLUS the proxy vars so the CLI (and any
        // bash it spawns) routes egress through the filtering proxy the sandbox forces it onto.
        env: { ...subprocessEnv(), ...proxyEnv },
      },
    });
    this.query = session;

    let report = '';
    try {
      // Each claude.* event is an inline synchronous sqlite insert + WS broadcast on the
      // loop that also carries realtime audio. Unlike the M3 search path (which bursts ~10
      // ~200 KB rows at once and so chunks via setImmediate), Claude events arrive one per
      // assistant/tool turn with model latency between them — naturally spaced, no burst —
      // so they write inline. Revisit with setImmediate chunking if a chatty session ever
      // shows loop lag.
      for await (const msg of session) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          store.saveClaudeSession(taskId, { sessionId: msg.session_id, cwd, brief: this.opts.persistBrief });
        } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
          if (msg.error === 'authentication_failed') this.authFailed = true;
          for (const block of msg.message.content as ContentBlock[]) {
            if (block.type === 'text' && block.text) {
              store.addEvent(taskId, 'claude.message', { text: block.text });
              report = block.text; // the last assistant text is the run's report
            } else if (block.type === 'tool_use') {
              // The CLI drafts its plan into ~/.claude/plans BEFORE ExitPlanMode — hold on
              // to the content so handlePlan can surface the real plan (input.plan is empty
              // on current CLIs).
              if (block.name === 'Write') {
                const write = block.input as { file_path?: string; content?: string } | null;
                if (typeof write?.file_path === 'string' && typeof write.content === 'string') {
                  // Boundary-correct match (same idiom as supervisor.ts): expand a leading ~,
                  // then require a real path-segment boundary — a bare prefix test misses
                  // tilde-form writes and matches siblings like ~/.claude/plansXYZ.
                  const abs = write.file_path.startsWith('~') ? homedir() + write.file_path.slice(1) : write.file_path;
                  if (abs === PLAN_DIR || abs.startsWith(PLAN_DIR + sep)) this.planFileContent = write.content;
                }
              }
              store.addEvent(taskId, 'claude.tool_use', { name: block.name, input: JSON.stringify(block.input ?? {}).slice(0, limit) });
            }
          }
        } else if (msg.type === 'user' && !msg.parent_tool_use_id) {
          const content = msg.message.content;
          // Our own prompt echoes back as a string-content user message — capture its uuid
          // once as the rewind target (files at the first user turn = pre-run state).
          if (typeof content === 'string') {
            if (!this.firstUserMessageId && msg.uuid) this.firstUserMessageId = msg.uuid;
          } else if (Array.isArray(content)) {
            for (const block of content as ContentBlock[]) {
              if (block.type !== 'tool_result') continue;
              store.addEvent(taskId, 'claude.tool_result', { output: blockText(block.content).slice(0, limit), is_error: block.is_error === true });
            }
          }
        } else if (msg.type === 'result') {
          // Record BEFORE the park/throw exits below — a failed or parked run still burned
          // tokens. billed=0: subscription auth, so costUSD is the SDK's client-side
          // estimate at API list prices — exactly the "equivalent value" the usage view
          // labels it as. Falls back to our own rate table when the SDK reports 0.
          this.recordClaudeUsage(msg as unknown as ResultUsageMessage, taskId);
          this.turnsResolved += 1;
          if (supervisor.capHit) return this.park(report, 'reached the supervisor question limit — needs your input');
          if (this.planRejected) return this.park(report, 'plan needs your approval or revision');
          if (msg.subtype !== 'success') {
            // Auth failure surfaces as the assistant error flag or as login text in the
            // ERROR detail — NEVER in a successful report. Testing report text would fail a
            // good run whose report merely mentions "not logged in" (review 🔴 2026-07-16).
            const errText = (msg.errors ?? []).join('; ');
            if (this.authFailed || AUTH_MARKER.test(errText)) throw new Error(CLAUDE_AUTH_ERROR);
            if (RESUMABLE_LIMIT_SUBTYPES.has(msg.subtype)) {
              return this.park(report, msg.subtype === 'error_max_turns' ? 'reached the turn limit — needs your go-ahead to continue' : 'reached the budget limit — needs your go-ahead');
            }
            throw new Error(`Claude session ended: ${msg.subtype}`);
          }
          // Success — but the assistant may still have flagged an auth error mid-turn.
          if (this.authFailed) throw new Error(CLAUDE_AUTH_ERROR);
          report = msg.result || report;
          if (this.turnsResolved >= this.turnsSent) {
            this.input.close();
            return { parked: false, report };
          }
        }
      }
      // Stream ended without covering every queued turn (interrupt, subprocess exit).
      throw new Error('Claude session closed before finishing');
    } finally {
      this.input.close();
      proxy?.close(); // the session owns the proxy — stop listening when it ends
    }
  }

  /** One equivalent-value row per model from the result's cumulative modelUsage, recording
   *  only the delta since the last result. SDK ModelUsage carries costUSD (its own
   *  API-list-price estimate — preferred); our rate table covers a zero/missing one. */
  private recordClaudeUsage(msg: ResultUsageMessage, taskId: string) {
    // Same never-throws contract as the recorder module: this runs inside the message loop
    // of a gating-critical path, so a malformed SDK payload must degrade to a console line,
    // never to a rejected run.
    try {
      for (const { model, delta: d } of claudeUsageDeltas(msg, this.recordedModelUsage)) {
        if (d.in === 0 && d.out === 0 && d.read === 0 && d.write === 0) continue;
        const equivalent = d.cost > 0
          ? d.cost
          : priceClaudeEquivalent(model, { input: d.in, output: d.out, cacheRead: d.read, cacheWrite: d.write });
        recordUsage({
          provider: 'anthropic',
          model,
          kind: 'claude_result',
          taskId,
          inputTokens: d.in,
          outputTokens: d.out,
          cachedTokens: d.read,
          cacheWriteTokens: d.write,
          costUsd: equivalent ?? 0,
          billed: false,
          detail: equivalent == null ? { unpriced: true } : undefined,
        });
      }
    } catch (err) {
      console.error('usage record failed (continuing):', err);
    }
  }

  private park(report: string, reason: string): ClaudeRunResult {
    // A follow-up the user sent while the task was parked (e.g. during plan review) sits in
    // the queue; closing it here drops any unconsumed turn. Surface that instead of losing
    // their words silently — they can resend after re-reading the park reason.
    const dropped = this.turnsSent - this.turnsResolved;
    this.input.close();
    const parkedReason = dropped > 0 ? `${reason} (a follow-up you sent wasn't processed — please resend it)` : reason;
    return { parked: true, parkedReason, report };
  }

  /**
   * canUseTool only exists for the plan-approval mode switch (ExitPlanMode, in plan mode).
   * Execution-phase gating is the PreToolUse hook's job — it fires in 'auto' too, where
   * canUseTool doesn't. Anything else that reaches here (reads during planning) is allowed;
   * the hook has already vetted the escalate-class and questions.
   */
  private async gate(toolName: string, input: Record<string, unknown>): Promise<GateResult> {
    if (toolName === 'ExitPlanMode') return this.handlePlan(input);
    return { behavior: 'allow' };
  }

  /** The execution-phase gate: escalate-class → notch confirm, AskUserQuestion → supervisor,
   *  everything else deferred to the CLI's auto classifier. Fires in every permission mode. */
  private async preToolUse(hookInput: unknown): Promise<HookJSONOutput> {
    const pre = hookInput as { tool_name?: string; tool_input?: unknown };
    const toolName = pre.tool_name ?? '';
    // Plan approval is handled atomically by canUseTool (it can switch mode; a hook can't).
    if (toolName === 'ExitPlanMode') return {};
    try {
      const gate = await this.opts.supervisor.gateForHook(toolName, (pre.tool_input ?? {}) as Record<string, unknown>, this.abort.signal);
      if (gate.decision === 'defer') return {};
      if (gate.decision === 'allow') {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
      }
      // Deny (declined escalation, supervisor answer, or the intervention cap). The cap asks
      // to interrupt the run — scheduled post-return so the control request isn't reentrant.
      if (gate.interrupt) setImmediate(() => void this.query?.interrupt().catch(() => {}));
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: gate.reason ?? 'Denied.' } };
    } catch (err) {
      // The hook IS the execution-phase security boundary — FAIL CLOSED. A supervisor or
      // sqlite error must never silently degrade an escalate-class action to the auto
      // classifier. Abort (task cancelled) is the one case that should propagate.
      if (this.abort.signal.aborted) throw err;
      try {
        this.opts.store.addEvent(this.opts.taskId, 'supervisor.decision', { kind: 'gate', tool: toolName, decision: 'deny', source: 'error', reason: String(err) });
      } catch {
        // best-effort audit — the deny below is what actually protects the boundary
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Gate error — denied for safety. ${String(err)}` } };
    }
  }

  private async handlePlan(input: Record<string, unknown>): Promise<GateResult> {
    // Current CLIs call ExitPlanMode with EMPTY input and persist the plan to
    // ~/.claude/plans instead — captured in the tool_use loop. Prefer inline plan text
    // when present (older CLIs), else the plan file, else the raw input as a last resort
    // (an empty "{}" here is exactly the live failure this fixes, 2026-07-16).
    const inline = typeof input.plan === 'string' && input.plan.trim() ? input.plan : null;
    const plan = inline ?? this.planFileContent ?? JSON.stringify(input);
    this.opts.store.addEvent(this.opts.taskId, 'claude.plan', { plan });
    // No approver wired (tests) → don't execute. Otherwise surface the plan to the user.
    const approved = this.opts.onPlanReady ? await this.opts.onPlanReady(plan) : false;
    if (approved) {
      // Approve ExitPlanMode AND switch to 'auto' mode for execution in one result. Doing
      // the mode switch via updatedPermissions (not a setPermissionMode control request)
      // avoids a reentrant deadlock — a control request can't be processed while the SDK
      // is blocked awaiting this very canUseTool callback. 'auto' lets the CLI classifier
      // auto-run safe actions while still routing risky ones (git push, deletes outside
      // cwd, network sends) through the supervisor's policy gate.
      return { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] };
    }
    // interrupt ends the run; the result handler sees planRejected and parks (resumable).
    this.planRejected = true;
    return { behavior: 'deny', message: 'The user did not approve the plan. Stop; they will send revised instructions.', interrupt: true };
  }

  /** Rewind the session's file edits to its pre-run state. Live session only (rewindFiles
   *  is a streaming control request); the checkpoints exist on disk regardless. */
  async undo(): Promise<string> {
    if (!this.query || !this.firstUserMessageId) {
      return 'That session has no rewindable checkpoint from this run (it may have already closed).';
    }
    try {
      // firstUserMessageId is the first turn of THIS run() — for a resumed session that's
      // the resume point, not the original start (so "this run", not "before it started").
      await this.query.rewindFiles(this.firstUserMessageId);
      this.opts.store.addEvent(this.opts.taskId, 'claude.tool_result', { output: 'files rewound to the start of this run (undo)' });
      return 'Rewound the file changes from this run.';
    } catch (err) {
      return `Could not rewind: ${String(err)}`;
    }
  }
}
