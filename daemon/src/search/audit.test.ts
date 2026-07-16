import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { auditSearchCall } = await import('./audit.ts');
const { config } = await import('../config.ts');

const auditPath = join(config.home.logs, 'search-audit.jsonl');
const lines = () => readFileSync(auditPath, 'utf8').trim().split('\n');

test('writes one parseable JSONL line per call, including failures', () => {
  auditSearchCall({ provider: 'tavily', endpoint: '/search', query: 'ok query', resultCount: 5, ok: true });
  auditSearchCall({ provider: 'exa', endpoint: '/search', query: 'failed query', resultCount: 0, ok: false, error: 'quota' });
  const all = lines();
  assert.equal(all.length, 2);
  const success = JSON.parse(all[0]);
  assert.equal(success.ok, true);
  assert.equal(success.resultCount, 5);
  assert.ok(success.ts, 'timestamp present');
  const failure = JSON.parse(all[1]);
  assert.equal(failure.ok, false);
  assert.equal(failure.error, 'quota');
  assert.equal(failure.resultCount, 0);
});

test('a newline in the query cannot forge an extra audit line', () => {
  auditSearchCall({
    provider: 'exa',
    endpoint: '/search',
    query: 'line1\n{"ts":"1970-01-01","provider":"forged","ok":true}',
    resultCount: 1,
    ok: true,
  });
  const all = lines();
  assert.equal(all.length, 3); // still exactly one line per call
  const entry = JSON.parse(all[2]);
  assert.match(entry.query, /forged/); // content preserved, escaped — not a separate record
  assert.equal(entry.provider, 'exa');
});

test('audit failure is swallowed, never thrown at the caller', () => {
  const original = config.home.logs;
  // Point the log dir at an impossible path (a *file* as parent) to force the write to fail.
  (config.home as { logs: string }).logs = join(auditPath, 'not-a-dir');
  try {
    assert.doesNotThrow(() =>
      auditSearchCall({ provider: 'exa', endpoint: '/search', query: 'q', resultCount: 0, ok: false }),
    );
  } finally {
    (config.home as { logs: string }).logs = original;
  }
});
