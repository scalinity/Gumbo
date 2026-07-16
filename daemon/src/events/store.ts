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
      -- memory is INSERT-ONLY by design: memory_fts syncs via the AFTER INSERT trigger
      -- alone, so any future UPDATE/DELETE path must add companion triggers or the FTS
      -- index silently desyncs. No reader or retention policy yet (write-only until the
      -- recall feature lands) — add a pruning/VACUUM story before it grows unbounded.
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INT, task_id TEXT,
        kind TEXT CHECK(kind IN ('search_result','task_output')),
        provider TEXT, query TEXT, url TEXT, title TEXT, body TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, body, content='memory', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END;
      -- M4: Claude Code session ids persist so a session survives the daemon (tsx-watch
      -- restarts are constant) — send_to_session revives a dead task by resuming its
      -- session id in its original cwd with its original brief.
      CREATE TABLE IF NOT EXISTS claude_sessions (
        task_id TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, brief TEXT, updated_at INT
      );
    `);
  }

  saveClaudeSession(taskId: string, row: { sessionId: string; cwd: string; brief: string }) {
    this.db
      .prepare('INSERT OR REPLACE INTO claude_sessions (task_id, session_id, cwd, brief, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, row.sessionId, row.cwd, row.brief, Date.now());
  }

  getClaudeSession(taskId: string): { session_id: string; cwd: string; brief: string } | undefined {
    return this.db.prepare('SELECT session_id, cwd, brief FROM claude_sessions WHERE task_id = ?').get(taskId) as
      | { session_id: string; cwd: string; brief: string }
      | undefined;
  }

  /** Raw web-search results persisted verbatim (FTS5-indexed, rows never mutated). */
  saveSearchResult(row: {
    taskId: string | null;
    provider: string;
    query: string;
    url?: string;
    title?: string;
    body: string;
  }) {
    this.db
      .prepare("INSERT INTO memory (ts, task_id, kind, provider, query, url, title, body) VALUES (?, ?, 'search_result', ?, ?, ?, ?, ?)")
      .run(Date.now(), row.taskId, row.provider, row.query, row.url ?? null, row.title ?? null, row.body);
  }

  /** A finished task's synthesized output (the report), FTS5-indexed alongside its raw sources. */
  saveTaskOutput(taskId: string, title: string, body: string) {
    this.db
      .prepare("INSERT INTO memory (ts, task_id, kind, title, body) VALUES (?, ?, 'task_output', ?, ?)")
      .run(Date.now(), taskId, title, body);
  }

  /**
   * Reconcile tasks left in-flight when the daemon stopped. Their runners live only in
   * memory, so on restart (frequent under `tsx watch`) they'd otherwise stay 'running'
   * forever and Gumbo would report dead work as ongoing. Returns the reaped task ids.
   *
   * `needs_input` is deliberately NOT reaped: a Claude task parked at the supervisor
   * intervention cap is genuinely still waiting on the user, and resumes off `claude_sessions`
   * regardless of the daemon's lifetime — reaping it to 'failed' would make get_task_status
   * / the dashboard misreport a resumable task as failed (and the voice model answers from
   * those verbatim).
   */
  reapInterruptedTasks(): string[] {
    const rows = this.db
      .prepare("SELECT id FROM tasks WHERE status = 'running'")
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return [];
    this.db
      .prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE status = 'running'")
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
