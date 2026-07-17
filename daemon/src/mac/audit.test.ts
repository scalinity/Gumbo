import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-file temp home (house convention): `npm test -w daemon` runs each file in its own
// process, so this file is the sole writer of its mac-audit.jsonl and the absolute
// line-count assertions below are deterministic — same pattern as search/audit.test.ts.
process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { auditMacAction } = await import('./audit.ts');
const { config } = await import('../config.ts');

const auditPath = join(config.home.logs, 'mac-audit.jsonl');
const lines = () => readFileSync(auditPath, 'utf8').trim().split('\n');

test('one parseable JSONL line per action — executions, failures, AND declines', () => {
  auditMacAction({ tier: 'hot', kind: 'script', action: 'open -a "Google Chrome" https://claude.ai', gate: 'auto', ok: true });
  auditMacAction({ tier: 'subagent', kind: 'act', action: 'press [e7] button "New Note"', gate: 'auto', ok: false, error: 'stale_ref', taskId: 't1' });
  auditMacAction({ tier: 'hot', kind: 'script', action: 'sudo rm -rf /tmp/x', gate: 'declined', ok: false });
  const all = lines();
  assert.equal(all.length, 3);
  const exec = JSON.parse(all[0]);
  assert.equal(exec.ok, true);
  assert.equal(exec.tier, 'hot');
  assert.ok(exec.ts, 'timestamp present');
  const failed = JSON.parse(all[1]);
  assert.equal(failed.error, 'stale_ref');
  assert.equal(failed.taskId, 't1');
  const declined = JSON.parse(all[2]);
  assert.equal(declined.gate, 'declined');
  assert.equal(declined.ok, false);
});

test('a newline in the script cannot forge an extra audit line', () => {
  auditMacAction({
    tier: 'hot',
    kind: 'script',
    action: 'echo hi\n{"ts":"1970-01-01","tier":"forged","ok":true}',
    gate: 'auto',
    ok: true,
  });
  const all = lines();
  assert.equal(all.length, 4); // still exactly one line per call
  const entry = JSON.parse(all[3]);
  assert.match(entry.action, /forged/); // content preserved, escaped — not a separate record
  assert.equal(entry.tier, 'hot');
});

test('audit failure is swallowed, never thrown at the caller', () => {
  const original = config.home.logs;
  // Point the log dir at an impossible path (a *file* as parent) to force the write to fail.
  (config.home as { logs: string }).logs = join(auditPath, 'not-a-dir');
  try {
    assert.doesNotThrow(() =>
      auditMacAction({ tier: 'hot', kind: 'script', action: 'x', gate: 'auto', ok: false }),
    );
  } finally {
    (config.home as { logs: string }).logs = original;
  }
});
