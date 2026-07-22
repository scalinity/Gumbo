import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
// Import BEFORE stubbing the key: importing grok.ts pulls config.ts, whose loadEnvFile
// populates the real XAI_API_KEY from repo .env (if present). Capture it for the opt-in
// live smoke, then overwrite with a stub so the hermetic tests never hit the network.
const { grokLiveSearch, xLookup } = await import('./grok.ts');
const { SearchError } = await import('./client.ts');
const { config } = await import('../config.ts');
const REAL_XAI_KEY = process.env.XAI_API_KEY;
process.env.XAI_API_KEY = 'xai-test-key';

const lastAuditLine = () => {
  const lines = readFileSync(join(config.home.logs, 'search-audit.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Agent Tools API (/v1/responses) shape: an agentic `output` trace of reasoning + tool calls,
// with the answer in a trailing `message` item whose output_text carries url_citation annotations.
// The answer text includes an inline [[1]](url) marker — the client must strip it for speech.
const OK_BODY = {
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  error: null,
  output: [
    { type: 'reasoning', summary: [], status: 'completed' },
    // The measured live shape (2026-07-22): X-side sub-searches are custom_tool_call
    // items carrying name + input JSON. Web-side web_search_call items are opaque (no
    // query disclosed) and must NOT produce trace lines — noise, not transcript.
    { type: 'custom_tool_call', name: 'x_keyword_search', input: '{"query":"from:xai since:2026-07-21","limit":"10"}', status: 'completed' },
    { type: 'web_search_call', status: 'completed' },
    {
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: '@xai announced Grok 4.5 today.[[1]](https://x.com/xai/status/123)',
          annotations: [
            { type: 'url_citation', url: 'https://x.com/xai/status/123' },
            { type: 'url_citation', url: 'https://example.com/blog' },
          ],
        },
      ],
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

// A minimal completed response with a single output_text message — the common shape.
function completed(text: string, annotations: Array<{ type?: string; url?: string }> = []) {
  return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations }] }] };
}

test('serialization: /v1/responses endpoint, bearer auth, model, X+web tools, instructions', async () => {
  const calls = capture();
  await grokLiveSearch('what did xai post');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.x.ai/v1/responses');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer xai-test-key');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, 'grok-4.5'); // default is the deeper background model
  assert.ok(typeof body.instructions === 'string' && body.instructions.length > 0, 'system steering is sent');
  assert.deepEqual(body.input, [{ role: 'user', content: 'what did xai post' }]);
  assert.deepEqual(body.tools, [{ type: 'x_search' }, { type: 'web_search' }]);
  // max_tool_calls is deliberately NOT sent — measured live, it doesn't bound the reasoning loop.
  assert.ok(!('max_tool_calls' in body), 'no ineffective tool-call cap is sent');
});

test('parses the trailing message answer + url_citations, deriving spoken-ready titles', async () => {
  capture();
  const lookup = await grokLiveSearch('q');
  // Inline [[1]](url) marker stripped from the spoken answer.
  assert.equal(lookup.answer, '@xai announced Grok 4.5 today.');
  assert.deepEqual(lookup.sources, [
    { title: 'X post', url: 'https://x.com/xai/status/123' },
    { title: 'example.com', url: 'https://example.com/blog' },
  ]);
  // Grok's own sub-searches surface as a transcript trace (query extracted from input
  // JSON); the opaque web_search_call in the fixture yields NO line.
  assert.deepEqual(lookup.trace, ['x_keyword_search: from:xai since:2026-07-21']);
});

test('strips inline [[n]](url) citation markers mid-sentence and tidies whitespace', async () => {
  capture(200, completed('Foo [[1]](https://x.com/a) bar baz.', []));
  const lookup = await grokLiveSearch('q');
  assert.equal(lookup.answer, 'Foo bar baz.');
});

test('dedupes repeated citation URLs and ignores non-url_citation annotations', async () => {
  capture(200, completed('answer', [
    { type: 'url_citation', url: 'https://x.com/a' },
    { type: 'url_citation', url: 'https://x.com/a' },
    { type: 'file_citation', url: 'https://ignored.com' },
  ]));
  const lookup = await grokLiveSearch('q');
  assert.deepEqual(lookup.sources, [{ title: 'X post', url: 'https://x.com/a' }]);
});

test('an answer with no citations is valid (sources empty, not an error)', async () => {
  capture(200, completed('grok says so'));
  const lookup = await grokLiveSearch('q');
  assert.equal(lookup.answer, 'grok says so');
  assert.deepEqual(lookup.sources, []);
});

test('empty/whitespace answer text → empty_results error', async () => {
  capture(200, completed('   '));
  await assert.rejects(grokLiveSearch('q'), (e: unknown) => e instanceof SearchError && e.kind === 'empty_results');
});

test('no message item in the output → empty_results error', async () => {
  capture(200, { status: 'completed', output: [{ type: 'reasoning' }, { type: 'x_search_call' }] });
  await assert.rejects(grokLiveSearch('q'), (e: unknown) => e instanceof SearchError && e.kind === 'empty_results');
});

test('a non-completed status (e.g. hit max_tool_calls) → empty_results error', async () => {
  capture(200, { status: 'incomplete', output: [], incomplete_details: { reason: 'max_tool_calls' } });
  await assert.rejects(grokLiveSearch('q'), (e: unknown) => e instanceof SearchError && e.kind === 'empty_results');
});

test('401 → auth and is never retried', async () => {
  const calls = capture(401, {});
  await assert.rejects(grokLiveSearch('q'), (e: unknown) => e instanceof SearchError && e.kind === 'auth');
  assert.equal(calls.length, 1);
});

test('429 → quota', async () => {
  capture(429, {});
  await assert.rejects(grokLiveSearch('q', { retries: 0 }), (e: unknown) => e instanceof SearchError && e.kind === 'quota');
});

test('background path retries a 5xx (unlike the hot path)', async () => {
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return attempts === 1
      ? new Response('oops', { status: 502 })
      : new Response(JSON.stringify(OK_BODY), { status: 200 });
  }) as typeof fetch;
  const lookup = await grokLiveSearch('q');
  assert.equal(attempts, 2);
  assert.equal(lookup.answer, '@xai announced Grok 4.5 today.');
});

test('hard timeout aborts fast (fail fast, does not hang)', async () => {
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
  const started = Date.now();
  await assert.rejects(
    grokLiveSearch('q', { timeoutMs: 50, retries: 0 }),
    (e: unknown) => e instanceof SearchError && e.kind === 'timeout',
  );
  assert.ok(Date.now() - started < 1500, 'must abort at the timeout, not hang');
});

test('xLookup success contract: answer first, sources as metadata', async () => {
  capture();
  const parsed = JSON.parse(await xLookup('q'));
  assert.deepEqual(Object.keys(parsed), ['answer', 'sources']);
  assert.equal(parsed.answer, '@xai announced Grok 4.5 today.');
  assert.equal(parsed.sources.length, 2);
});

test('xLookup uses the fast non-reasoning hot model (not the deep background model)', async () => {
  const calls = capture();
  await xLookup('q');
  assert.equal(JSON.parse(String(calls[0].init.body)).model, 'grok-4.20-non-reasoning');
});

test('xLookup failure contract: structured, names the reason, steers to backgrounding', async () => {
  capture(200, completed('   '));
  const parsed = JSON.parse(await xLookup('q'));
  assert.equal(parsed.error, 'lookup_failed');
  assert.equal(parsed.reason, 'empty_results');
  assert.match(parsed.instruction, /spawn_subagent/);
  assert.match(parsed.instruction, /NOT guess/);
});

test('xLookup never throws and the hot path never retries (one call on a 500)', async () => {
  const calls = capture(500, {});
  const parsed = JSON.parse(await xLookup('q'));
  assert.equal(parsed.error, 'lookup_failed');
  assert.equal(parsed.reason, 'http');
  assert.equal(calls.length, 1, 'hot path retries:0 — a waiting voice turn fails fast');
});

test('success is audited ok:true with the citation count and /responses endpoint', async () => {
  capture();
  await grokLiveSearch('audit-ok');
  const entry = lastAuditLine();
  assert.equal(entry.provider, 'grok');
  assert.equal(entry.endpoint, '/responses');
  assert.equal(entry.ok, true);
  assert.equal(entry.resultCount, 2);
});

test('failures are audited ok:false with provider + kind at the client layer', async () => {
  capture(429, {});
  await assert.rejects(grokLiveSearch('audit-me', { retries: 0 }));
  const entry = lastAuditLine();
  assert.equal(entry.provider, 'grok');
  assert.equal(entry.ok, false);
  assert.equal(entry.error, 'quota');
  assert.equal(entry.query, 'audit-me');
});

// Usage recording (2026-07-21 analytics): grok rows land in the isolated store below —
// initUsageRecorder is test-scoped, so the earlier hermetic tests above record nothing.
const { Store } = await import('../events/store.ts');
const { initUsageRecorder } = await import('../usage/recorder.ts');

function usageStore() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-grok-usage-')), 'gumbo.db'));
  initUsageRecorder(store);
  return store;
}

test('usage row: cost_in_usd_ticks is authoritative when present', async () => {
  const store = usageStore();
  capture(200, {
    ...completed('It happened.'),
    usage: {
      input_tokens: 4000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 1000 },
      num_server_side_tools_used: 1,
      cost_in_usd_ticks: 76_728_000, // = $0.0076728 (the live-smoke calibration value)
    },
  });
  await grokLiveSearch('q', { model: 'grok-4.20-non-reasoning', retries: 0 });
  const rows = store.usageByDay('2000-01-01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input_tokens, 3000); // uncached remainder of 4000 total
  assert.equal(rows[0].cached_tokens, 1000);
  assert.ok(Math.abs(rows[0].cost_usd - 0.0076728) < 1e-9);
});

test('usage row: no ticks → rate-table math including the per-tool-call fee', async () => {
  const store = usageStore();
  capture(200, {
    ...completed('Answer.'),
    usage: { input_tokens: 1000, output_tokens: 1000, num_server_side_tools_used: 2 },
  });
  await grokLiveSearch('q', { model: 'grok-4.20-non-reasoning', retries: 0 });
  const rows = store.usageByDay('2000-01-01');
  assert.equal(rows.length, 1);
  // 1000×$1.25 in + 1000×$2.50 out per 1M, + 2×$0.005 tool calls
  assert.ok(Math.abs(rows[0].cost_usd - ((1000 * 1.25 + 1000 * 2.5) / 1e6 + 0.01)) < 1e-9);
});

test('usage row lands even when the answer is empty — the call billed regardless', async () => {
  const store = usageStore();
  capture(200, {
    status: 'completed',
    output: [], // completed but no message content → empty_results throw after recording
    usage: { input_tokens: 500, output_tokens: 0, num_server_side_tools_used: 1 },
  });
  await assert.rejects(() => grokLiveSearch('q', { retries: 0 }));
  const rows = store.usageByDay('2000-01-01');
  assert.equal(rows.length, 1, 'the billed call must land a row despite the empty answer');
  assert.equal(rows[0].kind, 'x_lookup');
});

// Opt-in live smoke against the real xAI API — needs XAI_API_KEY in .env and GROK_LIVE_SMOKE=1
// (keeps `npm test` hermetic + free by default). Restores the real key for its one call only.
const runSmoke = process.env.GROK_LIVE_SMOKE === '1' && !!REAL_XAI_KEY;
test(
  'live smoke: a real X lookup returns a non-empty spoken answer',
  { skip: runSmoke ? false : 'set GROK_LIVE_SMOKE=1 (needs XAI_API_KEY in .env)' },
  async () => {
    process.env.XAI_API_KEY = REAL_XAI_KEY!;
    try {
      const parsed = JSON.parse(await xLookup('What did @xai most recently post on X?'));
      assert.ok(!parsed.error, `expected an answer, got lookup_failed: ${parsed.reason}`);
      assert.ok(typeof parsed.answer === 'string' && parsed.answer.length > 0, 'got a non-empty answer');
      assert.doesNotMatch(parsed.answer, /\[\[\d+\]\]/, 'inline citation markers must be stripped for speech');
    } finally {
      process.env.XAI_API_KEY = 'xai-test-key';
    }
  },
);
