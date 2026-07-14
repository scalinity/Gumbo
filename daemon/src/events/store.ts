import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TaskRow {
  id: string;
  kind: 'subagent' | 'claude';
  title: string;
  status: 'running' | 'needs_input' | 'done' | 'failed' | 'cancelled';
  workspace: string;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  seq: number;
  ts: number;
  task_id: string | null;
  type: string;
  payload: unknown;
}

type EventListener = (event: EventRow) => void;

export class Store {
  private db: DatabaseSync;
  private listeners: EventListener[] = [];

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, kind TEXT, title TEXT,
        status TEXT CHECK(status IN ('running','needs_input','done','failed','cancelled')),
        workspace TEXT, created_at INT, updated_at INT
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INT, task_id TEXT,
        type TEXT, payload TEXT
      );
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
    `);
  }

  /**
   * Reconcile tasks left in-flight when the daemon stopped. Their runners live only in
   * memory, so on restart (frequent under `tsx watch`) they'd otherwise stay 'running'
   * forever and Gumbo would report dead work as ongoing. Returns the reaped task ids.
   */
  reapInterruptedTasks(): string[] {
    const rows = this.db
      .prepare("SELECT id FROM tasks WHERE status IN ('running','needs_input')")
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return [];
    this.db
      .prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE status IN ('running','needs_input')")
      .run(Date.now());
    for (const { id } of rows) this.addEvent(id, 'task.finished', { status: 'failed', error: 'interrupted by daemon restart' });
    return rows.map((r) => r.id);
  }

  onEvent(listener: EventListener) {
    this.listeners.push(listener);
  }

  addEvent(taskId: string | null, type: string, payload: unknown): EventRow {
    const ts = Date.now();
    const result = this.db
      .prepare('INSERT INTO events (ts, task_id, type, payload) VALUES (?, ?, ?, ?)')
      .run(ts, taskId, type, JSON.stringify(payload ?? null));
    const event: EventRow = { seq: Number(result.lastInsertRowid), ts, task_id: taskId, type, payload };
    for (const listener of this.listeners) listener(event);
    return event;
  }

  listEvents(opts: { taskId?: string; beforeSeq?: number; limit?: number } = {}): EventRow[] {
    const limit = Math.min(opts.limit ?? 200, 1000);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.taskId) {
      clauses.push('task_id = ?');
      params.push(opts.taskId);
    }
    if (opts.beforeSeq) {
      clauses.push('seq < ?');
      params.push(opts.beforeSeq);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...params, limit) as Array<Omit<EventRow, 'payload'> & { payload: string }>;
    return rows.reverse().map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  createTask(task: TaskRow) {
    this.db
      .prepare('INSERT INTO tasks (id, kind, title, status, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(task.id, task.kind, task.title, task.status, task.workspace, task.created_at, task.updated_at);
  }

  updateTaskStatus(id: string, status: TaskRow['status']) {
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
  }

  listTasks(limit = 100): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as TaskRow[];
  }
}
