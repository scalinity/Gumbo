import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { Store, TaskRow } from '../events/store.ts';
import { runSubagent, type SubagentKind } from '../agents/openai-runner.ts';
import { ClaudeRunner, type ClaudeRunnerOpts, type ClaudeSessionRunner } from '../agents/claude-runner.ts';
import { Supervisor, type EscalationRequest } from '../agents/supervisor.ts';
import { getBrowserClient } from '../browser/client.ts';
import type { MacBridge } from '../ws/mac.ts';
import { sanitizeTeachStep, teachingReport, type TeachStep } from './teach.ts';
import { validateProcedure, type Procedure } from '../agents/procedures.ts';

/** Resolves the user's notch answer for a supervisor escalation (ws/confirm.ts in prod).
 *  The signal fires if the task is cancelled while the confirm is pending. */
export type EscalateFn = (taskId: string, taskTitle: string, req: EscalationRequest, signal?: AbortSignal) => Promise<boolean>;

/** Surfaces a Claude plan to the user for approval before it executes (routes to the notch). */
export type ApprovePlanFn = (taskId: string, taskTitle: string, plan: string, signal?: AbortSignal) => Promise<boolean>;

/** Builds the runner for a Claude session — swapped for a fake in tests (no live query()). */
export type RunnerFactory = (opts: ClaudeRunnerOpts) => ClaudeSessionRunner;

/** Stand the kill switch down while the user answers something. EVERY notch prompt during a
 *  computer task needs his cursor/keys, so reaching Approve must not itself abort the task
 *  (live demo: the browser host confirm died to the tap the moment he moved the mouse —
 *  only the handoff path had the bracket). Counter, not boolean: the model can issue
 *  parallel tool calls whose confirms overlap, and the first to resolve must not re-arm
 *  the tap under the one still pending. Re-arms on throw; one task drives at a time, so a
 *  single counter per task is enough. */
export function makeStandDown(bridge: Pick<MacBridge, 'setHandoff'>) {
  let pending = 0;
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    pending += 1;
    bridge.setHandoff(true);
    try {
      return await fn();
    } finally {
      pending -= 1;
      if (pending === 0) bridge.setHandoff(false);
    }
  };
}

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
   *  default web/writing agent. M8: `replay` runs a saved procedure deterministically
   *  first — the loop becomes its drift fallback, and a successful fallback run
   *  SELF-HEALS the procedure (version+1 via healProcedure). */
  spawnSubagent(
    title: string,
    brief: string,
    taskType: SubagentKind = 'research',
    replay?: { procedure: Procedure; notes: string | null; unattended?: boolean },
  ): TaskRow {
    if (taskType === 'mac' && !this.macBridge) throw new Error('Mac control is unavailable (no shell bridge wired).');
    if (taskType === 'mac') this.assertMacFree();
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
    // ALL of a computer task's notch prompts (risky-script confirms, browser host
    // approvals, submit gates, the handoff itself) ride standDown: answering a prompt
    // takes the user's mouse, so the kill switch must treat that input as the answer, not
    // an abort. Deny on timeout / no shell as always; research tasks pass undefined.
    const standDown = taskType === 'mac' ? makeStandDown(this.macBridge!) : undefined;
    const unattended = replay?.unattended === true;
    // M8 unattended PARK bracket: while a routine waits on the user, the task is NOT
    // driving — the tap DISARMS (mac_task refcount) instead of standing down. Holding
    // setHandoff(true) for an hour-scale window would suppress the kill switch while
    // the user uses his Mac normally, then resume driving under his hands on timeout-deny
    // (the reviewed inversion). Re-arm happens on answer; the shell's arm-time grace
    // covers his trailing input from clicking Approve.
    const park = unattended
      ? async <T>(fn: () => Promise<T>): Promise<T> => {
          this.macBridge!.taskFinished();
          try {
            return await fn();
          } finally {
            this.macBridge!.taskStarted();
          }
        }
      : undefined;
    const bracket = unattended ? park! : standDown!;
    // M7: the browser lane labels its own confirms via the optional title param.
    // M8 unattended: every would-be-confirm PAUSES the task (needs_input + routine.paused
    // + pulse via index.ts) with the long window + park-for-shell; deny-on-timeout stays —
    // NOTHING is ever auto-approved in absentia.
    const confirmScript =
      taskType === 'mac'
        ? (detail: string, confirmTitle = 'Allow this Mac script?', rememberHost?: string) => {
            const req: EscalationRequest = unattended
              ? { title: confirmTitle, detail, rememberHost, timeoutMs: config.routines.pauseTimeoutMs, waitForShell: true }
              : { title: confirmTitle, detail, rememberHost };
            if (!unattended) return bracket(() => this.escalate(id, title, req, abort.signal));
            return this.pauseForAnswer(id, detail, () => bracket(() => this.escalate(id, title, req, abort.signal)));
          }
        : undefined;
    // M7 cooperative handoff: pause (needs_input announces it aloud), stand the kill
    // switch down so the user's own typing IS the handoff, wait for his notch "Done"
    // (generous window, deny-on-timeout), then re-arm and resume. Status restore skips
    // a task that finished/cancelled while paused.
    const requestHandoff =
      taskType === 'mac'
        ? async (reason: string) => {
            this.setTaskStatus(id, 'needs_input', reason);
            if (unattended) this.store.addEvent(id, 'routine.paused', { reason });
            // the user closing the automation browser mid-handoff IS his answer (live-demo
            // polish): decline promptly (confirm_cancel dismisses the notch panel) instead
            // of letting the prompt linger to its multi-minute timeout. Local controller:
            // fires on task abort OR browser close, and never aborts the task itself.
            const local = new AbortController();
            const onTaskAbort = () => local.abort();
            abort.signal.addEventListener('abort', onTaskAbort, { once: true });
            const unsubBrowser = getBrowserClient().onContextClosed(() => local.abort());
            try {
              // M8 unattended: handoffs get the pause semantics too (long window +
              // park-for-shell) — a login wall at 6 AM waits for the user, one clean pause,
              // instead of a 5-minute deny into an empty room.
              return await bracket(() => this.escalate(
                id, title,
                {
                  title: 'Your turn — tap Done when finished', detail: reason,
                  timeoutMs: unattended ? config.routines.pauseTimeoutMs : config.mac.handoffTimeoutMs,
                  confirmLabel: 'Done', denyLabel: 'Cancel',
                  ...(unattended ? { waitForShell: true } : {}),
                },
                local.signal,
              ));
            } finally {
              unsubBrowser();
              abort.signal.removeEventListener('abort', onTaskAbort);
              // Restore 'running' only if the task is still live. On a kill-switch/cancel
              // DURING the handoff, cancelComputerTasks has already finished the task
              // ('cancelled', first-writer-wins) — both guards skip the restore, so the
              // bubble/dashboard never flickers running→cancelled (🟡).
              if (!this.finished.has(id) && !abort.signal.aborted) this.setTaskStatus(id, 'running', 'handoff finished');
            }
          }
        : undefined;
    // Two-arg then(): the rejection handler sees ONLY runSubagent errors, so a failure
    // while writing the report (success path) can't be mislabeled 'cancelled'/'failed'.
    runSubagent({
      taskId: id, brief, store: this.store, signal: abort.signal, kind: taskType,
      macBridge: this.macBridge, confirmScript, requestHandoff,
      takeSteering: taskType === 'mac' ? () => this.takeSteering(id) : undefined,
      procedure: replay
        ? { procedure: replay.procedure, notes: replay.notes, steeringPending: () => this.hasSteering(id), unattended }
        : undefined,
    }).then(
      (report) => {
        this.finishWithReport(id, title, workspace, report);
        if (replay) this.healAfterFallback(id, replay.procedure.name);
      },
      (err: unknown) => {
        this.finish(id, abort.signal.aborted ? 'cancelled' : 'failed', { error: String(err) });
      },
    );
    return task;
  }

  /** M8 self-heal: a replay that DRIFTED but whose fallback loop then finished 'done'
   *  becomes the procedure's next version (this run's trace recompiles). Best-effort and
   *  after the announce — a heal failure must never touch the task's own outcome. */
  private healAfterFallback(taskId: string, procedureName: string) {
    if (!this.healProcedure) return;
    const replayEvent = this.store.getLatestEventPayload(taskId, 'procedure.replay') as { outcome?: string } | null;
    if (replayEvent?.outcome !== 'fallback') return;
    if (this.store.getTask(taskId)?.status !== 'done') return;
    // A TAUGHT procedure is the user's ground-truth demonstration — never let an auto-heal silently
    // overwrite it with a drifted/adapted run. Spurious drift (e.g. Notes auto-formatting a typed
    // "- " into a bullet, which the loop misread as failure) was corrupting freshly-taught lists
    // down to a single item, every replay. Heal only a non-taught version; update a taught one by
    // re-teaching.
    if (this.store.getProcedure(procedureName)?.provider === 'taught') {
      this.store.addEvent(taskId, 'procedure.heal_skipped', { name: procedureName, reason: 'latest version is taught — ground truth, re-teach to change it' });
      return;
    }
    this.healProcedure(procedureName, taskId).then(
      (result) => this.store.addEvent(taskId, 'procedure.healed', result),
      (err: unknown) => this.store.addEvent(taskId, 'session.error', { message: `procedure heal failed: ${String(err)}` }),
    );
  }

  /** M8 Phase 3 seam, wired in index.ts → procedures.saveFromTask(taskId, name, 'healed'). */
  healProcedure?: (name: string, taskId: string) => Promise<{ name: string; version: number; stepCount: number }>;

  /** Peek (no drain) — the replay engine bails to the full loop on queued steering; only
   *  the loop's wrapped tools may consume it. */
  hasSteering(id: string): boolean {
    return (this.steering.get(id)?.length ?? 0) > 0;
  }

  /** M8 unattended pause bookkeeping: needs_input (spoken + pulsed via index.ts) +
   *  routine.paused (the away-items surface) around the parked confirm; status restores
   *  on answer unless the task ended meanwhile. */
  private async pauseForAnswer(id: string, reason: string, run: () => Promise<boolean>): Promise<boolean> {
    this.setTaskStatus(id, 'needs_input', `paused unattended: ${reason}`);
    this.store.addEvent(id, 'routine.paused', { reason });
    try {
      return await run();
    } finally {
      if (!this.finished.has(id) && !this.aborts.get(id)?.signal.aborted) {
        this.setTaskStatus(id, 'running', 'answered');
      }
    }
  }

  // ——— M8 scheduled routines: fire → queue → spawn (or skip LOUDLY) ———
  private routineQueue: Array<{ name: string; firstTriedAt: number }> = [];
  private routineRetryTimer: NodeJS.Timeout | null = null;
  /** Loud-skip seam (Law 5: never a silent skip) — wired in index.ts to a spoken/pulsed
   *  notification; the routine.skipped event is the durable record either way. */
  onRoutineSkipped: (name: string, reason: string) => void = () => {};

  /** A routine schedule row fired. NEVER throws — the row is already marked fired, so an
   *  exception here would be a silently lost occurrence (onFire errors are swallowed
   *  into session.error). KNOWN procedures only, validated at fire time. */
  runRoutine(row: { id: string; text: string }) {
    try {
      const payload = JSON.parse(row.text) as { procedure?: string };
      const name = typeof payload.procedure === 'string' ? payload.procedure.trim() : '';
      if (!name) {
        this.skipRoutine(row.id, 'the routine row carries no procedure name');
        return;
      }
      this.routineQueue.push({ name, firstTriedAt: Date.now() });
      this.drainRoutineQueue();
    } catch (err) {
      this.skipRoutine(row.id, `unreadable routine payload: ${String(err)}`);
    }
  }

  /** Start queued routines when the Mac frees up — called on fire, on every task finish,
   *  and on a retry timer while blocked. A routine that can't start inside the window is
   *  skipped WITH notice. Public so tests drive it without timers. */
  drainRoutineQueue() {
    while (this.routineQueue.length > 0) {
      const item = this.routineQueue[0];
      if (Date.now() - item.firstTriedAt > config.routines.queueWindowMs) {
        this.routineQueue.shift();
        this.skipRoutine(item.name, 'the Mac stayed busy past the retry window');
        continue;
      }
      const row = this.store.getProcedure(item.name);
      if (!row) {
        this.routineQueue.shift();
        this.skipRoutine(item.name, 'no saved procedure by that name');
        continue;
      }
      let procedure: Procedure | null = null;
      try {
        procedure = validateProcedure(JSON.parse(row.body), row.name);
      } catch { /* fall through to the guard below */ }
      if (!procedure) {
        this.routineQueue.shift();
        this.skipRoutine(item.name, 'the saved procedure failed validation');
        continue;
      }
      try {
        this.spawnSubagent(
          row.name,
          `Scheduled routine: replay of the saved procedure "${row.name}" (v${row.version}). Goal: ${procedure.goal}. ` +
            'This run is UNATTENDED — the user may not be at the Mac. Anything that needs his answer pauses and waits; never improvise around a pause.',
          'mac',
          { procedure, notes: null, unattended: true },
        );
        this.routineQueue.shift();
        this.store.addEvent(null, 'routine.started', { name: row.name, version: row.version });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/already driving the Mac/.test(message)) {
          this.scheduleRoutineRetry(); // busy — keep it queued, try again shortly
          return;
        }
        this.routineQueue.shift();
        this.skipRoutine(item.name, message);
      }
    }
  }

  private scheduleRoutineRetry() {
    if (this.routineRetryTimer) return;
    this.routineRetryTimer = setTimeout(() => {
      this.routineRetryTimer = null;
      this.drainRoutineQueue();
    }, config.routines.retryIntervalMs);
    this.routineRetryTimer.unref();
  }

  private skipRoutine(name: string, reason: string) {
    this.store.addEvent(null, 'routine.skipped', { name, reason });
    try {
      this.onRoutineSkipped(name, reason);
    } catch { /* announce is best-effort; the event is the durable record */ }
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
    // M8: a computer task's image-save may have snapshotted the user's clipboard (preserve_clipboard
    // 'save') before a Copy-Image and not yet restored it. Restore on GENUINE task end here — NOT on
    // the shell's mac_task active:false, which an unattended park also fires (refcount 1→0→1) and
    // would evict the just-copied image mid-save. Idempotent (no-op if already restored or nothing
    // snapshotted); fire-and-forget so finish() stays synchronous for the kill-switch label race.
    if (task?.kind === 'computer') this.macBridge?.request?.({ kind: 'clipboard_restore' }, { timeoutMs: 2000 })?.catch(() => {});
    // M8: a finished computer task may unblock a queued routine — try now, off this tick
    // (finish() must stay synchronous for the kill-switch label race).
    if (this.routineQueue.length > 0) setImmediate(() => this.drainRoutineQueue());
  }

  /** One computer task at a time: there is ONE screen/keyboard — concurrent tasks fight
   *  over the same apps (live demo: three overlapping wallpaper tasks drove System
   *  Settings against each other). Same spirit as assertCwdFree for Claude sessions.
   *  M8: a teaching session registers as a kind:'computer' task row, so this one scan
   *  covers task-vs-task, task-vs-teaching, and teaching-vs-task alike. */
  private assertMacFree() {
    for (const otherId of this.aborts.keys()) {
      const other = this.store.getTask(otherId);
      if (other?.kind === 'computer') {
        throw new Error(`a computer-use task ("${other.title}") is already driving the Mac; wait for it to finish or cancel it first`);
      }
    }
  }

  // ——— M8 watch-me teaching ———
  // A teach session is a REAL kind:'computer' task row with no runner: the one-task rule
  // covers both directions for free, cancelComputerTasks (kill switch) reaches it, the
  // boot reaper closes a recording that died with the daemon, and stop rides
  // finishWithReport → the existing announce path.
  private teaching: {
    taskId: string; name: string; title: string; workspace: string;
    steps: TeachStep[]; timer: NodeJS.Timeout; stopping?: boolean;
  } | null = null;

  /** M8 Phase 2 seam, wired in index.ts to the procedure compiler. When present,
   *  stopTeaching distills the demonstration before the task finishes (ONE announce
   *  carries both); absent (tests), the raw step report lands alone. Returns the report
   *  tail; a rejection means "not saved" and is reported loudly, never swallowed. */
  distillProcedure?: (name: string, steps: TeachStep[], taskId: string, outcome: string | null) => Promise<string>;

  /** Begin recording a demonstration. Resolves once the shell's recorder is ARMED —
   *  fail-closed: if the tap can't arm, the teach task fails and this throws (never a
   *  silently un-recorded "recording"). */
  async startTeaching(name: string): Promise<TaskRow> {
    if (!this.macBridge) throw new Error('Mac control is unavailable (no shell bridge wired).');
    if (this.teaching) throw new Error(`already recording "${this.teaching.name}" — stop or cancel it first`);
    this.assertMacFree();
    const id = randomUUID().slice(0, 8);
    const workspace = join(config.home.tasks, id);
    mkdirSync(workspace, { recursive: true });
    const now = Date.now();
    const title = `Teaching: ${name}`;
    const task: TaskRow = { id, kind: 'computer', title, status: 'running', workspace, created_at: now, updated_at: now };
    this.store.createTask(task);
    this.store.addEvent(id, 'task.created', { title, brief: `watch-me demonstration: ${name}`, kind: 'computer', teaching: true });
    const abort = new AbortController();
    this.aborts.set(id, abort);
    // Abort = cancel (kill switch / voice cancel / dashboard): stop the shell recorder,
    // discard the steps, close the row. finish() may already have run
    // (cancelComputerTasks labels first) — it's idempotent.
    abort.signal.addEventListener('abort', () => {
      if (this.teaching?.taskId !== id) return;
      this.clearTeaching();
      this.finish(id, 'cancelled', { reason: 'teaching cancelled' });
    }, { once: true });
    const res = await this.macBridge.request({ kind: 'record_start' }, { signal: abort.signal });
    if (!res.ok) {
      this.finish(id, 'failed', { error: `recording could not start: ${res.output}` });
      throw new Error(`recording could not start: ${res.output}`);
    }
    const timer = setTimeout(() => {
      this.stopTeaching('time limit reached').catch((err: unknown) => {
        this.store.addEvent(id, 'session.error', { message: `teach auto-stop: ${String(err)}` });
      });
    }, config.teach.maxDurationMs);
    timer.unref();
    this.teaching = { taskId: id, name, title, workspace, steps: [], timer };
    this.macBridge.setTeaching(true, id); // id → the shell, so the teaching orb's click finishes it
    return task;
  }

  /** One demonstration step streamed from the shell's record-mode tap. Untrusted-shaped
   *  (hand-built Swift JSON) — sanitized here. Hitting the step cap stops the recording
   *  LOUDLY (Law 5: never silently truncate a demonstration). */
  teachEvent(raw: unknown) {
    const t = this.teaching;
    if (!t) return; // stale/late event after stop — wire noise, not a signal
    const step = sanitizeTeachStep(raw);
    if (!step) return;
    // Steps DO land while stopping: the shell's final typing-burst flush arrives between
    // the record_stop send and its ack — that window is the whole point of the ordering.
    t.steps.push(step);
    this.store.addEvent(t.taskId, 'teach.step', { step });
    if (!t.stopping && t.steps.length >= config.teach.maxSteps) {
      this.stopTeaching('step limit reached').catch((err: unknown) => {
        this.store.addEvent(t.taskId, 'session.error', { message: `teach auto-stop: ${String(err)}` });
      });
    }
  }

  /** End the recording and land its report (announce path included). Ordering is
   *  load-bearing: the shell flushes its pending typing burst BEFORE answering
   *  record_stop, and both ride the same socket — so by the time the ack resolves,
   *  every teach_event has already been ingested. Clear teaching only after. */
  async stopTeaching(note?: string): Promise<{ name: string; stepCount: number }> {
    const t = this.teaching;
    if (!t) throw new Error('no recording is active');
    if (t.stopping) throw new Error('the recording is already being stopped');
    t.stopping = true;
    clearTimeout(t.timer);
    await this.macBridge?.request({ kind: 'record_stop' });
    if (this.teaching !== t) throw new Error('the recording was cancelled');
    this.teaching = null;
    this.macBridge?.setTeaching(false);
    // Capture the demonstration's OUTCOME: the final document (full text + styled ranges)
    // of the app the user typed into. The compiler builds content from this observed RESULT
    // — corrections, undos, and caret wandering are already reflected in it, which the
    // keystroke stream can never reliably reconstruct. Best-effort: no readable document,
    // no section (the compiler falls back to the step stream alone).
    let outcome: string | null = null;
    let outcomeNote = '';
    const lastTextApp = [...t.steps].reverse().find((s) => s.kind === 'type' || s.kind === 'select_text')?.app;
    if (lastTextApp && this.macBridge) {
      const doc = await this.macBridge.request({ kind: 'document_state', app: lastTextApp });
      if (doc.ok) {
        outcome = doc.output;
        outcomeNote = `\n${doc.output}\n`;
      } else {
        // Law 5 — no silent negatives: a failed capture means the compiler falls back to
        // keystroke archaeology, which is materially worse. Say so in the report.
        outcomeNote = `\n(final-document capture FAILED: ${doc.output} — content compiled from the keystroke stream alone)\n`;
      }
    }
    const base = teachingReport(t.name, t.steps, note) + outcomeNote;
    if (this.distillProcedure && t.steps.length > 0) {
      // The task stays 'running' for the few seconds of compile; ONE announce then
      // carries the step list AND the saved-procedure summary (or the loud not-saved
      // note — the demonstration itself is never lost to a compile failure).
      this.distillProcedure(t.name, t.steps, t.taskId, outcome).then(
        (summary) => this.finishWithReport(t.taskId, t.title, t.workspace, `${base}\n${summary}`),
        (err: unknown) => this.finishWithReport(
          t.taskId, t.title, t.workspace,
          `${base}\nProcedure NOT saved — distillation failed: ${err instanceof Error ? err.message : String(err)}. ` +
            'The demonstration above is preserved; teach it again, or say "save that as a procedure" after Gumbo does it once itself.',
        ),
      );
    } else {
      this.finishWithReport(t.taskId, t.title, t.workspace, base);
    }
    return { name: t.name, stepCount: t.steps.length };
  }

  /** Discard an active recording (voice "never mind", shell disconnect). No-op false
   *  when nothing is recording. */
  cancelTeaching(_reason: string): boolean {
    const t = this.teaching;
    if (!t) return false;
    return this.cancel(t.taskId); // → abort → the listener clears state + finishes 'cancelled'
  }

  /** Tear down teaching state (cancel path). The shell-side stop is fire-and-forget
   *  here — the daemon's state is authoritative, and a shell that missed the stop gets
   *  mac_teach:false on its next hello (resync). */
  private clearTeaching() {
    const t = this.teaching;
    if (!t) return;
    clearTimeout(t.timer);
    this.teaching = null;
    this.macBridge?.setTeaching(false);
    void this.macBridge?.request({ kind: 'record_stop' });
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
      // Label 'cancelled' HERE, not in the runner's rejection path: the abort resolves a
      // pending notch confirm as a plain deny, which reaches the model as a normal tool
      // refusal — live demo: the loop survived the abort, wrote a farewell report, and
      // finishWithReport('done') won the label race. finish() is idempotent (first writer
      // wins), so the runner's own settlement no-ops afterward; its finally still tears
      // the browser down. This is what makes the kill switch a HARD stop, audibly and
      // in the store, the instant the user touches the machine.
      this.finish(id, 'cancelled', { reason: `kill_switch:${reason}` });
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

  /** True while any spawned task or teaching session is still in flight. The realtime session
   *  stays alive across this so a completion announces through the live, OWNING path — not the
   *  canned cold TTS, which can only read a fixed line and can't retry/fix a failure.
   *  Bounded, never a permanent leak: finish() always deletes the abort. Note the asymmetry — a
   *  mac task parked at needs_input (a handoff, or an unattended routine's long park) KEEPS its
   *  abort in the map, so it holds the session open; a parked Claude session drops its abort and
   *  does not. Both intended: a mac task is one screen the voice should stay present for. */
  hasActiveTasks(): boolean {
    return this.aborts.size > 0;
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
