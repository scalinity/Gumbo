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
    'GitHub is not signed in in the current browser session. The user needs to sign in before I can read Notifications.',
    'GitHub redirected to its sign-in page. The user must sign in manually before I can read notifications.',
    'GitHub is signed out in the automation browser. The user needs to sign in manually in that browser session before I can check notifications.',
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

// The deep-research lane's core invariant: raw page bodies never enter the orchestrating
// loop's context (full-text searches saturate it in a handful of turns — the measured
// cause of shallow research runs). Searches skim; reads come back as compressed notes.
const { formatSkim, extractNotes, firecrawlReserve } = await import('./openai-runner.ts');
const { config } = await import('../config.ts');
import type { ExaResult } from '../search/exa.ts';

// Scan MEDIUM (2026-07-22): a per-task Firecrawl page budget bounds a prompt-injected
// research agent that would otherwise loop expensive crawls.
test('firecrawlReserve clamps to the remaining budget and refuses at zero (no silent truncation)', () => {
  assert.deepEqual(firecrawlReserve(100, 0, 2000), { allow: 100, note: '' }, 'plenty of budget → full request, no note');
  const near = firecrawlReserve(500, 1800, 2000);
  assert.equal(near.allow, 200, 'clamped to what remains');
  assert.match(near.note, /clamped to 200 pages/, 'the model is told, not silently cut');
  assert.equal(firecrawlReserve(100, 2000, 2000).allow, 0, 'budget spent → refuse (caller returns the exhausted message)');
  assert.equal(firecrawlReserve(100, 2500, 2000).allow, 0, 'over-spent stays refused (never negative)');
});

test('deep-mode search skim carries titles/URLs/highlights but NEVER page bodies', () => {
  const results = [
    { url: 'https://a.test/x', title: 'A story', publishedDate: '2026-07-21', highlights: ['the key line'], text: 'FULL-BODY '.repeat(2000) },
  ] as ExaResult[];
  const skim = formatSkim(results);
  assert.match(skim, /the key line/);
  assert.match(skim, /https:\/\/a\.test\/x/);
  assert.doesNotMatch(skim, /FULL-BODY/);
});

test('extractNotes compresses per page; one failed extraction or empty page never sinks the batch', async () => {
  const pages = [
    { url: 'https://a.test/1', title: 'One', publishedDate: null, highlights: [], text: 'alpha content '.repeat(40) },
    { url: 'https://a.test/2', title: 'Two', publishedDate: null, highlights: [], text: 'beta content' },
    { url: 'https://a.test/3', title: 'Three', publishedDate: null, highlights: [], text: '' },
  ] as ExaResult[];
  const complete = async (_instructions: string, input: string) => {
    if (input.includes('beta content')) throw new Error('rate limited');
    return 'NOTE: dense relevant facts';
  };
  const out = await extractNotes(pages, 'the focus', complete);
  assert.match(out, /NOTE: dense relevant facts/, 'a good page yields its note');
  assert.match(out, /extraction failed: rate limited/, 'the failing page is labeled, not fatal');
  assert.match(out, /no text could be fetched/, 'an empty page is labeled');
  assert.doesNotMatch(out, /alpha content/, 'raw page text never rides back with the notes');
});

test('extractNotes states the window when a page exceeds the extractor input cap (no silent truncation)', async () => {
  const pages = [
    { url: 'https://a.test/big', title: 'Big', publishedDate: null, highlights: [], text: 'x'.repeat(config.research.extractInputMaxChars + 500) },
  ] as ExaResult[];
  const out = await extractNotes(pages, 'f', async () => 'ok');
  assert.match(out, /first \d+ were read/);
});
