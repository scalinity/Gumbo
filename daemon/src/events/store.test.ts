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
