import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-file temp home (house convention). This file counts mac-audit.jsonl lines via
// before/after deltas, and under the canonical per-file-process `npm test` it is the sole
// writer of its own home's audit file — same isolation the search-audit tests rely on.
process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { executeMacDo } = await import('./run.ts');
const { config } = await import('../config.ts');

const auditPath = join(config.home.logs, 'mac-audit.jsonl');
function auditLines() {
  return existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean) : [];
}
function lastAudit() {
  const lines = auditLines();
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

// A MacBridge stand-in: records the script actions it was asked to run.
function fakeBridge() {
  const calls: Array<{ interpreter?: string; script?: string }> = [];
  return {
    calls,
    request: async (action: { interpreter?: string; script?: string }) => {
      calls.push(action);
      return { ok: true, output: 'shell ran it' };
    },
  };
}

test('an auto (read-only) bash command runs daemon-side and audits gate=auto', async () => {
  const before = auditLines().length;
  let ranScript = '';
  const out = await executeMacDo('open -a "Notes"', 'bash', {
    macBridge: fakeBridge() as never,
    confirm: async () => false, // must NOT be consulted for an auto command
    runBash: async (script) => { ranScript = script; return { ok: true, output: 'opened' }; },
  });
  assert.equal(ranScript, 'open -a "Notes"', 'bash ran daemon-side');
  assert.match(out, /opened/);
  assert.equal(auditLines().length, before + 1, 'exactly one audit line');
  const entry = lastAudit();
  assert.equal(entry.gate, 'auto');
  assert.equal(entry.ok, true);
  assert.equal(entry.tier, 'hot');
});

test('a risky command DECLINED at the notch never executes but is still audited', async () => {
  const before = auditLines().length;
  let bashRan = false;
  const bridge = fakeBridge();
  const out = await executeMacDo('sudo rm -rf /var/tmp/x', 'bash', {
    macBridge: bridge as never,
    confirm: async () => false, // the user/timeout declines
    runBash: async () => { bashRan = true; return { ok: true, output: 'ran' }; },
  });
  assert.equal(bashRan, false, 'a declined command must not run');
  assert.equal(bridge.calls.length, 0, 'nor route to the shell');
  assert.match(out, /didn't approve/i);
  assert.equal(auditLines().length, before + 1, 'the refusal is still one audit line');
  assert.equal(lastAudit().gate, 'declined');
  assert.equal(lastAudit().ok, false);
});

test('a risky command APPROVED at the notch executes and audits gate=confirmed', async () => {
  let bashRan = false;
  const out = await executeMacDo('defaults write com.apple.dock autohide -bool true', 'bash', {
    macBridge: fakeBridge() as never,
    confirm: async () => true,
    runBash: async () => { bashRan = true; return { ok: true, output: '' }; },
  });
  assert.equal(bashRan, true);
  assert.match(out, /Done/);
  assert.equal(lastAudit().gate, 'confirmed');
});

test('osascript / shortcuts route to the shell, not daemon bash', async () => {
  const bridge = fakeBridge();
  let bashRan = false;
  await executeMacDo('tell application "System Events" to keystroke "x"', 'osascript', {
    macBridge: bridge as never,
    confirm: async () => false,
    runBash: async () => { bashRan = true; return { ok: true, output: '' }; },
  });
  assert.equal(bashRan, false, 'osascript never runs through daemon bash');
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].interpreter, 'osascript');
});

test('a failed execution surfaces the typed error and audits ok=false', async () => {
  const out = await executeMacDo('open -a "Nope"', 'bash', {
    macBridge: fakeBridge() as never,
    confirm: async () => false,
    runBash: async () => ({ ok: false, output: 'not found', errorKind: 'script_error' }),
  });
  assert.match(out, /failed \(script_error\)/);
  assert.equal(lastAudit().ok, false);
  assert.equal(lastAudit().error, 'script_error');
});

test('an empty command runs nothing and writes no audit line', async () => {
  const before = auditLines().length;
  const out = await executeMacDo('   ', 'bash', {
    macBridge: fakeBridge() as never,
    confirm: async () => false,
    runBash: async () => { throw new Error('should not run'); },
  });
  assert.match(out, /Empty command/);
  assert.equal(auditLines().length, before, 'no audit line for a no-op');
});
