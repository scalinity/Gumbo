import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TaskRow {
  id: string;
  kind: 'subagent' | 'claude' | 'computer';
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

// M5: one row per scheduled action. `kind` is the extensibility seam — M8 shipped its
// designed second consumer, kind:'routine' (text = {"procedure": name} JSON). `text` is
// the kind's payload.
export interface ScheduleRow {
  id: string;
  fire_at: number; // epoch-ms
  kind: string;
  text: string;
  status: 'pending' | 'fired' | 'cancelled';
  eventkit_id: string | null; // Reminders.app twin, set when the shell replies reminder_created (reminders only — routines have no twin)
  created_at: number;
  /** M8 recurrence DSL (JSON, schedule/recurrence.ts) — null for one-shots. On fire, a
   *  recurring row marks fired and INSERTS the next pending occurrence (chain-of-rows:
   *  preserves mark-fired-before-deliver at-most-once; cancelling the pending row ends
   *  the chain). */
  recurrence: string | null;
  /** Stable identity across a recurring chain (the FIRST row's id) — display/history;
   *  cancellation targets the current pending row. */
  series_id: string | null;
}

// M8: one saved procedure VERSION. Insert-only versioning by design: an update is a NEW
// row with version+1 (the memory table's FTS sync trigger is AFTER INSERT only — updates
// would silently desync the index), and recall always resolves the latest version.
export interface ProcedureRow {
  id: number;
  ts: number;
  task_id: string | null;
  /** memory.query — the exact recall key. */
  name: string;
  version: number;
  /** How this version came to be: demonstrated, saved from a run, or replay self-healing. */
  provider: 'taught' | 'saved' | 'healed';
  /** "name — goal" (FTS-indexed alongside the body). */
  title: string;
  /** Procedure JSON (agents/procedures.ts owns the schema + guard). */
  body: string;
}

const PROCEDURE_COLS = 'id, ts, task_id, query AS name, version, provider, title, body';

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
      -- recentTranscripts filters type IN (…) AND ts ≥ — without this it scans the PK.
      CREATE INDEX IF NOT EXISTS events_type_ts ON events(type, ts);
      -- memory is INSERT-ONLY by design: memory_fts syncs via the AFTER INSERT trigger
      -- alone, so any future UPDATE/DELETE path must add companion triggers or the FTS
      -- index silently desyncs. M8 added kind 'procedure' (+ the version column) and the
      -- FIRST readers (getProcedure/searchProcedures) — procedure updates are new rows,
      -- version+1, never UPDATEs. Still no retention policy — add a pruning/VACUUM story
      -- before it grows unbounded. (Pre-M8 DBs are rebuilt once by migrateMemoryTable.)
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INT, task_id TEXT,
        kind TEXT CHECK(kind IN ('search_result','task_output','procedure')),
        provider TEXT, query TEXT, url TEXT, title TEXT, body TEXT, version INT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, body, content='memory', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END;
      -- The companion DELETE trigger the insert-only design deferred — deleteProcedure
      -- (procedure management) is the first delete path, so the external-content FTS index
      -- must be told or it desyncs. IF NOT EXISTS so DBs migrated before this get it on boot.
      CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
      END;
      -- M4: Claude Code session ids persist so a session survives the daemon (tsx-watch
      -- restarts are constant) — send_to_session revives a dead task by resuming its
      -- session id in its original cwd with its original brief.
      CREATE TABLE IF NOT EXISTS claude_sessions (
        task_id TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, brief TEXT, updated_at INT
      );
      -- M5: Gumbo-owned scheduler. Rows persist across restarts by design — the boot
      -- reaper only reconciles the tasks table and must never touch this one (a pending
      -- reminder outliving the daemon is the whole point). NOT NULLs match the row
      -- interface (review 🔵): a null fire_at would silently never match the due query.
      -- (CREATE IF NOT EXISTS doesn't retrofit constraints onto pre-existing dev DBs —
      -- fine here: all writers are typed, this hardens fresh DBs.)
      CREATE TABLE IF NOT EXISTS schedule (
        id TEXT PRIMARY KEY, fire_at INT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','fired','cancelled')),
        eventkit_id TEXT, created_at INT NOT NULL, recurrence TEXT, series_id TEXT
      );
      CREATE INDEX IF NOT EXISTS schedule_due ON schedule(status, fire_at);
    `);
    this.migrateMemoryTable();
    this.migrateScheduleColumns();
    // M8 procedure readers (getProcedure/saveProcedure/listProcedures) filter kind+query
    // on a table that grows unbounded with page-sized search bodies — without this they
    // full-scan on voice-latency paths (review 🟡). Created AFTER the migration: it
    // references the version column, which a pre-M8 table doesn't have yet (creating it
    // in the main exec block threw before the migration could run).
    this.db.exec('CREATE INDEX IF NOT EXISTS memory_kind_query ON memory(kind, query, version)');
  }

  /** M8 additive columns on a pre-M8 schedule table (ALTER ADD COLUMN is non-breaking —
   *  existing rows read null, `SELECT *` consumers ignore the extras). */
  private migrateScheduleColumns() {
    const cols = this.db.prepare('PRAGMA table_info(schedule)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'recurrence')) {
      this.db.exec('ALTER TABLE schedule ADD COLUMN recurrence TEXT');
    }
    if (!cols.some((c) => c.name === 'series_id')) {
      this.db.exec('ALTER TABLE schedule ADD COLUMN series_id TEXT');
    }
  }

  /**
   * M8 one-time rebuild of a pre-M8 memory table: the kind CHECK must admit 'procedure'
   * and the version column must exist, but CREATE IF NOT EXISTS never retrofits either
   * onto an existing DB. External-content FTS5 makes the order load-bearing: the trigger
   * drops FIRST (a rename re-parses trigger bodies against the already-dropped FTS
   * table), the copy uses an EXPLICIT column list (SELECT * would silently miscopy
   * against the new column), and the FTS 'rebuild' re-tokenizes at the end. Explicit-id
   * copy re-seeds sqlite_sequence, so AUTOINCREMENT continues where it left off.
   */
  private migrateMemoryTable() {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'memory' AND type = 'table'")
      .get() as { sql?: string } | undefined;
    const sql = row?.sql ?? '';
    if (sql.includes("'procedure'") && /\bversion\b/.test(sql)) return;
    // Re-tokenizing every row is synchronous boot work (bodies are full page texts) —
    // one line so a slow boot after upgrading is explicable, not mysterious.
    console.log('store: one-time memory-table rebuild for M8 procedures (FTS re-index included)');
    this.transaction(() => {
      this.db.exec(`
        DROP TRIGGER IF EXISTS memory_fts_insert;
        DROP TRIGGER IF EXISTS memory_fts_delete;
        DROP TABLE IF EXISTS memory_fts;
        ALTER TABLE memory RENAME TO memory_old;
        CREATE TABLE memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT, ts INT, task_id TEXT,
          kind TEXT CHECK(kind IN ('search_result','task_output','procedure')),
          provider TEXT, query TEXT, url TEXT, title TEXT, body TEXT, version INT
        );
        INSERT INTO memory (id, ts, task_id, kind, provider, query, url, title, body)
          SELECT id, ts, task_id, kind, provider, query, url, title, body FROM memory_old;
        DROP TABLE memory_old;
        CREATE VIRTUAL TABLE memory_fts USING fts5(title, body, content='memory', content_rowid='id');
        CREATE TRIGGER memory_fts_insert AFTER INSERT ON memory BEGIN
          INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
        END;
        CREATE TRIGGER memory_fts_delete AFTER DELETE ON memory BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
        END;
        INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');
      `);
    });
  }

  createSchedule(row: ScheduleRow) {
    this.db
      .prepare('INSERT INTO schedule (id, fire_at, kind, text, status, eventkit_id, created_at, recurrence, series_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.fire_at, row.kind, row.text, row.status, row.eventkit_id, row.created_at, row.recurrence ?? null, row.series_id ?? null);
  }

  getSchedule(id: string): ScheduleRow | undefined {
    return this.db.prepare('SELECT * FROM schedule WHERE id = ?').get(id) as unknown as ScheduleRow | undefined;
  }

  /** Due work for the poll loop: pending rows whose fire time has passed (oldest first). */
  duePendingSchedules(now: number): ScheduleRow[] {
    return this.db
      .prepare("SELECT * FROM schedule WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at")
      .all(now) as unknown as ScheduleRow[];
  }

  /** Upcoming first (soonest fire_at), then past rows newest-first — the shape both the
   *  list_reminders tool and the dashboard list want. */
  listSchedules(limit = 100): ScheduleRow[] {
    return this.db
      .prepare(
        "SELECT * FROM schedule ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, CASE WHEN status = 'pending' THEN fire_at ELSE -fire_at END LIMIT ?",
      )
      .all(limit) as unknown as ScheduleRow[];
  }

  updateScheduleStatus(id: string, status: ScheduleRow['status']) {
    this.db.prepare('UPDATE schedule SET status = ? WHERE id = ?').run(status, id);
  }

  /** null clears the stored Reminders.app twin id (used once a removal was re-sent, so
   *  the re-send is itself one-shot). */
  setScheduleEventkitId(id: string, eventkitId: string | null) {
    this.db.prepare('UPDATE schedule SET eventkit_id = ? WHERE id = ?').run(eventkitId, id);
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

  /** M8: save one procedure VERSION (insert-only — see ProcedureRow). Returns the
   *  version just written; the first save of a name is v1. */
  saveProcedure(row: {
    taskId: string | null;
    name: string;
    title: string;
    body: string;
    provider: ProcedureRow['provider'];
  }): number {
    const cur = this.db
      .prepare("SELECT MAX(version) AS v FROM memory WHERE kind = 'procedure' AND query = ?")
      .get(row.name) as { v: number | null } | undefined;
    const version = (cur?.v ?? 0) + 1;
    this.db
      .prepare("INSERT INTO memory (ts, task_id, kind, provider, query, title, body, version) VALUES (?, ?, 'procedure', ?, ?, ?, ?, ?)")
      .run(Date.now(), row.taskId, row.provider, row.name, row.title, row.body, version);
    return version;
  }

  /** Latest version of an exactly-named procedure (the recall fast path). */
  getProcedure(name: string): ProcedureRow | undefined {
    return this.db
      .prepare(`SELECT ${PROCEDURE_COLS} FROM memory WHERE kind = 'procedure' AND query = ? ORDER BY version DESC LIMIT 1`)
      .get(name) as unknown as ProcedureRow | undefined;
  }

  /** Latest version of every saved procedure, newest-first. */
  listProcedures(limit = 50): ProcedureRow[] {
    return this.db
      .prepare(
        `SELECT ${PROCEDURE_COLS} FROM memory m WHERE kind = 'procedure' AND version = (
           SELECT MAX(version) FROM memory WHERE kind = 'procedure' AND query = m.query
         ) ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit) as unknown as ProcedureRow[];
  }

  /** M8 procedure management: delete a saved procedure by name (ALL its versions). The
   *  AFTER DELETE trigger keeps memory_fts consistent. Returns how many rows were removed
   *  (0 = no such procedure). */
  deleteProcedure(name: string): number {
    const result = this.db.prepare("DELETE FROM memory WHERE kind = 'procedure' AND query = ?").run(name);
    return Number(result.changes);
  }

  /** M8 recall — the memory table's FIRST reader. FTS over title+body (any version may
   *  match; each hit resolves to its name's LATEST version), ranked, deduped. Tokens are
   *  quoted so user phrasing can't smuggle FTS5 syntax. */
  searchProcedures(query: string, limit = 3): ProcedureRow[] {
    const tokens = query
      .split(/\s+/)
      .map((t) => t.replace(/"/g, ''))
      .filter(Boolean)
      .slice(0, 8)
      .map((t) => `"${t}"`);
    if (tokens.length === 0) return [];
    const hits = this.db
      .prepare(
        `SELECT m.query AS name FROM memory_fts f JOIN memory m ON m.id = f.rowid
         WHERE m.kind = 'procedure' AND memory_fts MATCH ? ORDER BY rank LIMIT 20`,
      )
      .all(tokens.join(' OR ')) as Array<{ name: string }>;
    const seen = new Set<string>();
    const out: ProcedureRow[] = [];
    for (const { name } of hits) {
      if (seen.has(name)) continue;
      seen.add(name);
      const latest = this.getProcedure(name);
      if (latest) out.push(latest);
      if (out.length >= limit) break;
    }
    return out;
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

  /** Synchronous transaction (node:sqlite is sync, so fn must be too). Rolls back on
   *  throw. Used where two writes must land together — e.g. the scheduler's
   *  mark-fired + reminder.fired event, so a crash can't consume a fire without its
   *  audit trace (review 🔵). */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

  /** Recent voice-conversation lines (oldest first) for session continuity: a new realtime
   *  session is otherwise amnesiac after the 60 s idle close or a tsx-watch daemon restart
   *  (live failure 2026-07-16 — "did you just forget everything I said?"). */
  recentTranscripts(sinceMs: number, limit = 80): Array<{ ts: number; role: 'user' | 'assistant'; text: string }> {
    const rows = this.db
      .prepare(
        "SELECT ts, type, payload FROM events WHERE type IN ('transcript.user','transcript.assistant') AND ts >= ? ORDER BY seq DESC LIMIT ?",
      )
      .all(sinceMs, limit) as Array<{ ts: number; type: string; payload: string }>;
    return rows.reverse().map((r) => ({
      ts: r.ts,
      role: r.type === 'transcript.user' ? 'user' as const : 'assistant' as const,
      text: (JSON.parse(r.payload) as { text?: string } | null)?.text ?? '',
    }));
  }

  /** M8 away-items: newest payload of an event type regardless of task scoping —
   *  getLatestEventPayload is task-keyed, and the announce.consumed marker is global. */
  latestPayloadOf(type: string): unknown {
    const row = this.db
      .prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1')
      .get(type) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }

  /** M8 away-items: events of the given types strictly after a seq, oldest first. */
  eventsSince(types: string[], afterSeq: number, limit = 50): EventRow[] {
    if (types.length === 0) return [];
    const placeholders = types.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE type IN (${placeholders}) AND seq > ? ORDER BY seq LIMIT ?`)
      .all(...types, afterSeq, limit) as Array<Omit<EventRow, 'payload'> & { payload: string }>;
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  /** Newest event payload of one type for a task, by direct SQL — a bounded listEvents
   *  window can miss it on a chatty task (e.g. the claude.plan behind get_task_status). */
  getLatestEventPayload(taskId: string, type: string): unknown {
    const row = this.db
      .prepare('SELECT payload FROM events WHERE task_id = ? AND type = ? ORDER BY seq DESC LIMIT 1')
      .get(taskId, type) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }

  /** The brief a task was created with (task.created payload) — survives cancellation and
   *  daemon restarts, so the voice agent can always answer "what was that task doing?". */
  getTaskBrief(taskId: string): string | null {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'task.created' ORDER BY seq LIMIT 1")
      .get(taskId) as { payload: string } | undefined;
    if (!row) return null;
    const brief = (JSON.parse(row.payload) as { brief?: string } | null)?.brief;
    return typeof brief === 'string' && brief ? brief : null;
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
