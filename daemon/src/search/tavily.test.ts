import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
process.env.TAVILY_API_KEY = 'tvly-test-key';
const { tavilySearch, webQuickLookup } = await import('./tavily.ts');
const { SearchError } = await import('./client.ts');
const { config } = await import('../config.ts');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const OK_BODY = {
  query: 'q',
  answer: 'France beat Spain 2-1.',
  results: [
    { title: 'Match report', url: 'https://example.com/report', content: '...', score: 0.9 },
    { title: null, url: 'https://example.com/live', content: '...' },
  ],
  response_time: 0.6,
};

function capture(status = 200, body: unknown = OK_BODY) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

test('request serialization: endpoint, bearer auth, fast depth, answer on, 5 results', async () => {
  const calls = capture();
  await tavilySearch('france spain score');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer tvly-test-key');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    query: 'france spain score',
    search_depth: 'fast',
    include_answer: true,
    max_results: 5,
  });
});

test('depth is configurable (ultra-fast supported)', async () => {
  const calls = capture();
  await tavilySearch('q', { depth: 'ultra-fast' });
  assert.equal(JSON.parse(String(calls[0].init.body)).search_depth, 'ultra-fast');
});

test("topic 'news' is sent; 'general' stays implicit", async () => {
  const calls = capture();
  await tavilySearch('q', { topic: 'news' });
  await tavilySearch('q', { topic: 'general' });
  assert.equal(JSON.parse(String(calls[0].init.body)).topic, 'news');
  assert.ok(!('topic' in JSON.parse(String(calls[1].init.body))));
});

test('parses answer + sources', async () => {
  capture();
  const lookup = await tavilySearch('q');
  assert.equal(lookup.answer, 'France beat Spain 2-1.');
  assert.deepEqual(lookup.sources, [
    { title: 'Match report', url: 'https://example.com/report' },
    { title: 'untitled', url: 'https://example.com/live' },
  ]);
});

test('empty answer → empty_results error', async () => {
  capture(200, { ...OK_BODY, answer: '  ' });
  await assert.rejects(tavilySearch('q'), (err: unknown) => err instanceof SearchError && err.kind === 'empty_results');
});

test('hot path never retries a 500', async () => {
  const calls = capture(500, {});
  await assert.rejects(tavilySearch('q'));
  assert.equal(calls.length, 1);
});

test('hard timeout honored (fail fast)', async () => {
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
  const started = Date.now();
  await assert.rejects(
    tavilySearch('q', { timeoutMs: 50 }),
    (err: unknown) => err instanceof SearchError && err.kind === 'timeout',
  );
  assert.ok(Date.now() - started < 1500, 'must abort at the timeout, not hang');
});

test('webQuickLookup success contract: answer first, sources as metadata', async () => {
  capture();
  const parsed = JSON.parse(await webQuickLookup('q'));
  assert.deepEqual(Object.keys(parsed), ['answer', 'sources']);
  assert.equal(parsed.answer, 'France beat Spain 2-1.');
  assert.equal(parsed.sources.length, 2);
});

test('webQuickLookup failure contract: structured, names the reason, steers to backgrounding', async () => {
  capture(200, { ...OK_BODY, answer: null });
  const parsed = JSON.parse(await webQuickLookup('q'));
  assert.equal(parsed.error, 'lookup_failed');
  assert.equal(parsed.reason, 'empty_results');
  assert.match(parsed.instruction, /spawn_subagent/);
  assert.match(parsed.instruction, /NOT guess/);
});

test('webQuickLookup never throws on provider failure', async () => {
  capture(429, {});
  const parsed = JSON.parse(await webQuickLookup('q'));
  assert.equal(parsed.error, 'lookup_failed');
  assert.equal(parsed.reason, 'quota');
});

test('failures are audited ok:false at the client layer', async () => {
  capture(429, {});
  await assert.rejects(tavilySearch('audit-me'));
  const lines = readFileSync(join(config.home.logs, 'search-audit.jsonl'), 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  assert.equal(entry.provider, 'tavily');
  assert.equal(entry.ok, false);
  assert.equal(entry.error, 'quota');
  assert.equal(entry.query, 'audit-me');
});
