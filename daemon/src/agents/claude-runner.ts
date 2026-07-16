import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.ts';
import type { Store } from '../events/store.ts';
import type { Supervisor } from './supervisor.ts';

// M4: one Claude Code session per task, on subscription auth (spike-verified 2026-07-15):
// the subprocess env must keep USER (keychain credential lookup resolves the login item by
// account name) and must NOT carry ANTHROPIC_API_KEY (it silently outranks the claude.ai
// login). Streaming input keeps the session open for supervisor answers and the user's
// mid-run redirects; the session id is persisted so send_to_session can resume after a
// daemon restart.

/** Push queue → async-generator streaming input for query(). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
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
function composePrompt(brief: string, cwd: string): string {
  return `You are working autonomously for Gumbo, the user's personal Mac agent. Nobody is watching a
terminal. Your working directory is ${cwd}. If you genuinely need a decision you cannot make from
the brief, use the AskUserQuestion tool — a supervisor answers on the user's behalf; never end your
run with an unanswered question. When the work is done, end with a concise report of what you did,
what you verified, and where the changes live — it is saved verbatim as the task's report and its
key points are read aloud to the user.

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
  /** True when the run stopped for the user (intervention cap) rather than finishing. */
  parked: boolean;
  report: string;
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
}

export class ClaudeRunner {
  readonly abort = new AbortController();
  private input = new InputQueue();
  private opts: ClaudeRunnerOpts;
  // One result message arrives per user turn; the run is over only when every queued
  // turn has resolved — otherwise a mid-run send_to_session would be silently dropped.
  private turnsSent = 0;
  private turnsResolved = 0;

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

  async run(): Promise<ClaudeRunResult> {
    const { taskId, brief, cwd, store, supervisor } = this.opts;
    const limit = config.activityLogMaxChars;
    this.input.push(this.opts.resumeSessionId ? brief : composePrompt(brief, cwd));
    this.turnsSent += 1;

    const session = query({
      prompt: this.input,
      options: {
        cwd,
        resume: this.opts.resumeSessionId,
        abortController: this.abort,
        maxTurns: config.claude.maxTurns,
        // Auto mode (the user's call): the CLI auto-accepts edits under cwd natively; every
        // other permission lands in the supervisor's pure policy table.
        permissionMode: 'acceptEdits',
        canUseTool: async (toolName, input, { signal }) => supervisor.gateTool(toolName, input, signal),
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      },
    });

    let report = '';
    try {
      for await (const msg of session) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          store.saveClaudeSession(taskId, { sessionId: msg.session_id, cwd, brief: this.opts.persistBrief });
        } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
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
          if (Array.isArray(content)) {
            for (const block of content as ContentBlock[]) {
              if (block.type !== 'tool_result') continue;
              store.addEvent(taskId, 'claude.tool_result', { output: blockText(block.content).slice(0, limit), is_error: block.is_error === true });
            }
          }
        } else if (msg.type === 'result') {
          this.turnsResolved += 1;
          if (supervisor.capHit) {
            this.input.close();
            return { parked: true, report };
          }
          if (msg.subtype !== 'success') {
            throw new Error(`Claude session ended: ${msg.subtype}`);
          }
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
}
