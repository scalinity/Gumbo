import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { Store, TaskRow } from '../events/store.ts';
import { runSubagent } from '../agents/openai-runner.ts';
import { ClaudeRunner } from '../agents/claude-runner.ts';
import { Supervisor, type EscalationRequest } from '../agents/supervisor.ts';

/** Resolves the user's notch answer for a supervisor escalation (ws/confirm.ts in prod). */
export type EscalateFn = (taskId: string, taskTitle: string, req: EscalationRequest) => Promise<boolean>;

export class TaskManager {
  private aborts = new Map<string, AbortController>();
  private finished = new Set<string>();
  private claudeRunners = new Map<string, ClaudeRunner>();
  onFinished: (task: TaskRow) => void = () => {};

  constructor(
    private store: Store,
    private escalate: EscalateFn = async () => false, // no bridge (tests) → deny, fail safe
  ) {}

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
      (report) => {
        try {
          writeFileSync(join(workspace, 'report.md'), report);
        } catch (err) {
          this.finish(id, 'failed', { error: `report write failed: ${String(err)}` });
          return;
        }
        // Memory indexing is best-effort: once report.md is on disk the task succeeded,
        // and a sqlite hiccup here must never flip it to 'failed'.
        try {
          this.store.saveTaskOutput(id, title, report);
        } catch (err) {
          console.error(`task ${id}: memory index failed (task still done):`, err);
        }
        this.finish(id, 'done', { report_path: `tasks/${id}/report.md` });
      },
      (err: unknown) => {
        this.finish(id, abort.signal.aborted ? 'cancelled' : 'failed', { error: String(err) });
      },
    );
    return task;
  }

  /**
   * M4: a full Claude Code session as a background task. cwd is the named project when
   * the user gave one (the point of most sessions is editing a real repo), else the task
   * workspace; report.md + supervisor.md land in the workspace either way so the
   * announce/bubble pipeline works unchanged.
   */
  spawnClaudeSession(title: string, brief: string, projectDir?: string | null): TaskRow {
    const dir = projectDir?.trim();
    if (dir && !(existsSync(dir) && statSync(dir).isDirectory())) {
      throw new Error(`project_dir does not exist or is not a directory: ${dir}`);
    }
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
      escalate: (req) => this.escalate(task.id, task.title, req),
      setBlocked: (blocked) => {
        // Transient: the run itself continues the moment the user answers the confirm.
        if (this.finished.has(task.id)) return;
        this.setTaskStatus(task.id, blocked ? 'needs_input' : 'running', blocked ? 'awaiting notch confirm' : 'confirm answered');
      },
    });
    const runner = new ClaudeRunner({ taskId: task.id, brief, persistBrief: fullBrief, cwd, store: this.store, supervisor, resumeSessionId });
    this.claudeRunners.set(task.id, runner);
    this.aborts.set(task.id, runner.abort);

    runner.run().then(
      ({ parked, report }) => {
        this.claudeRunners.delete(task.id);
        this.writeSupervisorLog(supervisor, task);
        if (parked) {
          // Intervention cap: not finished, waiting on the user — send_to_session resumes.
          this.setTaskStatus(task.id, 'needs_input', 'supervisor intervention cap');
          return;
        }
        try {
          writeFileSync(join(task.workspace, 'report.md'), report || '(no report)');
        } catch (err) {
          this.finish(task.id, 'failed', { error: `report write failed: ${String(err)}` });
          return;
        }
        try {
          this.store.saveTaskOutput(task.id, task.title, report);
        } catch (err) {
          console.error(`task ${task.id}: memory index failed (task still done):`, err);
        }
        this.finish(task.id, 'done', { report_path: `tasks/${task.id}/report.md` });
      },
      (err: unknown) => {
        this.claudeRunners.delete(task.id);
        this.writeSupervisorLog(supervisor, task);
        this.finish(task.id, runner.abort.signal.aborted ? 'cancelled' : 'failed', { error: String(err) });
      },
    );
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
    this.store.updateTaskStatus(id, status);
    this.store.addEvent(id, 'task.finished', { status, ...(payload as object) });
    const task = this.store.getTask(id);
    if (task) this.onFinished(task);
  }

  cancel(id: string): boolean {
    const abort = this.aborts.get(id);
    if (!abort) return false;
    abort.abort();
    return true;
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
