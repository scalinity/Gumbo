import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { persistResults, describeToolFailure, createSubagentTools } = await import('./openai-runner.ts');
const { SearchError } = await import('../search/client.ts');
process.env.XAI_API_KEY ??= 'xai-test-key';

const tick = () => new Promise((resolve) => setImmediate(resolve));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A minimal Grok /v1/responses body with `n` url_citation annotations on one message.
function grokResponse(citationUrls: string[]) {
  return {
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'People on X are discussing it.',
            annotations: citationUrls.map((url) => ({ type: 'url_citation', url })),
          },
        ],
      },
    ],
  };
}

function xSearchTool(store: { saveSearchResult: (row: unknown) => void }) {
  const tools = createSubagentTools('t1', store as never, new AbortController().signal);
  const t = tools.find((x) => (x as { name: string }).name === 'x_search');
  assert.ok(t, 'x_search tool is registered on the sub-agent');
  return t as unknown as { invoke: (ctx: unknown, args: string) => Promise<string> };
}

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

test('x_search persists ONE grok row: provider tag, first citation as url, answer + source list in body', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(grokResponse(['https://x.com/a', 'https://x.com/b'])), { status: 200 })) as typeof fetch;
  const rows: Array<{ provider?: string; url?: string; title?: string; body: string }> = [];
  const out = await xSearchTool({ saveSearchResult: (r) => rows.push(r as never) }).invoke(
    {},
    JSON.stringify({ query: 'iphone chatter' }),
  );
  assert.match(out, /People on X/);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(rows.length, 1, 'exactly one memory row per x_search call');
  assert.equal(rows[0].provider, 'grok');
  assert.equal(rows[0].url, 'https://x.com/a', 'first citation is the row url');
  assert.equal(rows[0].title, 'iphone chatter');
  assert.match(rows[0].body, /People on X/);
  assert.match(rows[0].body, /https:\/\/x\.com\/a/, 'source list is folded into the body');
});

test('x_search with zero citations uses the synthetic grok:x-search marker url', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify(grokResponse([])), { status: 200 })) as typeof fetch;
  const rows: Array<{ url?: string; body: string }> = [];
  await xSearchTool({ saveSearchResult: (r) => rows.push(r as never) }).invoke({}, JSON.stringify({ query: 'q' }));
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'grok:x-search', 'no citation → well-formed synthetic marker, not empty/undefined');
  assert.match(rows[0].body, /People on X/);
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
