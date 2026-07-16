import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate any config-derived paths (audit log) from the real ~/Gumbo before modules load.
process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { postJson, SearchError } = await import('./client.ts');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init: RequestInit };
function mockFetch(handler: (call: Call, attempt: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length);
  }) as typeof fetch;
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const base = {
  provider: 'exa' as const,
  url: 'https://api.example.test/search',
  headers: { 'x-api-key': 'k' },
  body: { query: 'q' },
  timeoutMs: 1000,
  retries: 2,
  retryDelaysMs: [1, 1],
};

test('retries 429 then succeeds', async () => {
  const calls = mockFetch((_c, attempt) => (attempt < 3 ? json(429, {}) : json(200, { ok: true })));
  assert.deepEqual(await postJson(base), { ok: true });
  assert.equal(calls.length, 3);
});

test('retries 5xx then succeeds', async () => {
  const calls = mockFetch((_c, attempt) => (attempt === 1 ? json(503, {}) : json(200, { ok: true })));
  assert.deepEqual(await postJson(base), { ok: true });
  assert.equal(calls.length, 2);
});

test('exhausted 429 retries → quota error after max 2 retries', async () => {
  const calls = mockFetch(() => json(429, {}));
  await assert.rejects(postJson(base), (err: unknown) => {
    assert.ok(err instanceof SearchError);
    assert.equal(err.kind, 'quota');
    assert.equal(err.status, 429);
    return true;
  });
  assert.equal(calls.length, 3); // 1 initial + 2 retries, never more
});

test('401/403 → auth error, no retry', async () => {
  const calls = mockFetch(() => json(401, {}));
  await assert.rejects(postJson(base), (err: unknown) => err instanceof SearchError && err.kind === 'auth');
  assert.equal(calls.length, 1);
});

test('non-retryable 4xx → http error, no retry', async () => {
  const calls = mockFetch(() => json(400, { error: 'bad' }));
  await assert.rejects(postJson(base), (err: unknown) => err instanceof SearchError && err.kind === 'http');
  assert.equal(calls.length, 1);
});

test('retries: 0 fails fast on 429 (hot-path contract)', async () => {
  const calls = mockFetch(() => json(429, {}));
  await assert.rejects(
    postJson({ ...base, retries: 0 }),
    (err: unknown) => err instanceof SearchError && err.kind === 'quota',
  );
  assert.equal(calls.length, 1);
});

test('timeout → timeout error', async () => {
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
  await assert.rejects(
    postJson({ ...base, timeoutMs: 30 }),
    (err: unknown) => err instanceof SearchError && err.kind === 'timeout',
  );
});

test('caller abort tears down the request and rethrows the raw reason', async () => {
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
  const ctrl = new AbortController();
  const rejected = assert.rejects(
    postJson({ ...base, signal: ctrl.signal }),
    (err: unknown) => !(err instanceof SearchError) && (err as Error).message === 'task cancelled',
  );
  ctrl.abort(new Error('task cancelled'));
  await rejected;
});

test('requestJson GET sends no body and no content-type (async-job polling contract)', async () => {
  const { requestJson } = await import('./client.ts');
  const calls = mockFetch(() => json(200, { status: 'scraping' }));
  await requestJson({ ...base, method: 'GET', body: undefined });
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.equal((calls[0].init.headers as Record<string, string>)['content-type'], undefined);
});

test('requestJson DELETE passes the method through (job cancellation contract)', async () => {
  const { requestJson } = await import('./client.ts');
  const calls = mockFetch(() => json(200, { status: 'cancelled' }));
  assert.deepEqual(await requestJson({ ...base, method: 'DELETE', body: undefined }), { status: 'cancelled' });
  assert.equal(calls[0].init.method, 'DELETE');
});

test('connection failure → network error', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(postJson(base), (err: unknown) => err instanceof SearchError && err.kind === 'network');
});
