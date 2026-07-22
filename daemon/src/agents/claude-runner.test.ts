import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { InputQueue, buildSandboxProfile, sandboxUnavailableReason, ClaudeRunner, claudeUsageDeltas } = await import('./claude-runner.ts');
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

// Plan capture (2026-07-16): current CLIs call ExitPlanMode with EMPTY input and persist
// the plan to ~/.claude/plans instead — the runner captures that Write's content as the
// fallback so the approval prompt shows a real plan, never "{}".
test('handlePlan prefers inline plan text, falls back to the captured plan-file write', async () => {
  const surfaced: string[] = [];
  const recorded: string[] = [];
  const make = () =>
    new ClaudeRunner({
      taskId: 't', brief: 'b', persistBrief: 'b', cwd: '/x',
      store: {
        addEvent: (_taskId: unknown, type: string, payload: { plan?: string }) => {
          if (type === 'claude.plan' && payload.plan) recorded.push(payload.plan);
        },
      } as never,
      supervisor: {} as never,
      onPlanReady: async (plan: string) => {
        surfaced.push(plan);
        return false; // decline → park path; approval mechanics aren't under test here
      },
    }) as unknown as { handlePlan(input: Record<string, unknown>): Promise<unknown>; planFileContent: string | null };

  const withInline = make();
  withInline.planFileContent = '# from the plan file';
  await withInline.handlePlan({ plan: '# inline plan' });

  const emptyInput = make();
  emptyInput.planFileContent = '# from the plan file';
  await emptyInput.handlePlan({});

  assert.deepEqual(surfaced, ['# inline plan', '# from the plan file'], 'the user is shown the real plan in both shapes');
  assert.deepEqual(recorded, surfaced, 'the claude.plan event records what was surfaced');
});

test('subprocessEnv strips provider keys AND credential-shaped names, keeps runtime vars (scan MEDIUM)', async () => {
  const { subprocessEnv } = await import('./claude-runner.ts');
  process.env.OPENAI_API_KEY = 'sk-listed';
  process.env.GH_TOKEN = 'ghp-unlisted';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws-unlisted';
  process.env.MY_APP_PASSWORD = 'pw';
  process.env.DATABASE_URL = 'postgres://u:pw@host/db';
  process.env.HARMLESS_FLAG = 'on';
  try {
    const env = subprocessEnv();
    assert.equal(env.OPENAI_API_KEY, undefined, 'named provider key stripped');
    assert.equal(env.GH_TOKEN, undefined, 'TOKEN-shaped name stripped');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, 'SECRET-shaped name stripped');
    assert.equal(env.MY_APP_PASSWORD, undefined, 'PASSW-shaped name stripped');
    assert.equal(env.DATABASE_URL, undefined, 'inline-credential URL stripped');
    assert.equal(env.HARMLESS_FLAG, 'on', 'non-credential vars survive');
    assert.equal(env.HOME, process.env.HOME, 'runtime vars the CLI needs survive');
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const k of ['OPENAI_API_KEY', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'MY_APP_PASSWORD', 'DATABASE_URL', 'HARMLESS_FLAG']) delete process.env[k];
  }
});

test('buildSandboxProfile: confines writes to cwd + workspace, denies secret reads', () => {
  const taskId = 'profile-task';
  const workspace = join(config.home.tasks, taskId);
  mkdirSync(workspace, { recursive: true });
  const cwd = realpathSync(config.home.tasks); // any real dir stands in for the project cwd
  const p = buildSandboxProfile(cwd, taskId, 49152);
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

  // M4.1 network default-deny: deny all direct egress, re-allow ONLY loopback to the proxy.
  assert.ok(p.includes('(deny network*)'), 'all direct network denied');
  assert.ok(p.includes('(allow network-outbound (remote ip "localhost:49152"))'), 'loopback to the proxy port re-allowed');
  // review 🔴: DNS must be forced through the proxy — deny the mDNSResponder mach ports so
  // getaddrinfo can't bypass the proxy (the DNS-label exfil channel). And the blanket
  // unix-socket egress allow is dropped (local-network-bridge exposure).
  assert.ok(p.includes('(deny mach-lookup (global-name "com.apple.mDNSResponder"))'), 'mDNSResponder mach-lookup denied (no DNS bypass)');
  assert.ok(p.includes('(deny mach-lookup (global-name "com.apple.mDNSResponder.dnsproxy"))'), 'mDNSResponder dnsproxy denied');
  assert.ok(!p.includes('(allow network-outbound (remote unix-socket))'), 'blanket unix-socket egress allow dropped');
  assert.ok(!p.includes('network-bind'), 'no network-bind allow (grants nothing usable under deny-inbound + proxy-only outbound)');
  // last-match-wins: deny-network must come AFTER (allow default), and the loopback re-allow
  // AFTER the deny — otherwise the proxy would be unreachable and every request would fail.
  assert.ok(p.indexOf('(allow default)') < p.indexOf('(deny network*)'), 'deny-network overrides allow-default');
  assert.ok(p.indexOf('(deny network*)') < p.indexOf('(allow network-outbound (remote ip "localhost:49152"))'), 'loopback re-allow comes after deny-network');
});

test('buildSandboxProfile: rejects empty cwd/taskId or a bad proxy port (would open all writes / break egress)', () => {
  assert.throws(() => buildSandboxProfile('', 't', 49152), /non-empty/);
  assert.throws(() => buildSandboxProfile('/x', '', 49152), /non-empty/);
  assert.throws(() => buildSandboxProfile('/x', 't', 0), /proxyPort/);
  assert.throws(() => buildSandboxProfile('/x', 't', NaN), /proxyPort/);
});

test('sandboxUnavailableReason: null on macOS with sandbox-exec, else a reason (fail-closed)', () => {
  const reason = sandboxUnavailableReason();
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    assert.equal(reason, null, 'available on macOS with sandbox-exec');
  } else {
    assert.equal(typeof reason, 'string', 'a non-null reason drives the fail-closed throw');
  }
});

test('claudeUsageDeltas: cumulative result messages record only the not-yet-recorded remainder', () => {
  const recorded = new Map();
  // Turn 1: opus 1000in/200out + a haiku subagent.
  const first = claudeUsageDeltas(
    {
      modelUsage: {
        'claude-opus-4-8': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 5000, cacheCreationInputTokens: 100, costUSD: 0.05 },
        'claude-haiku-4-5': { inputTokens: 300, outputTokens: 50, costUSD: 0.001 },
      },
    },
    recorded,
  );
  assert.equal(first.length, 2);
  assert.deepEqual(first[0], { model: 'claude-opus-4-8', delta: { in: 1000, out: 200, read: 5000, write: 100, cost: 0.05 } });
  // Turn 2: opus totals GREW (cumulative), haiku unchanged → only the opus delta lands.
  const second = claudeUsageDeltas(
    {
      modelUsage: {
        'claude-opus-4-8': { inputTokens: 1500, outputTokens: 350, cacheReadInputTokens: 9000, cacheCreationInputTokens: 100, costUSD: 0.08 },
        'claude-haiku-4-5': { inputTokens: 300, outputTokens: 50, costUSD: 0.001 },
      },
    },
    recorded,
  );
  const opus = second.find((e) => e.model === 'claude-opus-4-8');
  assert.ok(opus);
  assert.equal(opus.delta.in, 500);
  assert.equal(opus.delta.out, 150);
  assert.equal(opus.delta.read, 4000);
  assert.equal(opus.delta.write, 0);
  assert.ok(Math.abs(opus.delta.cost - 0.03) < 1e-9);
  const haiku = second.find((e) => e.model === 'claude-haiku-4-5');
  assert.deepEqual(haiku?.delta, { in: 0, out: 0, read: 0, write: 0, cost: 0 });
});

test('claudeUsageDeltas: snake_case usage fallback keys to a synthetic claude entry', () => {
  const recorded = new Map();
  const deltas = claudeUsageDeltas(
    { usage: { input_tokens: 800, output_tokens: 90, cache_read_input_tokens: 2000, cache_creation_input_tokens: 40 }, total_cost_usd: 0 },
    recorded,
  );
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].model, 'claude');
  assert.deepEqual(deltas[0].delta, { in: 800, out: 90, read: 2000, write: 40, cost: 0 });
});

test('claudeUsageDeltas: a null modelUsage entry value is skipped, never a throw', () => {
  const recorded = new Map();
  const deltas = claudeUsageDeltas(
    { modelUsage: { 'claude-opus-4-8': null as never, 'claude-haiku-4-5': { inputTokens: 10 } } },
    recorded,
  );
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].model, 'claude-haiku-4-5');
});
