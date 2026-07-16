import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { InputQueue, sandboxSettings, SANDBOX_MARKER } = await import('./claude-runner.ts');
const { config, secretFilePaths } = await import('../config.ts');

function content(msg: { message: { content: unknown } }): string {
  return typeof msg.message.content === 'string' ? msg.message.content : '';
}

test('InputQueue drains queued messages in order, then completes on close', async () => {
  const q = new InputQueue();
  assert.equal(q.push('a'), true);
  assert.equal(q.push('b'), true);
  q.close();
  assert.equal(q.push('c'), false, 'push after close is rejected (caller resumes instead)');
  const got: string[] = [];
  for await (const msg of q) got.push(content(msg));
  assert.deepEqual(got, ['a', 'b']);
});

test('InputQueue wakes a pending iterator when a message arrives later', async () => {
  const q = new InputQueue();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next(); // queue empty → parks on the wake promise
  q.push('x');
  const { value, done } = await pending;
  assert.equal(done, false);
  assert.equal(content(value as { message: { content: unknown } }), 'x');
  q.close();
});

test('sandboxSettings: fail-closed containment — workspace writable, escapes off, network default-deny', () => {
  const s = sandboxSettings('task-123');
  assert.equal(s.enabled, true);
  assert.equal(s.failIfUnavailable, true, 'refuse to run unconfined when Seatbelt is unavailable');
  assert.equal(s.allowUnsandboxedCommands, false, 'dangerouslyDisableSandbox must be ignored');
  assert.deepEqual(s.filesystem?.allowWrite, [join(config.home.tasks, 'task-123')]);
  assert.ok(!('network' in s), 'no allowedDomains configured → no network key → egress fully denied');
  assert.deepEqual(
    s.credentials?.files,
    secretFilePaths.map((path) => ({ path, mode: 'deny' })),
    'on-disk secrets (.env, ~/.claude) are read-denied inside the sandbox',
  );
});

test('sandboxSettings: configured allowedDomains open egress without mutating config', () => {
  const saved = config.claude.sandbox.allowedDomains;
  config.claude.sandbox.allowedDomains = ['github.com'];
  try {
    const s = sandboxSettings('t');
    assert.deepEqual(s.network?.allowedDomains, ['github.com']);
    s.network!.allowedDomains!.push('evil.example'); // settings are per-session copies
    assert.deepEqual(config.claude.sandbox.allowedDomains, ['github.com']);
  } finally {
    config.claude.sandbox.allowedDomains = saved;
  }
});

test('SANDBOX_MARKER matches the CLI fail-closed errors, not a report that mentions sandboxing', () => {
  // Exact phrasings extracted from the CLI (2.1.211) fail-closed paths.
  assert.ok(SANDBOX_MARKER.test('Sandbox required but unavailable: sandbox-exec not found. Set sandbox.failIfUnavailable=false to allow unsandboxed execution.'));
  assert.ok(SANDBOX_MARKER.test('failIfUnavailable is set — refusing to start without a working sandbox.'));
  // Same failure mode as the auth-marker review 🔴: a good run whose REPORT merely
  // discusses sandboxing must not be flagged (the runner only tests error text, but
  // the marker itself should still be narrow).
  assert.ok(!SANDBOX_MARKER.test('I added a sandbox config block and verified the sandbox is enabled.'));
});
