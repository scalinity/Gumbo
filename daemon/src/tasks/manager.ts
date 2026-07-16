import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { Store, TaskRow } from '../events/store.ts';
import { runSubagent } from '../agents/openai-runner.ts';
import { ClaudeRunner, type ClaudeRunnerOpts, type ClaudeSessionRunner } from '../agents/claude-runner.ts';
import { Supervisor, type EscalationRequest } from '../agents/supervisor.ts';

/** Resolves the user's notch answer for a supervisor escalation (ws/confirm.ts in prod).
 *  The signal fires if the task is cancelled while the confirm is pending. */
export type EscalateFn = (taskId: string, taskTitle: string, req: EscalationRequest, signal?: AbortSignal) => Promise<boolean>;

/** Surfaces a Claude plan to the user for approval before it executes (routes to the notch). */
export type ApprovePlanFn = (taskId: string, taskTitle: string, plan: string, signal?: AbortSignal) => Promise<boolean>;

/** Builds the runner for a Claude session — swapped for a fake in tests (no live query()). */
export type RunnerFactory = (opts: ClaudeRunnerOpts) => ClaudeSessionRunner;

export class TaskManager {
  private aborts = new Map<string, AbortController>();
  private finished = new Set<string>();
  private claudeRunners = new Map<string, ClaudeSessionRunner>();
  // cwd of every non-terminal Claude session — a second session on the same real project
  // dir would edit the same files concurrently (git/file conflicts). Kept through park.
  private activeCwds = new Map<string, string>();
  private store: Store;
  private escalate: EscalateFn;
  private approvePlan: ApprovePlanFn;
  private makeRunner: RunnerFactory;
  onFinished: (task: TaskRow) => void = () => {};

  // No parameter properties: daemon tests run node --test in strip-only mode.
  constructor(
    store: Store,
    escalate: EscalateFn = async () => false, // no bridge (tests) → deny, fail safe
    approvePlan: ApprovePlanFn = async () => false, // no bridge (tests) → don't execute
    makeRunner: RunnerFactory = (opts) => new ClaudeRunner(opts),
  ) {
    this.store = store;
    this.escalate = escalate;
    this.approvePlan = approvePlan;
    this.makeRunner = makeRunner;
  }

  spawnSubagent(title: string, brief: string): TaskRow {
    const id = randomUUID().slice(0, 8);
    const workspace = join(config.home.tasks, id);
    mkdirSync(workspace, { recursive: true });
    const now = Date.now();
    const task: TaskRow = { id, kind: 'subagent', title, status: 'running', workspace, created_at: now, updated_at: now };
    this.store.createTask(task);
    this.store.addEvent(id, 'task.created', { title, brief, kind: 'subagent' });

    const abort = new AbortController();
    this.aborts.set(id, abort);
    // Two-arg then(): the rejection handler sees ONLY runSubagent errors, so a failure
    // while writing the report (success path) can't be mislabeled 'cancelled'/'failed'.
    runSubagent({ taskId: id, brief, store: this.store, signal: abort.signal }).then(
      (report) => this.finishWithReport(id, title, workspace, report),
      (err: unknown) => {
        this.finish(id, abort.signal.aborted ? 'cancelled' : 'failed', { error: String(err) });
      },
    );
    return task;
  }

  /**
   * Land a finished task's report and mark it done. Shared by the OpenAI sub-agent and
   * Claude runners: report.md + finish('done') are the critical path; memory indexing is
   * best-effort (a sqlite hiccup once the report is on disk must never flip a succeeded
   * task to 'failed'). A report-write failure IS terminal — there's nothing to deliver.
   */
  private finishWithReport(id: string, title: string, workspace: string, report: string) {
    try {
      writeFileSync(join(workspace, 'report.md'), report || '(no report)');
    } catch (err) {
      this.finish(id, 'failed', { error: `report write failed: ${String(err)}` });
      return;
    }
    try {
      this.store.saveTaskOutput(id, title, report);
    } catch (err) {
      console.error(`task ${id}: memory index failed (task still done):`, err);
    }
    this.finish(id, 'done', { report_path: `tasks/${id}/report.md` });
  }

  /**
   * M4: a full Claude Code session as a background task. cwd is the named project when
   * the user gave one (the point of most sessions is editing a real repo), else the task
   * workspace; report.md + supervisor.md land in the workspace either way so the
   * announce/bubble pipeline works unchanged.
   */
  spawnClaudeSession(title: string, brief: string, projectDir?: string | null): TaskRow {
    const raw = projectDir?.trim();
    if (raw && !(existsSync(raw) && statSync(raw).isDirectory())) {
      throw new Error(`project_dir does not exist or is not a directory: ${raw}`);
    }
    // Canonicalize before comparing: realpath collapses `.`/`..`/trailing-slash/symlinks so
    // `/repo` and `/repo/` and a symlinked alias don't slip the concurrent-edit guard.
    const dir = raw ? realpathSync(raw) : undefined;
    if (dir) this.assertCwdFree(dir);
    const id = randomUUID().slice(0, 8);
    const workspace = join(config.home.tasks, id);
    mkdirSync(workspace, { recursive: true });
    const cwd = dir || workspace;
    const now = Date.now();
    const task: TaskRow = { id, kind: 'claude', title, status: 'running', workspace, created_at: now, updated_at: now };
    this.store.createTask(task);
    this.store.addEvent(id, 'task.created', { title, brief, kind: 'claude', cwd });
    this.startClaude(task, brief, cwd);
    return task;
  }

  /**
   * Follow-up text into a Claude session: queued live when the runner is up, otherwise
   * the persisted session id is resumed in its original cwd — this is also how a task
   * interrupted by a daemon restart (or parked needs_input) picks back up.
   */
  sendToSession(id: string, text: string): 'queued' | 'resumed' {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`no task ${id}`);
    if (task.kind !== 'claude') throw new Error(`task ${id} is not a Claude session`);
    const live = this.claudeRunners.get(id);
    if (live && live.send(text)) {
      if (task.status === 'needs_input') this.setTaskStatus(id, 'running', 'follow-up from the user');
      return 'queued';
    }
    const saved = this.store.getClaudeSession(id);
    if (!saved) throw new Error(`no resumable session for task ${id}`);
    // Resume re-enters startClaude directly (bypassing spawn's guard), so re-check here:
    // another session may have started in this project while this one was finished/parked.
    this.assertCwdFree(saved.cwd, id);
    // The task finished (or died with a previous daemon) — bring it back to life.
    this.finished.delete(id);
    this.setTaskStatus(id, 'running', 'resumed by the user');
    this.startClaude(task, text, saved.cwd, saved.session_id, saved.brief);
    return 'resumed';
  }

  private startClaude(task: TaskRow, brief: string, cwd: string, resumeSessionId?: string, originalBrief?: string) {
    // On resume the accumulated brief keeps the supervisor grounded in the original task,
    // and is what gets re-persisted for the next resume.
    const fullBrief = originalBrief ? `${originalBrief}\n\nFollow-up from the user: ${brief}` : brief;
    const supervisor = new Supervisor({
      taskId: task.id,
      title: task.title,
      brief: fullBrief,
      cwd,
      store: this.store,
      escalate: (req, signal) => this.escalate(task.id, task.title, req, signal),
      setBlocked: (blocked) => {
        // Transient: the run itself continues the moment the user answers the confirm.
        if (this.finished.has(task.id)) return;
        this.setTaskStatus(task.id, blocked ? 'needs_input' : 'running', blocked ? 'awaiting notch confirm' : 'confirm answered');
      },
    });
    const runner = this.makeRunner({
      taskId: task.id,
      brief,
      persistBrief: fullBrief,
      cwd,
      store: this.store,
      supervisor,
      resumeSessionId,
      // Plan-then-execute only for a fresh spawn; a resume is already a direct instruction.
      planFirst: config.claude.planFirst && !resumeSessionId,
      onPlanReady: (plan) => this.reviewPlan(task, plan, runner.abort.signal),
    });
    this.claudeRunners.set(task.id, runner);
    this.aborts.set(task.id, runner.abort);
    this.activeCwds.set(task.id, cwd);

    runner.run().then(
      ({ parked, parkedReason, report }) => {
        this.claudeRunners.delete(task.id);
        this.writeSupervisorLog(supervisor, task);
        if (parked) {
          // Cap / unapproved plan / turn limit: not finished, waiting on the user —
          // send_to_session resumes. Drop the resolved run's AbortController so cancel()
          // reaches the needs_input close-out instead of "aborting" a finished run and
          // falsely reporting success. cwd stays reserved (the session is still live-ish).
          this.aborts.delete(task.id);
          this.setTaskStatus(task.id, 'needs_input', parkedReason ?? 'waiting on the user');
          return;
        }
        this.finishWithReport(task.id, task.title, task.workspace, report);
      },
      (err: unknown) => {
        this.claudeRunners.delete(task.id);
        this.writeSupervisorLog(supervisor, task);
        // Auth failure carries an 'auth:' prefix from the runner — record it as a clear,
        // actionable failure so the dashboard/bubble say "log in again" not a cryptic error.
        // Use .message, not String(err): String(Error) prepends "Error: ", so the prefix
        // check would never match (review 🟡 2026-07-16).
        const raw = err instanceof Error ? err.message : String(err);
        const auth = raw.startsWith('auth:');
        this.finish(task.id, runner.abort.signal.aborted ? 'cancelled' : 'failed', {
          error: auth ? raw.slice(5).trim() : raw,
          ...(auth ? { reason: 'auth' } : {}),
        });
      },
    );
  }

  /** Refuse a cwd another live Claude session already holds (concurrent edits to one repo
   *  conflict). `exceptId` skips the caller's own entry on the resume path. */
  private assertCwdFree(cwd: string, exceptId?: string) {
    for (const [otherId, otherCwd] of this.activeCwds) {
      if (otherId === exceptId) continue;
      if (otherCwd === cwd) {
        const other = this.store.getTask(otherId);
        throw new Error(`a Claude session ("${other?.title ?? otherId}") is already working in ${cwd}; let it finish or redirect it first`);
      }
    }
  }

  /** Flip the task needs_input while the user reviews the plan, then route to the notch. */
  private async reviewPlan(task: TaskRow, plan: string, signal?: AbortSignal): Promise<boolean> {
    if (this.finished.has(task.id)) return false;
    this.setTaskStatus(task.id, 'needs_input', 'awaiting plan approval');
    try {
      return await this.approvePlan(task.id, task.title, plan, signal);
    } finally {
      if (!this.finished.has(task.id)) this.setTaskStatus(task.id, 'running', 'plan answered');
    }
  }

  /** Rewind a live Claude session's file edits (file checkpointing). No live runner →
   *  can't rewind (the checkpoints need the running session); git is the fallback. */
  async undoSession(id: string): Promise<string> {
    const task = this.store.getTask(id);
    if (!task || task.kind !== 'claude') return `No Claude session ${id}.`;
    const runner = this.claudeRunners.get(id);
    if (!runner) return 'That session already closed — its edits are recoverable via git if the project is version-controlled.';
    return runner.undo();
  }

  private writeSupervisorLog(supervisor: Supervisor, task: TaskRow) {
    try {
      supervisor.writeLog(task.workspace);
    } catch (err) {
      console.error(`task ${task.id}: supervisor.md write failed:`, err);
    }
  }

  /** Status flips outside finish() (needs_input ⇄ running) — evented so bubbles/dashboard track them. */
  private setTaskStatus(id: string, status: TaskRow['status'], reason: string) {
    this.store.updateTaskStatus(id, status);
    this.store.addEvent(id, 'task.status', { status, reason });
  }

  private finish(id: string, status: TaskRow['status'], payload: unknown) {
    if (this.finished.has(id)) return; // idempotent: never double-emit task.finished / double-announce
    this.finished.add(id);
    this.aborts.delete(id);
    this.activeCwds.delete(id); // terminal → the project dir is free for a new session
    this.store.updateTaskStatus(id, status);
    this.store.addEvent(id, 'task.finished', { status, ...(payload as object) });
    const task = this.store.getTask(id);
    if (task) this.onFinished(task);
  }

  cancel(id: string): boolean {
    const abort = this.aborts.get(id);
    if (abort) {
      abort.abort();
      return true;
    }
    // A cap-parked Claude task has no live runner to abort — cancelling closes it out
    // (the persisted session id stays resumable if the user changes his mind).
    const task = this.store.getTask(id);
    if (task?.status === 'needs_input') {
      this.finish(id, 'cancelled', { reason: 'cancelled while paused' });
      return true;
    }
    return false;
  }

  readReport(id: string): string | null {
    const task = this.store.getTask(id);
    if (!task) return null;
    try {
      return readFileSync(join(task.workspace, 'report.md'), 'utf8');
    } catch {
      return null;
    }
  }
}
