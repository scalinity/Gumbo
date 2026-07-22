import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the JSONL ledger (config.home.logs) from the real ~/Gumbo before modules load.
process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { config } = await import('../config.ts');
const { Store } = await import('../events/store.ts');
const { initUsageRecorder, recordUsage, recordPriced, recordAgentsRunUsage } = await import('./recorder.ts');

const ledgerPath = join(config.home.logs, 'usage.jsonl');
// A preset GUMBO_HOME (the sandboxed-run workflow) can carry a ledger from a prior suite
// run — clear it so the no-op assertion below is rerun-proof (review 🟡).
rmSync(ledgerPath, { force: true });

test('uninitialized recorder is a silent no-op (never throws)', () => {
  recordUsage({ provider: 'openai', kind: 'realtime_turn', costUsd: 0.01 });
  assert.ok(!existsSync(ledgerPath));
});

test('initialized recorder lands a sqlite row AND a JSONL ledger line', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-usage-')), 'gumbo.db'));
  initUsageRecorder(store);
  recordUsage({
    provider: 'grok',
    model: 'grok-4.5',
    kind: 'x_search',
    taskId: 't1',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.0005,
    detail: { tool_calls: 2 },
  });
  const rows = store.usageByDay('2000-01-01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'grok');
  assert.equal(rows[0].input_tokens, 100);
  const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]) as { provider: string; detail: string };
  assert.equal(last.provider, 'grok');
  assert.equal(JSON.parse(last.detail).tool_calls, 2);
});

test('a throwing store is caught — the provider call must survive', () => {
  initUsageRecorder({ insertUsage: () => { throw new Error('disk gone'); } } as never);
  recordUsage({ provider: 'openai', kind: 'tts_announce', costUsd: 0.001 });
});

test('recordAgentsRunUsage aggregates rawResponses and skips empty runs', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-usage2-')), 'gumbo.db'));
  initUsageRecorder(store);
  recordAgentsRunUsage(
    [
      { usage: { inputTokens: 1000, outputTokens: 200, inputTokensDetails: { cached_tokens: 400 } } },
      { usage: { inputTokens: 500, outputTokens: 100 } },
      {},
    ],
    { kind: 'subagent_run', model: 'gpt-5.6-terra', taskId: 't2' },
  );
  recordAgentsRunUsage([{}], { kind: 'subagent_run', model: 'gpt-5.6-terra' }); // nothing reported → no row
  const rows = store.usageByDay('2000-01-01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'subagent_run');
  // uncached input = 1500 − 400 cached
  assert.equal(rows[0].input_tokens, 1100);
  assert.equal(rows[0].cached_tokens, 400);
  assert.equal(rows[0].output_tokens, 300);
  assert.equal(rows[0].model, 'gpt-5.6-terra');
});

test('recordPriced merges pricing detail with caller detail, caller winning', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-usage3-')), 'gumbo.db'));
  initUsageRecorder(store);
  recordPriced(
    { costUsd: 0.01, inputTokens: 10, outputTokens: 5, cachedTokens: 0, detail: { tool_calls: 2, source: 1 } },
    { provider: 'grok', model: 'grok-4.5', kind: 'x_search', detail: { source: 9 } },
  );
  const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
  const detail = JSON.parse(JSON.parse(lines[lines.length - 1]).detail) as { tool_calls: number; source: number };
  assert.equal(detail.tool_calls, 2);
  assert.equal(detail.source, 9);
});
