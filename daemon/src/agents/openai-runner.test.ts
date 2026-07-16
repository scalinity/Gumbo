import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { persistResults, describeToolFailure } = await import('./openai-runner.ts');
const { SearchError } = await import('../search/client.ts');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('persistResults defers indexing and lands every row', async () => {
  const rows: Array<{ url?: string; body: string }> = [];
  const store = { saveSearchResult: (row: { url?: string; body: string }) => rows.push(row) };
  persistResults(store, 't1', 'q', [
    { title: 'a', url: 'https://a.test', text: 'body a' },
    { title: null, url: 'https://b.test', highlights: ['h1', 'h2'] },
  ]);
  assert.equal(rows.length, 0, 'nothing indexed synchronously — the tool call must not block on FTS');
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].body, 'h1\nh2'); // highlights fallback when a page has no text
});

test('a throwing store does not break the chain — later rows still index', async () => {
  let calls = 0;
  const store = {
    saveSearchResult: () => {
      calls++;
      if (calls === 1) throw new Error('SQLITE_FULL');
    },
  };
  persistResults(store, 't1', 'q', [
    { title: 'a', url: 'https://a.test', text: 'x' },
    { title: 'b', url: 'https://b.test', text: 'y' },
  ]);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(calls, 2);
});

test('describeToolFailure: SearchError becomes model-facing text, anything else rethrows', () => {
  const text = describeToolFailure('web_search', new SearchError('exa', 'quota', 'HTTP 429'));
  assert.match(text, /web_search failed \(quota\)/);
  const cancel = new Error('cancelled');
  assert.throws(
    () => describeToolFailure('web_search', cancel),
    (err: unknown) => err === cancel, // the raw error, so task cancellation semantics survive
  );
});
