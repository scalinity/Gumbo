import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
process.env.FIRECRAWL_API_KEY = 'fc-test-key';
const { firecrawlScrape, firecrawlMap, firecrawlCrawl, firecrawlExtract } = await import('./firecrawl.ts');
const { SearchError } = await import('../search/client.ts');
const { config } = await import('../config.ts');

const lastAuditLine = () => {
  const lines = readFileSync(join(config.home.logs, 'search-audit.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
};

const auditTail = (n: number) => {
  const lines = readFileSync(join(config.home.logs, 'search-audit.jsonl'), 'utf8').trim().split('\n');
  return lines.slice(-n).map((line) => JSON.parse(line));
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init: RequestInit };

function mockRoutes(handler: (call: Call) => unknown | Promise<unknown>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const body = await handler(call);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const SCRAPE_OK = {
  success: true,
  data: {
    markdown: '# Hello\n\nfull page markdown…',
    metadata: { title: 'Hello page', sourceURL: 'https://example.com/hello' },
  },
};

// ---------- scrape ----------

test('scrape serialization: /v2/scrape, Bearer auth, markdown format, main content', async () => {
  const calls = mockRoutes(() => SCRAPE_OK);
  await firecrawlScrape('https://example.com/hello');
  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer fc-test-key');
  const body = String(calls[0].init.body);
  assert.deepEqual(JSON.parse(body), {
    url: 'https://example.com/hello',
    formats: ['markdown'],
    onlyMainContent: true,
  });
  // Full content, no truncation — the same spec stance as the Exa path.
  assert.ok(!body.includes('maxCharacters'));
});

test('scrape waitForMs maps to waitFor for dynamic pages; null omits it', async () => {
  const calls = mockRoutes(() => SCRAPE_OK);
  await firecrawlScrape('https://a.test', { waitForMs: 2000 });
  await firecrawlScrape('https://a.test', { waitForMs: null });
  assert.equal(JSON.parse(String(calls[0].init.body)).waitFor, 2000);
  assert.ok(!String(calls[1].init.body).includes('waitFor'));
});

test('scrape parses page and audits success', async () => {
  mockRoutes(() => SCRAPE_OK);
  const page = await firecrawlScrape('https://example.com/hello');
  assert.equal(page.url, 'https://example.com/hello');
  assert.equal(page.title, 'Hello page');
  assert.match(page.markdown, /full page markdown/);
  const entry = lastAuditLine();
  assert.equal(entry.provider, 'firecrawl');
  assert.equal(entry.endpoint, '/scrape');
  assert.equal(entry.ok, true);
  assert.equal(entry.resultCount, 1);
});

test('scrape with empty markdown → empty_results, audited as a failure', async () => {
  mockRoutes(() => ({ success: true, data: { markdown: '   ', metadata: {} } }));
  await assert.rejects(
    firecrawlScrape('https://a.test'),
    (err: unknown) => err instanceof SearchError && err.kind === 'empty_results',
  );
  const entry = lastAuditLine();
  assert.equal(entry.ok, false);
  assert.equal(entry.error, 'empty_results');
});

test('401 → auth error, never retried', async () => {
  const calls = mockRoutes(() => new Response('nope', { status: 401 }));
  await assert.rejects(
    firecrawlScrape('https://a.test'),
    (err: unknown) => err instanceof SearchError && err.kind === 'auth',
  );
  assert.equal(calls.length, 1);
});

test('429 → quota error', async () => {
  mockRoutes(() => new Response('slow down', { status: 429 }));
  await assert.rejects(
    firecrawlScrape('https://a.test'),
    (err: unknown) => err instanceof SearchError && err.kind === 'quota',
  );
});

test('abort mid-request → timeout error', async () => {
  mockRoutes(() => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  });
  await assert.rejects(
    firecrawlScrape('https://a.test'),
    (err: unknown) => err instanceof SearchError && err.kind === 'timeout',
  );
});

test('5xx retried max twice, then http error', async () => {
  const calls = mockRoutes(() => new Response('boom', { status: 500 }));
  await assert.rejects(
    firecrawlScrape('https://a.test'),
    (err: unknown) => err instanceof SearchError && err.kind === 'http',
  );
  assert.equal(calls.length, 3); // 1 initial + 2 retries, never more
});

// ---------- map ----------

test('map serialization: /v2/map, bounded default limit, limit override', async () => {
  const calls = mockRoutes(() => ({ success: true, links: [{ url: 'https://a.test/docs', title: 'Docs' }] }));
  await firecrawlMap('https://a.test');
  await firecrawlMap('https://a.test', { limit: 42 });
  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/map');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { url: 'https://a.test', limit: 500 });
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { url: 'https://a.test', limit: 42 });
});

test('map parses links and audits with link count', async () => {
  mockRoutes(() => ({
    success: true,
    links: [{ url: 'https://a.test/x', title: 'X' }, { url: 'https://a.test/y' }, { notaurl: true }],
  }));
  const links = await firecrawlMap('https://a.test');
  assert.deepEqual(links.map((l) => l.url), ['https://a.test/x', 'https://a.test/y']);
  const entry = lastAuditLine();
  assert.equal(entry.endpoint, '/map');
  assert.equal(entry.resultCount, 2);
  assert.equal(entry.ok, true);
});

test('map with no links → empty_results', async () => {
  mockRoutes(() => ({ success: true, links: [] }));
  await assert.rejects(
    firecrawlMap('https://a.test'),
    (err: unknown) => err instanceof SearchError && err.kind === 'empty_results',
  );
});

// ---------- crawl ----------

const crawlPage = (n: number) => ({
  markdown: `page ${n} markdown`,
  metadata: { title: `Page ${n}`, sourceURL: `https://a.test/p${n}` },
});

function crawlHandler(opts: {
  polls: Array<Record<string, unknown>>;
  next?: Record<string, Record<string, unknown>>;
}) {
  let poll = 0;
  return (call: Call) => {
    if (call.init.method === 'DELETE') return { status: 'cancelled' };
    if (call.init.method === 'GET') {
      if (opts.next?.[call.url]) return opts.next[call.url];
      return opts.polls[Math.min(poll++, opts.polls.length - 1)];
    }
    return { success: true, id: 'job-1' };
  };
}

test('crawl lifecycle: submit → poll scraping → completed, breadth defaults in the request', async () => {
  const calls = mockRoutes(
    crawlHandler({
      polls: [
        { status: 'scraping', completed: 1, total: 3 },
        { status: 'completed', completed: 3, total: 3, data: [crawlPage(1), crawlPage(2), crawlPage(3)], next: null },
      ],
    }),
  );
  const progress: Array<{ status: string; completed: number }> = [];
  const pages = await firecrawlCrawl('https://a.test/docs', {
    pollIntervalMs: 1,
    onProgress: (p) => progress.push(p),
  });
  // Submit request carries the breadth bounds — default 100 pages / depth 3, never the
  // API's own 10 000-page default.
  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/crawl');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    url: 'https://a.test/docs',
    limit: 100,
    maxDiscoveryDepth: 3,
    scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
  });
  // Poll requests are GETs against the job id.
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].url, 'https://api.firecrawl.dev/v2/crawl/job-1');
  assert.equal(pages.length, 3);
  assert.equal(pages[0].url, 'https://a.test/p1');
  assert.equal(pages[0].markdown, 'page 1 markdown');
  assert.deepEqual(progress.map((p) => p.status), ['scraping', 'completed']);
  // Every outbound call gets its own audit line: submit, then each status poll (with the
  // server-reported page count so far).
  assert.deepEqual(auditTail(3).map((e) => [e.endpoint, e.resultCount, e.ok]), [
    ['/crawl', 0, true],
    ['/crawl/:id', 1, true],
    ['/crawl/:id', 3, true],
  ]);
});

test('crawl overrides: max_pages/max_depth/path patterns reach the API', async () => {
  const calls = mockRoutes(
    crawlHandler({ polls: [{ status: 'completed', completed: 1, total: 1, data: [crawlPage(1)], next: null }] }),
  );
  await firecrawlCrawl('https://a.test', {
    maxPages: 5,
    maxDepth: 2,
    includePaths: ['^/docs/.*'],
    excludePaths: ['\\.pdf$'],
    pollIntervalMs: 1,
  });
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.limit, 5);
  assert.equal(body.maxDiscoveryDepth, 2);
  assert.deepEqual(body.includePaths, ['^/docs/.*']);
  assert.deepEqual(body.excludePaths, ['\\.pdf$']);
});

test('crawl follows the next cursor to collect paginated results', async () => {
  mockRoutes(
    crawlHandler({
      polls: [
        {
          status: 'completed',
          completed: 4,
          total: 4,
          data: [crawlPage(1), crawlPage(2)],
          next: 'https://api.firecrawl.dev/v2/crawl/job-1?skip=2',
        },
      ],
      next: {
        'https://api.firecrawl.dev/v2/crawl/job-1?skip=2': { data: [crawlPage(3), crawlPage(4)], next: null },
      },
    }),
  );
  const pages = await firecrawlCrawl('https://a.test', { pollIntervalMs: 1 });
  assert.deepEqual(pages.map((p) => p.url), ['https://a.test/p1', 'https://a.test/p2', 'https://a.test/p3', 'https://a.test/p4']);
});

test('client-side page cap: excess pages are dropped and pagination stops at the cap', async () => {
  const calls = mockRoutes(
    crawlHandler({
      polls: [
        {
          status: 'completed',
          completed: 5,
          total: 5,
          data: [crawlPage(1), crawlPage(2), crawlPage(3)],
          next: 'https://api.firecrawl.dev/v2/crawl/job-1?skip=3',
        },
      ],
    }),
  );
  const pages = await firecrawlCrawl('https://a.test', { maxPages: 2, pollIntervalMs: 1 });
  assert.equal(pages.length, 2, 'cap enforced in our client even if the API over-returns');
  assert.ok(
    !calls.some((c) => c.url.includes('skip=3')),
    'must not paginate past the page cap',
  );
});

test('crawl job failed server-side → http error, remote job cancelled, every call audited', async () => {
  const calls = mockRoutes(crawlHandler({ polls: [{ status: 'failed' }] }));
  await assert.rejects(
    firecrawlCrawl('https://a.test', { pollIntervalMs: 1 }),
    (err: unknown) => err instanceof SearchError && err.kind === 'http',
  );
  await waitFor(() => calls.some((c) => c.init.method === 'DELETE'));
  // One operation-level failure line, and the fire-and-forget cancel audits its own line.
  const cancel = await waitFor(() => auditTail(5).find((e) => e.endpoint === 'DELETE /crawl/:id'));
  assert.equal(cancel!.ok, true);
  const failure = auditTail(5).find((e) => e.endpoint === '/crawl' && e.ok === false);
  assert.equal(failure?.error, 'http');
});

test('crawl budget exhausted → timeout error and remote DELETE', async () => {
  const calls = mockRoutes(crawlHandler({ polls: [{ status: 'scraping', completed: 0, total: 0 }] }));
  await assert.rejects(
    firecrawlCrawl('https://a.test', { pollIntervalMs: 1, jobBudgetMs: 0 }),
    (err: unknown) => err instanceof SearchError && err.kind === 'timeout',
  );
  const del = await waitFor(() => calls.find((c) => c.init.method === 'DELETE'));
  assert.equal(del!.url, 'https://api.firecrawl.dev/v2/crawl/job-1');
});

test('task abort mid-poll → raw abort propagates (cancelled semantics) and remote DELETE fires', async () => {
  const calls = mockRoutes(crawlHandler({ polls: [{ status: 'scraping', completed: 0, total: 0 }] }));
  const ctrl = new AbortController();
  const rejected = assert.rejects(
    firecrawlCrawl('https://a.test', { pollIntervalMs: 60_000, signal: ctrl.signal }),
    (err: unknown) => !(err instanceof SearchError), // raw abort, so task 'cancelled' status survives
  );
  setTimeout(() => ctrl.abort(), 20);
  await rejected;
  assert.ok(ctrl.signal.aborted);
  const del = await waitFor(() => calls.find((c) => c.init.method === 'DELETE'));
  assert.equal(del!.url, 'https://api.firecrawl.dev/v2/crawl/job-1');
});

// ---------- extract ----------

test('extract lifecycle: submit schema+prompt → poll processing → completed data', async () => {
  let poll = 0;
  const calls = mockRoutes((call) => {
    if (call.init.method === 'GET') {
      return poll++ === 0
        ? { status: 'processing' }
        : { success: true, status: 'completed', data: { price: '$99' } };
    }
    return { success: true, id: 'ex-1' };
  });
  const data = await firecrawlExtract(['https://a.test/pricing'], {
    schema: { type: 'object', properties: { price: { type: 'string' } } },
    prompt: 'the monthly price',
    pollIntervalMs: 1,
  });
  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/extract');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    urls: ['https://a.test/pricing'],
    schema: { type: 'object', properties: { price: { type: 'string' } } },
    prompt: 'the monthly price',
  });
  assert.equal(calls[1].url, 'https://api.firecrawl.dev/v2/extract/ex-1');
  assert.deepEqual(data, { price: '$99' });
  // Per-call audit: submit, processing poll, completed poll (page count = urls touched).
  assert.deepEqual(auditTail(3).map((e) => [e.endpoint, e.resultCount, e.ok]), [
    ['/extract', 0, true],
    ['/extract/:id', 0, true],
    ['/extract/:id', 1, true],
  ]);
});

test('extract job failed → http error, audited as failure', async () => {
  mockRoutes((call) =>
    call.init.method === 'GET' ? { status: 'failed', error: 'render crashed' } : { success: true, id: 'ex-2' },
  );
  await assert.rejects(
    firecrawlExtract(['https://a.test'], { schema: {}, pollIntervalMs: 1 }),
    (err: unknown) => err instanceof SearchError && err.kind === 'http' && /render crashed/.test(err.message),
  );
  const entry = lastAuditLine();
  assert.equal(entry.ok, false);
  assert.equal(entry.endpoint, '/extract');
});

test('extract budget exhausted → timeout error', async () => {
  mockRoutes((call) => (call.init.method === 'GET' ? { status: 'processing' } : { success: true, id: 'ex-3' }));
  await assert.rejects(
    firecrawlExtract(['https://a.test'], { schema: {}, pollIntervalMs: 1, jobBudgetMs: 0 }),
    (err: unknown) => err instanceof SearchError && err.kind === 'timeout',
  );
});

// Fire-and-forget remote cancels land a tick or two later; poll briefly instead of racing.
async function waitFor<T>(probe: () => T | undefined | false): Promise<T | undefined> {
  for (let i = 0; i < 50; i++) {
    const value = probe();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition not met within 250 ms');
}
