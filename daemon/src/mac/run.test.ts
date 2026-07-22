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
const { normalizeOsascript } = await import('./policy.ts');
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
  // A genuine read-only bash command (NOT an app-open — those now route to the shell
  // resolver, see the routing test below).
  const out = await executeMacDo('defaults read -g AppleInterfaceStyle', 'bash', {
    macBridge: fakeBridge() as never,
    confirm: async () => false, // must NOT be consulted for an auto command
    runBash: async (script) => { ranScript = script; return { ok: true, output: 'Dark' }; },
  });
  assert.equal(ranScript, 'defaults read -g AppleInterfaceStyle', 'bash ran daemon-side');
  assert.match(out, /Dark/);
  assert.equal(auditLines().length, before + 1, 'exactly one audit line');
  const entry = lastAudit();
  assert.equal(entry.gate, 'auto');
  assert.equal(entry.ok, true);
  assert.equal(entry.tier, 'hot');
});

test('opening/focusing an app routes to the shell resolver (fuzzy + launch), not raw exec', async () => {
  // osascript `tell application "X" to activate` → the shell activate action.
  const bridge = fakeBridge();
  let bashRan = false;
  const out = await executeMacDo('tell application "ChatGPT" to activate', 'osascript', {
    macBridge: bridge as never,
    confirm: async () => false,
    runBash: async () => { bashRan = true; return { ok: true, output: '' }; },
  });
  const activate = bridge.calls.find((c) => (c as { kind?: string }).kind === 'activate');
  assert.ok(activate, 'a bare app-activate routes to the fuzzy resolver');
  assert.equal((activate as { app?: string }).app, 'ChatGPT', 'the app name (approximate) goes to the resolver');
  assert.match(out, /shell ran it/);

  // bash `open -a "X"` → same routing, NOT daemon-side bash.
  const bridge2 = fakeBridge();
  await executeMacDo('open -a "ChatGPT"', 'bash', {
    macBridge: bridge2 as never,
    confirm: async () => false,
    runBash: async () => { bashRan = true; return { ok: true, output: '' }; },
  });
  assert.ok(bridge2.calls.some((c) => (c as { kind?: string; app?: string }).kind === 'activate' && (c as { app?: string }).app === 'ChatGPT'));
  assert.equal(bashRan, false, 'a bare app-open never falls to daemon-side bash');

  // `open -a "X" <url>` is NOT a bare app-open (it opens a doc) — runs as bash, unchanged.
  const bridge3 = fakeBridge();
  let ran = '';
  await executeMacDo('open -a "Safari" https://example.com', 'bash', {
    macBridge: bridge3 as never,
    confirm: async () => false,
    runBash: async (s) => { ran = s; return { ok: true, output: 'ok' }; },
  });
  assert.equal(ran, 'open -a "Safari" https://example.com', 'open -a WITH a url is not a pure app-open');
  assert.equal(bridge3.calls.length, 0, 'not routed to the shell');
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
  const out = await executeMacDo('cat /no/such/file', 'bash', {
    macBridge: fakeBridge() as never,
    confirm: async () => false,
    runBash: async () => ({ ok: false, output: 'not found', errorKind: 'script_error' }),
  });
  assert.match(out, /failed \(script_error\)/);
  assert.equal(lastAudit().ok, false);
  assert.equal(lastAudit().error, 'script_error');
});

test('the REAL bash lane passes only the allowlisted env — unlisted secrets are gone (scan HIGH)', async () => {
  // No runBash override → exercises runBashDaemonSide's actual execFile + minimalEnv().
  process.env.OPENAI_API_KEY = 'sk-secret-should-not-leak';
  process.env.GITHUB_TOKEN = 'ghp-unlisted-secret'; // NOT in secretEnvKeys — the allowlist must drop it anyway
  try {
    const secret = await executeMacDo('printenv OPENAI_API_KEY || echo STRIPPED', 'bash', {
      macBridge: fakeBridge() as never,
      confirm: async () => false,
    });
    assert.match(secret, /STRIPPED/, 'the provider key must not be visible to the child');
    assert.doesNotMatch(secret, /sk-secret-should-not-leak/, 'the key value must never appear in output');
    const unlisted = await executeMacDo('printenv GITHUB_TOKEN || echo GONE', 'bash', {
      macBridge: fakeBridge() as never,
      confirm: async () => false,
    });
    assert.match(unlisted, /GONE/, 'a secret the denylist never named is dropped by the allowlist');
    assert.doesNotMatch(unlisted, /ghp-unlisted-secret/);
    const home = await executeMacDo('printenv HOME', 'bash', {
      macBridge: fakeBridge() as never,
      confirm: async () => false,
    });
    assert.match(home, /\//, 'bootstrap vars like HOME still reach the child');
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GITHUB_TOKEN;
  }
});

test('minimalEnv: allowlist + locale only — nothing else survives', async () => {
  const { minimalEnv } = await import('./run.ts');
  process.env.SOME_RANDOM_TOKEN = 'x';
  try {
    const env = minimalEnv();
    assert.equal(env.SOME_RANDOM_TOKEN, undefined);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    delete process.env.SOME_RANDOM_TOKEN;
  }
});

test('normalizeOsascript unwraps -e bodies; leaves plain AppleScript and odd forms alone (demo fix)', () => {
  assert.equal(
    normalizeOsascript(`osascript -e 'tell application "Google Chrome" to quit'`),
    'tell application "Google Chrome" to quit',
  );
  assert.equal(
    normalizeOsascript(`osascript -e 'set x to 1' -e 'return x'`),
    'set x to 1\nreturn x',
    'multiple -e chunks join as lines',
  );
  const plain = 'tell application "Notes" to activate';
  assert.equal(normalizeOsascript(plain), plain, 'plain AppleScript passes through');
  const file = 'osascript myscript.scpt';
  assert.equal(normalizeOsascript(file), file, 'a file invocation with no -e is left alone');
  assert.equal(normalizeOsascript('osascript -e "return 1"'), 'return 1', 'double-quoted -e body unwraps too');
});

test('a real maxBuffer overflow is classified script_error, never timeout (review 🟡 — the branch was dead)', async () => {
  // Real execFile, no runBash override: emit more than config.mac.outputMaxChars (256 KiB).
  const out = await executeMacDo('yes | head -c 400000', 'bash', {
    macBridge: fakeBridge() as never,
    confirm: async () => false,
  });
  assert.match(out, /failed \(script_error\)/, 'overflow is a script_error');
  assert.doesNotMatch(out, /Timed out/, 'must never be mislabeled a timeout');
});

test('the gate sees the UNWRAPPED osascript body — a double-wrapped risky script still confirms', async () => {
  const bridge = fakeBridge();
  let consulted = false;
  const out = await executeMacDo(`osascript -e 'tell application "Finder" to empty trash'`, 'osascript', {
    macBridge: bridge as never,
    confirm: async () => { consulted = true; return false; },
  });
  assert.equal(consulted, true, 'the risky class inside the wrapper must reach the confirm');
  assert.match(out, /didn't approve/i);
  assert.equal(bridge.calls.length, 0, 'declined — nothing reaches the shell');
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
