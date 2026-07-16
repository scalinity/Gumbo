import { query, type Query, type SDKUserMessage, type HookJSONOutput, type SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';
import { config, secretEnvKeys, secretFilePaths } from '../config.ts';
import type { Store } from '../events/store.ts';
import type { Supervisor, GateResult } from './supervisor.ts';

// Auth-failure markers: a not-logged-in / expired-subscription session comes back either
// as an assistant error field or as result text carrying these strings (verified during
// the risk-#2 spike, where a bad env produced a 'success' result whose text was the login
// error). Turned into a clear, actionable failure instead of a cryptic SDK error.
const AUTH_MARKER = /not logged in|please run\s*\/login|authentication_failed|oauth[^.]*\b(expired|invalid|revoked)\b/i;
export const CLAUDE_AUTH_ERROR = 'auth: Claude Code needs you to log in again — run `claude` in a terminal, then `/login`.';

// Result subtypes that mean "ran out of room," not "failed": the work is on disk and the
// session resumes with send_to_session, so the task parks for the user rather than failing.
const RESUMABLE_LIMIT_SUBTYPES = new Set(['error_max_turns', 'error_max_budget_usd']);

// M4.1 fail-closed detection: with failIfUnavailable the CLI refuses to start and emits a
// result (subtype error_during_execution) whose errors[] carries this exact phrasing —
// matched on the ERROR detail only, never on report text (same discipline as AUTH_MARKER).
// Exported for unit tests.
export const SANDBOX_MARKER = /sandbox required but unavailable|refusing to start without a working sandbox/i;
export const CLAUDE_SANDBOX_ERROR = "this Mac can't run the OS sandbox (Seatbelt unavailable), so the session refused to start rather than run unconfined.";

/** M4.1: OS-level containment under the semantic gates. Writes are confined to the session
 *  cwd (the sandbox's built-in boundary) plus the task workspace; outbound network is
 *  blocked by default (the SDK's egress proxy 403s any domain not allowlisted). Exported
 *  for unit tests. */
export function sandboxSettings(taskId: string): SandboxSettings {
  const { enabled, failIfUnavailable, allowedDomains } = config.claude.sandbox;
  return {
    enabled,
    failIfUnavailable,
    // The model can pass dangerouslyDisableSandbox on a Bash call; false makes the CLI
    // ignore it — containment stays deterministic even under prompt injection.
    allowUnsandboxedCommands: false,
    // Read side (review 🟡): Seatbelt's default read policy is permissive, so without
    // this the repo .env (all provider keys) and ~/.claude stay readable — the env strip
    // covers the environment, not the disk. Deny closes the read half while the egress
    // default-deny closes the exfil half.
    credentials: { files: secretFilePaths.map((path) => ({ path, mode: 'deny' as const })) },
    filesystem: { allowWrite: [join(config.home.tasks, taskId)] },
    ...(allowedDomains.length > 0 ? { network: { allowedDomains: [...allowedDomains] } } : {}),
  };
}

// Least privilege: hand the Claude subprocess the environment it needs (HOME/PATH/USER for
// the keychain login lookup, TMPDIR, locale, …) MINUS every daemon-held provider secret —
// the session needs none of them, and 'auto' mode auto-runs safe bash that could read them.
function subprocessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of secretEnvKeys) delete env[key];
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
  /** Surface Claude's plan to the user and resolve his approval (false → don't execute). */
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

  // No parameter properties: daemon tests run node --test in strip-only mode.
  constructor(opts: ClaudeRunnerOpts) {
    this.opts = opts;
  }

  /** Queue a follow-up user turn; false once the session ended (caller resumes instead). */
  send(text: string): boolean {
    if (!this.input.push(text)) return false;
    this.turnsSent += 1;
    return true;
  }

  private get planning(): boolean {
    return this.opts.planFirst === true && !this.opts.resumeSessionId;
  }

  async run(): Promise<ClaudeRunResult> {
    const { taskId, brief, cwd, store, supervisor } = this.opts;
    const limit = config.activityLogMaxChars;
    this.input.push(this.opts.resumeSessionId ? brief : composePrompt(brief, cwd, this.planning));
    this.turnsSent += 1;

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
        // M4.1: OS sandbox (Seatbelt) UNDER the gates above — the hook/notch stay the
        // semantic layer (git push confirms); the sandbox is the deterministic one
        // (can't escape cwd+workspace, can't phone home). Fail closed when unavailable.
        sandbox: sandboxSettings(taskId),
        env: subprocessEnv(),
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
          this.turnsResolved += 1;
          if (supervisor.capHit) return this.park(report, 'reached the supervisor question limit — needs your input');
          if (this.planRejected) return this.park(report, 'plan needs your approval or revision');
          if (msg.subtype !== 'success') {
            // Auth failure surfaces as the assistant error flag or as login text in the
            // ERROR detail — NEVER in a successful report. Testing report text would fail a
            // good run whose report merely mentions "not logged in" (review 🔴 2026-07-16).
            const errText = (msg.errors ?? []).join('; ');
            if (this.authFailed || AUTH_MARKER.test(errText)) throw new Error(CLAUDE_AUTH_ERROR);
            if (SANDBOX_MARKER.test(errText)) throw new Error(CLAUDE_SANDBOX_ERROR);
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
    }
  }

  private park(report: string, reason: string): ClaudeRunResult {
    // A follow-up the user sent while the task was parked (e.g. during plan review) sits in
    // the queue; closing it here drops any unconsumed turn. Surface that instead of losing
    // his words silently — he can resend after re-reading the park reason.
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
    const plan = String(input.plan ?? JSON.stringify(input));
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
    return { behavior: 'deny', message: 'the user did not approve the plan. Stop; he will send revised instructions.', interrupt: true };
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
