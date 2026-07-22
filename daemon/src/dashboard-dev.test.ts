import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { ensureDashboardDevServer } = await import('./dashboard-dev.ts');

// The dashboard auto-start is dev-convenience glue: its ONE hard contract is that it can
// never take the daemon down and always honors the opt-out. With GUMBO_NO_DASHBOARD set
// it returns synchronously — no socket probe, no spawn — so this test is side-effect-free.
test('ensureDashboardDevServer honors GUMBO_NO_DASHBOARD and never throws', () => {
  const prev = process.env.GUMBO_NO_DASHBOARD;
  process.env.GUMBO_NO_DASHBOARD = '1';
  try {
    assert.doesNotThrow(() => ensureDashboardDevServer());
  } finally {
    if (prev === undefined) delete process.env.GUMBO_NO_DASHBOARD;
    else process.env.GUMBO_NO_DASHBOARD = prev;
  }
});
