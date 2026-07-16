import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
process.env.EXA_API_KEY = 'exa-test-key';
const { exaSearch, exaContents } = await import('./exa.ts');
const { SearchError } = await import('./client.ts');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const OK_BODY = {
  requestId: 'r1',
  results: [
    {
      title: 'Solid-state batteries',
      url: 'https://example.com/a',
      publishedDate: '2026-07-01T00:00:00.000Z',
      text: 'full page text…',
      highlights: ['key passage'],
    },
  ],
};

function capture(status = 200, body: unknown = OK_BODY) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

test('search serialization: endpoint, x-api-key, auto tier, full unclamped contents', async () => {
  const calls = capture();
  await exaSearch('solid-state batteries');
  assert.equal(calls[0].url, 'https://api.exa.ai/search');
  assert.equal((calls[0].init.headers as Record<string, string>)['x-api-key'], 'exa-test-key');
  const body = String(calls[0].init.body);
  assert.deepEqual(JSON.parse(body), {
    query: 'solid-state batteries',
    type: 'auto',
    numResults: 10,
    contents: { text: true, highlights: true },
  });
  // The no-truncation guarantee is a spec requirement — assert its absence outright.
  assert.ok(!body.includes('maxCharacters'), 'request must never clamp content length');
});

test('tier "deep" is passed through for research-class tasks', async () => {
  const calls = capture();
  await exaSearch('q', { tier: 'deep' });
  assert.equal(JSON.parse(String(calls[0].init.body)).type, 'deep');
});

test('contents serialization: urls + full text, unclamped', async () => {
  const calls = capture();
  await exaContents(['https://example.com/a', 'https://example.com/b']);
  assert.equal(calls[0].url, 'https://api.exa.ai/contents');
  const body = String(calls[0].init.body);
  assert.deepEqual(JSON.parse(body), {
    urls: ['https://example.com/a', 'https://example.com/b'],
    text: true,
    highlights: true,
  });
  assert.ok(!body.includes('maxCharacters'));
});

test('search results parsed through', async () => {
  capture();
  const results = await exaSearch('q');
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.com/a');
  assert.equal(results[0].text, 'full page text…');
});

test('empty results → empty_results error', async () => {
  capture(200, { requestId: 'r2', results: [] });
  await assert.rejects(exaSearch('q'), (err: unknown) => err instanceof SearchError && err.kind === 'empty_results');
});

test('background path retries a 5xx (unlike the hot path)', async () => {
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return attempts === 1
      ? new Response('oops', { status: 502 })
      : new Response(JSON.stringify(OK_BODY), { status: 200 });
  }) as typeof fetch;
  const results = await exaSearch('q');
  assert.equal(attempts, 2);
  assert.equal(results.length, 1);
});
