import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-runner-'));
const { needsHandoffBounce } = await import('./openai-runner.ts');

// The bounce trigger, pinned against the THREE verbatim login-shaped endings from the
// live demos (2026-07-20) — each took a different path (login form, sign-in redirect,
// signed-out homepage) to the same invalid ending.
test('needsHandoffBounce fires on all three live login-shaped endings', () => {
  const live = [
    'GitHub is not signed in in the current browser session. the user needs to sign in before I can read Notifications.',
    'GitHub redirected to its sign-in page. the user must sign in manually before I can read notifications.',
    'GitHub is signed out in the automation browser. the user needs to sign in manually in that browser session before I can check notifications.',
  ];
  for (const report of live) assert.ok(needsHandoffBounce(report), report);
});

test('needsHandoffBounce never fires on success or unrelated-failure endings', () => {
  const fine = [
    'You are logged in as scalinity.', // demo-2 success mentions login WITHOUT inability
    'Here are your 3 latest notifications: a review request, a CI failure, and a mention.',
    'The wallpaper is now set to Tahoe.',
    'The site could not be reached — the page timed out twice.', // inability, no login word
  ];
  for (const report of fine) assert.ok(!needsHandoffBounce(report), report);
});
