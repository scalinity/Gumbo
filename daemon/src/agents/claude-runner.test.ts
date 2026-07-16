import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { InputQueue, buildSandboxProfile, sandboxUnavailableReason } = await import('./claude-runner.ts');
const { config, secretFilePaths } = await import('../config.ts');
const { homedir } = await import('node:os');

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

test('buildSandboxProfile: confines writes to cwd + workspace, denies secret reads', () => {
  const taskId = 'profile-task';
  const workspace = join(config.home.tasks, taskId);
  mkdirSync(workspace, { recursive: true });
  const cwd = realpathSync(config.home.tasks); // any real dir stands in for the project cwd
  const p = buildSandboxProfile(cwd, taskId);
  const home = homedir();

  assert.match(p, /^\(version 1\)/, 'valid SBPL header');
  assert.match(p, /\(allow default\)/, 'allow-default base keeps the CLI functional (network, keychain)');
  assert.match(p, /\(deny file-write\*\)/, 'deny-all writes then re-allow the boundary');
  // cwd + the (symlink-resolved) workspace are writable.
  assert.ok(p.includes(`(allow file-write* (subpath ${JSON.stringify(cwd)}))`), 'cwd writable');
  assert.ok(p.includes(`(allow file-write* (subpath ${JSON.stringify(realpathSync(workspace))}))`), 'workspace writable (canonicalized)');
  // The CLI's own runtime dirs must stay writable or checkpointing/undo breaks.
  assert.ok(p.includes(JSON.stringify(realpathSync(join(home, '.claude')))), '~/.claude writable (checkpoints)');
  // Package-manager caches must stay writable so installs work like an interactive session.
  assert.ok(p.includes('(allow file-write*') && p.includes(JSON.stringify(realpathSync(join(home, 'Library', 'Caches')))), '~/Library/Caches writable (tool caches)');
  // Secret reads denied — .env (repo provider keys) plus ~/.ssh, ~/.aws.
  assert.ok(p.includes(`(deny file-read* (subpath ${JSON.stringify(secretFilePaths[0])}))`), '.env read-denied');
  assert.ok(p.includes(JSON.stringify(join(home, '.ssh'))) && p.includes(JSON.stringify(join(home, '.aws'))), 'ssh/aws read-denied');
  // ~/.claude is NOT read-denied at the OS level (the CLI needs its own state) — that path
  // is covered by the supervisor policy hard-deny of the Read tool instead.
  assert.ok(!p.includes(`(deny file-read* (subpath ${JSON.stringify(realpathSync(join(home, '.claude')))}))`), '~/.claude stays OS-readable');

  // review 🔴: the code-exec/persistence surfaces under the (writable) ~/.claude are re-denied
  // AFTER the allow, and the deny must come after so last-match-wins takes it.
  const claudeDir = realpathSync(join(home, '.claude'));
  const settingsDeny = `(deny file-write* (subpath ${JSON.stringify(join(claudeDir, 'settings.json'))}))`;
  assert.ok(p.includes(settingsDeny), '~/.claude/settings.json write-denied (no unsandboxed hook injection)');
  assert.ok(p.includes(JSON.stringify(join(claudeDir, 'hooks'))) && p.includes(JSON.stringify(join(claudeDir, 'plugins'))), '~/.claude hooks/plugins write-denied');
  assert.ok(p.indexOf('(allow file-write* (subpath ' + JSON.stringify(claudeDir)) < p.indexOf(settingsDeny), 'the exec-surface deny comes AFTER the ~/.claude allow (last-match-wins)');
  assert.ok(!p.includes(`(allow file-write* (literal ${JSON.stringify(join(home, '.claude.json'))}))`), '~/.claude.json write-allow dropped (persistence surface)');

  // review 🔴: credential dotfiles beyond .env/.ssh/.aws are read-denied (exfil over open net).
  for (const cred of [join(home, '.config', 'gh'), join(home, '.npmrc'), join(home, '.netrc'), join(home, '.docker', 'config.json'), join(home, '.gnupg')]) {
    assert.ok(p.includes(`(deny file-read* (subpath ${JSON.stringify(cred)}))`), `${cred} read-denied`);
  }

  // review 🟡: the load-bearing ordering invariant — deny-all-writes precedes the allows.
  assert.ok(p.indexOf('(deny file-write*)') < p.indexOf('(allow file-write* (subpath'), 'deny-all-writes precedes the allowlist');
});

test('buildSandboxProfile: rejects empty cwd/taskId (would open all writes)', () => {
  assert.throws(() => buildSandboxProfile('', 't'), /non-empty/);
  assert.throws(() => buildSandboxProfile('/x', ''), /non-empty/);
});

test('sandboxUnavailableReason: null on macOS with sandbox-exec, else a reason (fail-closed)', () => {
  const reason = sandboxUnavailableReason();
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    assert.equal(reason, null, 'available on macOS with sandbox-exec');
  } else {
    assert.equal(typeof reason, 'string', 'a non-null reason drives the fail-closed throw');
  }
});
