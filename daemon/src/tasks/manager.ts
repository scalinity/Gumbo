import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { Store, TaskRow } from '../events/store.ts';
import { runSubagent } from '../agents/openai-runner.ts';

export class TaskManager {
  private aborts = new Map<string, AbortController>();
  private finished = new Set<string>();
  onFinished: (task: TaskRow) => void = () => {};

  constructor(private store: Store) {}

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
          this.store.saveTaskOutput(id, title, report); // searchable memory alongside the raw results
          this.finish(id, 'done', { report_path: `tasks/${id}/report.md` });
        } catch (err) {
          this.finish(id, 'failed', { error: `report write failed: ${String(err)}` });
        }
      },
      (err: unknown) => {
        this.finish(id, abort.signal.aborted ? 'cancelled' : 'failed', { error: String(err) });
      },
    );
    return task;
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
