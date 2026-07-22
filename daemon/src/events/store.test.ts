import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { Store } = await import('./store.ts');

const dbPath = join(mkdtempSync(join(tmpdir(), 'gumbo-store-')), 'gumbo.db');
const store = new Store(dbPath);
// Second connection for raw assertions — WAL mode supports concurrent readers.
const raw = new DatabaseSync(dbPath);

test('saveSearchResult round-trips through the FTS index', () => {
  store.saveSearchResult({
    taskId: 't1',
    provider: 'exa',
    query: 'solid state batteries',
    url: 'https://example.test/a',
    title: 'Battery manufacturing report',
    body: 'dendrites remain the hard problem at scale',
  });
  const hits = raw
    .prepare(
      "SELECT m.task_id, m.kind, m.title FROM memory_fts f JOIN memory m ON m.id = f.rowid WHERE memory_fts MATCH 'dendrites'",
    )
    .all() as Array<{ task_id: string; kind: string; title: string }>;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].task_id, 't1');
  assert.equal(hits[0].kind, 'search_result');
  assert.equal(hits[0].title, 'Battery manufacturing report');
});

test('saveTaskOutput lands as task_output and is FTS-matchable', () => {
  store.saveTaskOutput('t2', 'Research brief', 'the synthesized xylophone conclusion');
  const hits = raw
    .prepare(
      "SELECT m.task_id, m.kind FROM memory_fts f JOIN memory m ON m.id = f.rowid WHERE memory_fts MATCH 'xylophone'",
    )
    .all() as Array<{ task_id: string; kind: string }>;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].task_id, 't2');
  assert.equal(hits[0].kind, 'task_output');
});

test('CHECK constraint rejects unknown memory kinds', () => {
  assert.throws(() =>
    raw.prepare("INSERT INTO memory (ts, task_id, kind, body) VALUES (1, 't', 'bogus', 'x')").run(),
  );
});

test('claude session ids round-trip and upsert (M4 resume across restarts)', () => {
  store.saveClaudeSession('t9', { sessionId: 'sess-1', cwd: '/w/t9', brief: 'do the thing' });
  // Spread: node:sqlite rows have a null prototype, which fails deepEqual vs a literal.
  assert.deepEqual({ ...store.getClaudeSession('t9') }, { session_id: 'sess-1', cwd: '/w/t9', brief: 'do the thing' });
  // Resumes create a fresh session id for the same task — the latest one must win.
  store.saveClaudeSession('t9', { sessionId: 'sess-2', cwd: '/w/t9', brief: 'do the thing\n\nFollow-up from the user: more' });
  assert.equal(store.getClaudeSession('t9')?.session_id, 'sess-2');
  assert.equal(store.getClaudeSession('missing'), undefined);
});

test('nullable columns accept missing url/title/provider', () => {
  store.saveSearchResult({ taskId: null, provider: 'exa', query: 'q', body: 'highlight-only body' });
  const row = raw
    .prepare("SELECT url, title, task_id FROM memory WHERE body = 'highlight-only body'")
    .get() as { url: null; title: null; task_id: null };
  assert.equal(row.url, null);
  assert.equal(row.title, null);
  assert.equal(row.task_id, null);
});

// getTaskBrief answers "what was that task doing?" from the task.created payload alone —
// it must survive missing tasks and brief-less payloads with a clean null, never a throw.
test('getTaskBrief returns the brief from the task.created payload', () => {
  store.addEvent('tb1', 'task.created', { title: 'Spec', brief: 'Write the harness spec' });
  store.addEvent('tb1', 'claude.message', { text: 'noise after it' }); // must not confuse the lookup
  assert.equal(store.getTaskBrief('tb1'), 'Write the harness spec');
});

test('getTaskBrief is null for a task with no task.created event', () => {
  assert.equal(store.getTaskBrief('never-created'), null);
});

test('getTaskBrief is null when task.created carries no brief field', () => {
  store.addEvent('tb2', 'task.created', { title: 'No brief here' });
  assert.equal(store.getTaskBrief('tb2'), null);
});

test('recentTranscripts stitches user/assistant lines oldest-first with roles mapped', () => {
  store.addEvent(null, 'transcript.user', { text: 'hello gumbo' });
  store.addEvent(null, 'transcript.assistant', { text: 'hi the user' });
  const lines = store.recentTranscripts(0).map((l) => `${l.role}:${l.text}`);
  assert.deepEqual(lines, ['user:hello gumbo', 'assistant:hi the user']);
});

const usageBase = {
  ts: 1_700_000_000_000,
  task_id: null,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
  units: 0,
  cost_usd: 0,
  billed: 1 as const,
  estimated: 0 as const,
  detail: null,
};

test('usageByDay groups by (day, provider, model, kind, billed) and sums the columns', () => {
  store.insertUsage({ ...usageBase, day: '2026-07-20', provider: 'openai', model: 'gpt-realtime-2.1', kind: 'realtime_turn', input_tokens: 100, output_tokens: 50, cached_tokens: 10, cost_usd: 0.01 });
  store.insertUsage({ ...usageBase, day: '2026-07-20', provider: 'openai', model: 'gpt-realtime-2.1', kind: 'realtime_turn', input_tokens: 200, output_tokens: 100, cached_tokens: 20, cost_usd: 0.02 });
  store.insertUsage({ ...usageBase, day: '2026-07-20', provider: 'anthropic', model: 'claude-opus-4-8', kind: 'claude_result', billed: 0, input_tokens: 5000, cost_usd: 0.5 });
  store.insertUsage({ ...usageBase, day: '2026-07-21', provider: 'openai', model: 'gpt-realtime-2.1', kind: 'realtime_turn', input_tokens: 7, cost_usd: 0.001 });
  const rows = store.usageByDay('2026-07-20');
  const realtime20 = rows.find((r) => r.day === '2026-07-20' && r.kind === 'realtime_turn');
  assert.ok(realtime20);
  assert.equal(realtime20.calls, 2);
  assert.equal(realtime20.input_tokens, 300);
  assert.equal(realtime20.cached_tokens, 30);
  assert.ok(Math.abs(realtime20.cost_usd - 0.03) < 1e-9);
  // billed=0 Claude row stays its own group — the dashboard splits billed vs equivalent on it.
  const claude = rows.find((r) => r.provider === 'anthropic');
  assert.ok(claude && claude.billed === 0 && claude.calls === 1);
  // ordered by day, and the from filter is inclusive
  assert.deepEqual([...new Set(rows.map((r) => r.day))], ['2026-07-20', '2026-07-21']);
});

test('usageByDay from filter excludes earlier days', () => {
  store.insertUsage({ ...usageBase, day: '2026-06-01', provider: 'tavily', model: null, kind: 'search', units: 1, cost_usd: 0.008, estimated: 1 });
  const rows = store.usageByDay('2026-07-01');
  assert.ok(!rows.some((r) => r.day === '2026-06-01'));
});

// ——— M8 procedure memory ———

test('M8: saveProcedure versions insert-only; getProcedure resolves the latest', () => {
  const v1 = store.saveProcedure({ taskId: 'p1', name: 'file expenses', title: 'file expenses — submit the monthly report', body: '{"v":1}', provider: 'taught' });
  const v2 = store.saveProcedure({ taskId: 'p2', name: 'file expenses', title: 'file expenses — submit the monthly report', body: '{"v":2}', provider: 'healed' });
  assert.equal(v1, 1);
  assert.equal(v2, 2);
  const latest = store.getProcedure('file expenses');
  assert.equal(latest?.version, 2);
  assert.equal(latest?.provider, 'healed');
  assert.equal(latest?.body, '{"v":2}');
  // Both versions persist as rows (insert-only — the FTS trigger never sees an UPDATE).
  const count = raw.prepare("SELECT COUNT(*) AS n FROM memory WHERE kind = 'procedure' AND query = 'file expenses'").get() as { n: number };
  assert.equal(count.n, 2);
});

test('M8: searchProcedures matches by goal words and resolves latest versions, deduped', () => {
  store.saveProcedure({ taskId: null, name: 'water plants', title: 'water plants — log the weekly watering in the garden app', body: '{}', provider: 'taught' });
  const hits = store.searchProcedures('weekly watering garden');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].name, 'water plants');
  // A query matching an OLD version's title still resolves to the latest row.
  const stale = store.searchProcedures('monthly report expenses');
  assert.ok(stale.some((h) => h.name === 'file expenses' && h.version === 2), 'must resolve to the latest version');
  // FTS syntax can't be smuggled through user phrasing.
  assert.doesNotThrow(() => store.searchProcedures('weird "quoted OR NEAR( tokens'));
  assert.deepEqual(store.searchProcedures('   '), []);
});

test('M8: listProcedures returns one latest row per name', () => {
  const names = store.listProcedures().map((p) => `${p.name}@${p.version}`);
  assert.ok(names.includes('file expenses@2'));
  assert.ok(names.includes('water plants@1'));
  assert.ok(!names.includes('file expenses@1'), 'stale versions never listed');
});

// The migration is the riskiest Phase-2 piece: an OLD-schema DB (no 'procedure' kind, no
// version column) must rebuild once, preserving rows + ids AND a working FTS index.
test('M8: pre-M8 memory table is rebuilt once — rows/ids preserved, FTS reindexed, procedures insertable', () => {
  const oldPath = join(mkdtempSync(join(tmpdir(), 'gumbo-migrate-')), 'gumbo.db');
  const old = new DatabaseSync(oldPath);
  old.exec(`
    CREATE TABLE memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INT, task_id TEXT,
      kind TEXT CHECK(kind IN ('search_result','task_output')),
      provider TEXT, query TEXT, url TEXT, title TEXT, body TEXT
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(title, body, content='memory', content_rowid='id');
    CREATE TRIGGER memory_fts_insert AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
    INSERT INTO memory (ts, task_id, kind, provider, query, url, title, body)
      VALUES (1, 'old1', 'search_result', 'exa', 'q', 'https://x.test', 'Old title', 'archaeopteryx feathers');
    INSERT INTO memory (ts, task_id, kind, title, body)
      VALUES (2, 'old2', 'task_output', 'Old report', 'the quetzal conclusion');
  `);
  old.close();

  const migrated = new Store(oldPath);
  const raw2 = new DatabaseSync(oldPath);
  // Rows and ids survived; the version column exists (null for old rows).
  const rows = raw2.prepare('SELECT id, kind, version FROM memory ORDER BY id').all() as Array<{ id: number; kind: string; version: number | null }>;
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.version]), [[1, 'search_result', null], [2, 'task_output', null]]);
  // FTS was rebuilt — old rows still match.
  const hit = raw2.prepare("SELECT m.id FROM memory_fts f JOIN memory m ON m.id = f.rowid WHERE memory_fts MATCH 'archaeopteryx'").all();
  assert.equal(hit.length, 1);
  // Procedures now insert (widened CHECK) and the FTS trigger works post-rebuild.
  migrated.saveProcedure({ taskId: null, name: 'migrated proc', title: 'migrated proc — do the thing', body: '{}', provider: 'taught' });
  const procHit = raw2.prepare("SELECT m.id FROM memory_fts f JOIN memory m ON m.id = f.rowid WHERE memory_fts MATCH 'migrated'").all();
  assert.equal(procHit.length, 1);
  // AUTOINCREMENT continued past the copied ids (no id reuse).
  const proc = migrated.getProcedure('migrated proc');
  assert.ok(proc && proc.id > 2, 'new rows must not reuse migrated ids');
  // Reopening again is a no-op (idempotent migration).
  const again = new Store(oldPath);
  assert.equal(again.getProcedure('migrated proc')?.version, 1);
});

test('M8: schedule table gains recurrence/series_id additively (old DBs migrate, new rows carry them)', () => {
  // The main-store DB in this file was created with the NEW schema; prove an OLD-schema
  // schedule table migrates too.
  const oldPath = join(mkdtempSync(join(tmpdir(), 'gumbo-sched-migrate-')), 'gumbo.db');
  const old = new DatabaseSync(oldPath);
  old.exec(`
    CREATE TABLE schedule (
      id TEXT PRIMARY KEY, fire_at INT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','fired','cancelled')),
      eventkit_id TEXT, created_at INT NOT NULL
    );
    INSERT INTO schedule VALUES ('old1', 123, 'reminder', 'water plants', 'pending', NULL, 1);
  `);
  old.close();
  const store2 = new Store(oldPath);
  const migrated = store2.getSchedule('old1');
  assert.ok(migrated);
  assert.equal(migrated.recurrence ?? null, null, 'old rows read null recurrence');
  store2.createSchedule({
    id: 'new1', fire_at: 456, kind: 'routine', text: '{"procedure":"x"}', status: 'pending',
    eventkit_id: null, created_at: 2, recurrence: '{"freq":"daily","hour":9,"minute":0}', series_id: 'new1',
  });
  assert.equal(store2.getSchedule('new1')?.recurrence, '{"freq":"daily","hour":9,"minute":0}');
});

test('M8: eventsSince + latestPayloadOf drive the away-items watermark', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'gumbo-away-')), 'gumbo.db');
  const s = new Store(dbPath);
  s.addEvent(null, 'routine.skipped', { name: 'a', reason: 'busy' });
  const marker = s.addEvent(null, 'announce.consumed', { upTo: 999 });
  s.addEvent(null, 'routine.paused', { reason: 'confirm' });
  s.addEvent('t9', 'announce.pending', { title: 'Late task' });
  assert.deepEqual(s.latestPayloadOf('announce.consumed'), { upTo: 999 });
  const since = s.eventsSince(['routine.skipped', 'routine.paused', 'announce.pending'], marker.seq);
  assert.deepEqual(since.map((e) => e.type), ['routine.paused', 'announce.pending'], 'only items after the watermark, oldest first');
  assert.deepEqual(s.eventsSince([], 0), [], 'empty type list is a no-op');
});

test('M8 fix: the memory_kind_query index exists on fresh DBs AND survives the rebuild migration', () => {
  const hasIndex = (db: InstanceType<typeof DatabaseSync>) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='memory_kind_query' AND tbl_name='memory'").all()).length === 1;
  assert.ok(hasIndex(raw), 'fresh DB carries the procedure-reader index');

  const oldPath = join(mkdtempSync(join(tmpdir(), 'gumbo-idx-migrate-')), 'gumbo.db');
  const old = new DatabaseSync(oldPath);
  old.exec(`
    CREATE TABLE memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INT, task_id TEXT,
      kind TEXT CHECK(kind IN ('search_result','task_output')),
      provider TEXT, query TEXT, url TEXT, title TEXT, body TEXT
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(title, body, content='memory', content_rowid='id');
    CREATE TRIGGER memory_fts_insert AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
  `);
  old.close();
  new Store(oldPath); // triggers the rebuild — the index must be recreated on the NEW table
  const raw3 = new DatabaseSync(oldPath);
  assert.ok(hasIndex(raw3), 'the rebuild migration must recreate the index (the rename carried the old one to memory_old and the drop killed it)');
});

test('M8: deleteProcedure removes all versions and keeps the FTS index consistent', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'gumbo-del-')), 'gumbo.db');
  const s = new Store(dbPath);
  s.saveProcedure({ taskId: null, name: 'packing list', title: 'packing list — draft in Notes', body: '{"v":1}', provider: 'taught' });
  s.saveProcedure({ taskId: null, name: 'packing list', title: 'packing list — draft in Notes', body: '{"v":2}', provider: 'healed' });
  s.saveProcedure({ taskId: null, name: 'file expenses', title: 'file expenses — submit', body: '{}', provider: 'taught' });
  assert.ok(s.getProcedure('packing list'));
  assert.ok(s.searchProcedures('packing').some((p) => p.name === 'packing list'), 'FTS finds it before delete');

  const removed = s.deleteProcedure('packing list');
  assert.equal(removed, 2, 'both versions deleted');
  assert.equal(s.getProcedure('packing list'), undefined, 'gone from the exact reader');
  assert.equal(s.searchProcedures('packing').length, 0, 'gone from the FTS index too (companion delete trigger)');
  assert.ok(s.getProcedure('file expenses'), 'other procedures untouched');

  assert.equal(s.deleteProcedure('never existed'), 0, 'deleting a missing procedure is a clean 0');
});
