import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { Store, TaskRow } from '../events/store.ts';
import { runSubagent, type SubagentKind } from '../agents/openai-runner.ts';
import { ClaudeRunner, type ClaudeRunnerOpts, type ClaudeSessionRunner } from '../agents/claude-runner.ts';
import { Supervisor, type EscalationRequest } from '../agents/supervisor.ts';
import type { MacBridge } from '../ws/mac.ts';

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
  // M7 voice steering: queued mid-task guidance for RUNNING computer tasks. The loop's
  // tools drain it into their next result — guidance lands at the model's next
  // attention point, no SDK surgery (same trick as the structured stall note).
  private steering = new Map<string, string[]>();
  // cwd of every non-terminal Claude session — a second session on the same real project
  // dir would edit the same files concurrently (git/file conflicts). Kept through park.
  private activeCwds = new Map<string, string>();
  private store: Store;
  private escalate: EscalateFn;
  private approvePlan: ApprovePlanFn;
  private makeRunner: RunnerFactory;
  private macBridge?: MacBridge;
  onFinished: (task: TaskRow) => void = () => {};

  // No parameter properties: daemon tests run node --test in strip-only mode.
  constructor(
    store: Store,
    escalate: EscalateFn = async () => false, // no bridge (tests) → deny, fail safe
    approvePlan: ApprovePlanFn = async () => false, // no bridge (tests) → don't execute
    makeRunner: RunnerFactory = (opts) => new ClaudeRunner(opts),
    macBridge?: MacBridge, // M6: present in prod; omitted in tests (mac tasks aren't spawned there)
  ) {
    this.store = store;
    this.escalate = escalate;
    this.approvePlan = approvePlan;
    this.makeRunner = makeRunner;
    this.macBridge = macBridge;
  }

  /** Spawn a background sub-agent. taskType 'mac' runs the computer-use loop (kind
   *  'computer' so the kill switch can find it) with the AX toolset; 'research' is the
   *  default web/writing agent. */
  spawnSubagent(title: string, brief: string, taskType: SubagentKind = 'research'): TaskRow {
    if (taskType === 'mac' && !this.macBridge) throw new Error('Mac control is unavailable (no shell bridge wired).');
    // One computer task at a time: there is ONE screen/keyboard — concurrent tasks fight
    // over the same apps (live demo: three overlapping wallpaper tasks drove System
    // Settings against each other). Same spirit as assertCwdFree for Claude sessions.
    if (taskType === 'mac') {
      for (const otherId of this.aborts.keys()) {
        const other = this.store.getTask(otherId);
        if (other?.kind === 'computer') {
          throw new Error(`a computer-use task ("${other.title}") is already driving the Mac; wait for it to finish or cancel it first`);
        }
      }
    }
    const id = randomUUID().slice(0, 8);
    const workspace = join(config.home.tasks, id);
    mkdirSync(workspace, { recursive: true });
    const now = Date.now();
    const rowKind = taskType === 'mac' ? 'computer' : 'subagent';
    const task: TaskRow = { id, kind: rowKind, title, status: 'running', workspace, created_at: now, updated_at: now };
    this.store.createTask(task);
    this.store.addEvent(id, 'task.created', { title, brief, kind: rowKind });

    const abort = new AbortController();
    this.aborts.set(id, abort);
    // Risky sub-agent scripts route to the same notch confirm as everything else (deny on
    // timeout / no shell). Only computer-use tasks use it; research tasks pass undefined.
    // M7: the browser lane labels its own confirms via the optional title param.
    const confirmScript =
      taskType === 'mac'
        ? (detail: string, confirmTitle = 'Allow this Mac script?') => this.escalate(id, title, { title: confirmTitle, detail }, abort.signal)
        : undefined;
    // M7 cooperative handoff: pause (needs_input announces it aloud), stand the kill
    // switch down so the user's own typing IS the handoff, wait for his notch "Done"
    // (generous window, deny-on-timeout), then re-arm and resume. Status restore skips
    // a task that finished/cancelled while paused.
    const requestHandoff =
      taskType === 'mac'
        ? async (reason: string) => {
            this.setTaskStatus(id, 'needs_input', reason);
            this.macBridge!.setHandoff(true);
            try {
              return await this.escalate(
                id, title,
                { title: 'Your turn — tap Done when finished', detail: reason, timeoutMs: config.mac.handoffTimeoutMs },
                abort.signal,
              );
            } finally {
              this.macBridge!.setHandoff(false);
              if (!this.finished.has(id)) this.setTaskStatus(id, 'running', 'handoff finished');
            }
          }
        : undefined;
    // Two-arg then(): the rejection handler sees ONLY runSubagent errors, so a failure
    // while writing the report (success path) can't be mislabeled 'cancelled'/'failed'.
    runSubagent({
      taskId: id, brief, store: this.store, signal: abort.signal, kind: taskType,
      macBridge: this.macBridge, confirmScript, requestHandoff,
      takeSteering: taskType === 'mac' ? () => this.takeSteering(id) : undefined,
    }).then(
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
   *
   * M7: a RUNNING computer-use task takes steering instead — the message is queued and
   * the loop's next tool result carries it ("use the personal account", "skip that
   * dialog"). Computer tasks aren't resumable once finished (the screen moved on).
   */
  sendToSession(id: string, text: string): 'queued' | 'resumed' {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`no task ${id}`);
    if (task.kind === 'computer') {
      if (task.status !== 'running' && task.status !== 'needs_input') {
        throw new Error(`that computer task already ${task.status === 'done' ? 'finished' : 'stopped'} — start a new one instead`);
      }
      const queue = this.steering.get(id) ?? [];
      queue.push(text);
      this.steering.set(id, queue);
      this.store.addEvent(id, 'task.steering', { text });
      return 'queued';
    }
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
        // Transient: the run itself continues the moment the user answers the confirm. Skip if the
        // session is no longer live (finished, or parked with its runner already dropped): an
        // egress confirm can resolve AFTER the task parked needs_input, and flipping it back to
        // 'running' would un-park it (and defeat undoSession's needs_input guard) (review 🟡).
        if (this.finished.has(task.id) || !this.claudeRunners.has(task.id)) return;
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
    const approved = await this.approvePlan(task.id, task.title, plan, signal);
    // Only flip back to 'running' when the plan was approved and execution proceeds. On a
    // decline the runner immediately parks needs_input — resetting to 'running' first would
    // flash a spurious running state on the bubble/dashboard. On abort this rejects and the
    // cancel path owns the status, so no reset either.
    if (approved && !this.finished.has(task.id)) this.setTaskStatus(task.id, 'running', 'plan answered');
    return approved;
  }

  /** Rewind a live Claude session's file edits (file checkpointing). No live runner →
   *  can't rewind (the checkpoints need the running session); git is the fallback. */
  async undoSession(id: string): Promise<string> {
    const task = this.store.getTask(id);
    if (!task || task.kind !== 'claude') return `No Claude session ${id}.`;
    const runner = this.claudeRunners.get(id);
    if (!runner) return 'That session already closed — its edits are recoverable via git if the project is version-controlled.';
    // rewindFiles is a control request; the CLI won't service it while blocked awaiting a
    // pending confirm (plan approval or an escalation) — undo() would hang and wedge the
    // voice turn. When the task is parked/awaiting input, refuse with a spoken next-step
    // instead. (Cancelling the task is the way to stop a session that's waiting on the user.)
    if (task.status === 'needs_input') {
      return 'That session is paused waiting on you — answer or cancel it first, then I can undo its changes.';
    }
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

  /** Drain queued steering for a computer task — called by the loop's tools; a message
   *  is delivered exactly once. */
  takeSteering(id: string): string[] {
    const msgs = this.steering.get(id) ?? [];
    this.steering.delete(id);
    return msgs;
  }

  private finish(id: string, status: TaskRow['status'], payload: unknown) {
    if (this.finished.has(id)) return; // idempotent: never double-emit task.finished / double-announce
    this.finished.add(id);
    this.aborts.delete(id);
    this.activeCwds.delete(id); // terminal → the project dir is free for a new session
    this.steering.delete(id); // undelivered steering dies with the task
    this.store.updateTaskStatus(id, status);
    this.store.addEvent(id, 'task.finished', { status, ...(payload as object) });
    const task = this.store.getTask(id);
    if (task) this.onFinished(task);
  }

  /** M6 kill switch: untagged HID input (the user) or the abort hotkey — stop every
   *  running computer-use task at once. The abort propagates through each task's
   *  AbortController into in-flight MacBridge RPCs and script children. */
  cancelComputerTasks(reason: string) {
    for (const id of this.aborts.keys()) {
      const task = this.store.getTask(id);
      if (task?.kind !== 'computer') continue;
      this.store.addEvent(id, 'mac.kill_switch', { reason });
      this.cancel(id);
    }
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

  /** The document a finished Claude session produced in its OWN workspace, for auto-present
   *  on completion (2026-07-16 — the user shouldn't have to ask "show me the file"). Newest
   *  document-ish file, excluding the report/supervisor logs. Returns null for a session
   *  that worked in a real project_dir (deliverable lives there, not the workspace — those
   *  are code edits, not a single viewable doc; the model's present_file covers that case). */
  claudeDeliverable(id: string): string | null {
    const task = this.store.getTask(id);
    if (!task || task.kind !== 'claude') return null;
    try {
      const docs = readdirSync(task.workspace, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name !== 'report.md' && d.name !== 'supervisor.md')
        .filter((d) => /\.(md|markdown|txt|json|ya?ml|csv|html?|xml|rtf|tsv|ini|toml|log)$/i.test(d.name))
        .map((d) => join(task.workspace, d.name));
      if (docs.length === 0) return null;
      // Newest wins — the last thing the session wrote is the deliverable.
      return docs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    } catch {
      return null;
    }
  }
}
