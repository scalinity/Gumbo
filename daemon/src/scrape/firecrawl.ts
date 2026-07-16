import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../config.ts';
import { requestJson, SearchError } from '../search/client.ts';
import { auditSearchCall } from '../search/audit.ts';

// Firecrawl v2 raw client — content acquisition (scrape/crawl/map/extract) for background
// sub-agents. Deliberately NOT a search provider: /search stays with Tavily (hot path) and
// Exa (background); this module never touches it. Raw fetch via the shared requestJson —
// no SDK, same reasoning as the exa-js removal (uniform retry/timeout/typed errors).
//
// Verified against docs.firecrawl.dev + firecrawl.dev/pricing, 2026-07-15:
// - POST /v2/scrape (sync), POST /v2/map (sync), POST /v2/crawl → job id polled via
//   GET /v2/crawl/{id} (status scraping|completed|failed, paginated `next` cursor),
//   cancelled via DELETE /v2/crawl/{id}; POST /v2/extract → job id polled via
//   GET /v2/extract/{id} (status processing|completed|failed|cancelled — no DELETE
//   documented for extract, so task aborts just stop polling it).
// - Credits: scrape/crawl 1 per page, map billed per page listed, extract billed in
//   credits at 15 tokens/credit. Crawl's API-side `limit` DEFAULTS TO 10 000 — always
//   send our own bound and enforce it client-side too.
// - robots.txt: crawl respects it by default (`ignoreRobotsTxt` is false and
//   enterprise-only to flip) — we never set it, so crawls stay compliant.
// - Async jobs poll — the daemon binds loopback only, so Firecrawl's cloud webhooks can
//   never reach it.
//
// Audit convention: one JSONL line per logical operation (scrape/map/crawl job/extract
// job) at its terminal outcome, page count as resultCount. Status polls re-send only a
// job id — no new query leaves the box — so they don't get their own lines.

const BASE = 'https://api.firecrawl.dev/v2';

export interface FirecrawlPage {
  url: string;
  title?: string;
  markdown: string;
}

export interface FirecrawlLink {
  url: string;
  title?: string;
  description?: string;
}

export interface CrawlProgress {
  status: string;
  completed: number;
  total: number;
}

interface PageData {
  markdown?: string;
  metadata?: { title?: string; sourceURL?: string; url?: string };
}

function firecrawlHeaders(): Record<string, string> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new SearchError('firecrawl', 'auth', 'FIRECRAWL_API_KEY is not set');
  return { authorization: `Bearer ${apiKey}` };
}

function toPage(data: PageData, fallbackUrl?: string): FirecrawlPage {
  return {
    url: data.metadata?.sourceURL ?? data.metadata?.url ?? fallbackUrl ?? '',
    title: data.metadata?.title,
    markdown: data.markdown ?? '',
  };
}

function auditFailure(endpoint: string, query: string, err: unknown) {
  auditSearchCall({
    provider: 'firecrawl',
    endpoint,
    query,
    resultCount: 0,
    ok: false,
    error: err instanceof SearchError ? err.kind : String(err),
  });
}

/**
 * Scrape one known URL to clean markdown (sync, JS-rendered by Firecrawl's headless
 * browser). Full content, no truncation anywhere — same quality-over-token-cost stance
 * as the Exa path. `waitForMs` gives dynamic pages extra settle time before capture.
 */
export async function firecrawlScrape(
  url: string,
  opts: { waitForMs?: number | null; signal?: AbortSignal } = {},
): Promise<FirecrawlPage> {
  try {
    const raw = (await requestJson({
      provider: 'firecrawl',
      url: `${BASE}/scrape`,
      headers: firecrawlHeaders(),
      body: {
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        ...(opts.waitForMs ? { waitFor: opts.waitForMs } : {}),
      },
      timeoutMs: config.firecrawl.scrapeTimeoutMs,
      retries: 2,
      signal: opts.signal,
    })) as { success?: boolean; data?: PageData };
    const page = toPage(raw.data ?? {}, url);
    if (!page.markdown.trim()) throw new SearchError('firecrawl', 'empty_results', 'no markdown content for url');
    auditSearchCall({ provider: 'firecrawl', endpoint: '/scrape', query: url, resultCount: 1, ok: true });
    return page;
  } catch (err) {
    auditFailure('/scrape', url, err);
    throw err;
  }
}

/** Map a site's URL structure (sync) — the cheap pre-crawl discovery step. */
export async function firecrawlMap(
  url: string,
  opts: { search?: string | null; limit?: number | null; signal?: AbortSignal } = {},
): Promise<FirecrawlLink[]> {
  try {
    const raw = (await requestJson({
      provider: 'firecrawl',
      url: `${BASE}/map`,
      headers: firecrawlHeaders(),
      body: {
        url,
        limit: opts.limit ?? config.firecrawl.mapDefaultLimit,
        ...(opts.search ? { search: opts.search } : {}),
      },
      timeoutMs: config.firecrawl.mapTimeoutMs,
      retries: 2,
      signal: opts.signal,
    })) as { success?: boolean; links?: Array<{ url?: string; title?: string; description?: string }> };
    const links = (raw.links ?? [])
      .filter((l): l is { url: string; title?: string; description?: string } => typeof l.url === 'string')
      .map((l) => ({ url: l.url, title: l.title, description: l.description }));
    if (links.length === 0) throw new SearchError('firecrawl', 'empty_results', 'no links found for site');
    auditSearchCall({ provider: 'firecrawl', endpoint: '/map', query: url, resultCount: links.length, ok: true });
    return links;
  } catch (err) {
    auditFailure('/map', url, err);
    throw err;
  }
}

interface CrawlStatus {
  status?: string;
  total?: number;
  completed?: number;
  creditsUsed?: number;
  next?: string | null;
  data?: PageData[];
}

/** Best-effort remote cancel — a dead job must not keep spending credits server-side. */
function cancelCrawlJob(jobId: string) {
  requestJson({
    provider: 'firecrawl',
    url: `${BASE}/crawl/${jobId}`,
    method: 'DELETE',
    headers: firecrawlHeaders(),
    timeoutMs: 10_000,
    retries: 0,
  }).catch((err) => console.error(`firecrawl: crawl ${jobId} cancel failed:`, err));
}

/**
 * Crawl a site from a seed URL (async job: submit → poll → collect). Content is full,
 * unclamped markdown per page; BREADTH is bounded — maxPages (default 100) and maxDepth
 * (default 3) cap scope against runaway credit spend (1 credit/page; the API's own limit
 * default is 10 000). The page cap is sent as the API `limit` AND enforced client-side
 * when collecting. Task abort and budget exhaustion both DELETE the remote job.
 */
export async function firecrawlCrawl(
  url: string,
  opts: {
    maxPages?: number | null;
    maxDepth?: number | null;
    includePaths?: string[] | null;
    excludePaths?: string[] | null;
    signal?: AbortSignal;
    onProgress?: (progress: CrawlProgress) => void;
    /** Test seams — production callers use the config defaults. */
    pollIntervalMs?: number;
    jobBudgetMs?: number;
  } = {},
): Promise<FirecrawlPage[]> {
  const maxPages = opts.maxPages ?? config.firecrawl.crawlDefaultMaxPages;
  const maxDepth = opts.maxDepth ?? config.firecrawl.crawlDefaultMaxDepth;
  const pollIntervalMs = opts.pollIntervalMs ?? config.firecrawl.crawlPollIntervalMs;
  const deadline = Date.now() + (opts.jobBudgetMs ?? config.firecrawl.crawlJobBudgetMs);
  const headers = firecrawlHeaders();
  let jobId: string | undefined;
  try {
    const submitted = (await requestJson({
      provider: 'firecrawl',
      url: `${BASE}/crawl`,
      headers,
      body: {
        url,
        limit: maxPages,
        maxDiscoveryDepth: maxDepth,
        ...(opts.includePaths?.length ? { includePaths: opts.includePaths } : {}),
        ...(opts.excludePaths?.length ? { excludePaths: opts.excludePaths } : {}),
        scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
      },
      timeoutMs: 30_000,
      retries: 2,
      signal: opts.signal,
    })) as { success?: boolean; id?: string };
    if (!submitted.id) throw new SearchError('firecrawl', 'http', 'crawl submit returned no job id');
    jobId = submitted.id;

    for (;;) {
      if (Date.now() >= deadline) {
        throw new SearchError('firecrawl', 'timeout', `crawl job did not finish within budget`);
      }
      const status = (await requestJson({
        provider: 'firecrawl',
        url: `${BASE}/crawl/${jobId}`,
        method: 'GET',
        headers,
        timeoutMs: 30_000,
        retries: 2,
        signal: opts.signal,
      })) as CrawlStatus;
      opts.onProgress?.({
        status: status.status ?? 'unknown',
        completed: status.completed ?? 0,
        total: status.total ?? 0,
      });
      if (status.status === 'failed') {
        throw new SearchError('firecrawl', 'http', 'crawl job failed server-side');
      }
      if (status.status === 'completed') {
        // Client-side breadth enforcement: never return (or keep paginating past) more
        // than the page cap, whatever the API sends back.
        const pages: FirecrawlPage[] = [];
        let batch: CrawlStatus | undefined = status;
        while (batch && pages.length < maxPages) {
          for (const data of batch.data ?? []) {
            if (pages.length >= maxPages) break;
            const page = toPage(data);
            if (page.markdown.trim()) pages.push(page);
          }
          batch = batch.next && pages.length < maxPages
            ? ((await requestJson({
                provider: 'firecrawl',
                url: batch.next,
                method: 'GET',
                headers,
                timeoutMs: 30_000,
                retries: 2,
                signal: opts.signal,
              })) as CrawlStatus)
            : undefined;
        }
        if (pages.length === 0) throw new SearchError('firecrawl', 'empty_results', 'crawl returned no pages');
        auditSearchCall({ provider: 'firecrawl', endpoint: '/crawl', query: url, resultCount: pages.length, ok: true });
        return pages;
      }
      // Abort-aware sleep: a cancelled task must not wait out the poll interval.
      await delay(pollIntervalMs, undefined, { signal: opts.signal });
    }
  } catch (err) {
    // Any exit with a live job — task abort, budget timeout, poll failure — cancels the
    // remote job so it stops spending credits. Harmless on already-terminal jobs.
    if (jobId) cancelCrawlJob(jobId);
    auditFailure('/crawl', url, err);
    throw err;
  }
}

interface ExtractStatus {
  status?: string;
  data?: unknown;
  error?: string;
}

/**
 * Structured extraction from known URLs with a caller-supplied JSON Schema (async job:
 * submit → poll). No DELETE is documented for extract jobs, so a task abort stops
 * polling but cannot cancel the server-side job (bounded: it only touches the given URLs).
 */
export async function firecrawlExtract(
  urls: string[],
  opts: {
    schema: unknown;
    prompt?: string | null;
    signal?: AbortSignal;
    /** Test seams — production callers use the config defaults. */
    pollIntervalMs?: number;
    jobBudgetMs?: number;
  },
): Promise<unknown> {
  const query = `extract: ${urls.join(' ')}`;
  const pollIntervalMs = opts.pollIntervalMs ?? config.firecrawl.crawlPollIntervalMs;
  const deadline = Date.now() + (opts.jobBudgetMs ?? config.firecrawl.extractJobBudgetMs);
  const headers = firecrawlHeaders();
  try {
    const submitted = (await requestJson({
      provider: 'firecrawl',
      url: `${BASE}/extract`,
      headers,
      body: {
        urls,
        schema: opts.schema,
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
      },
      timeoutMs: 30_000,
      retries: 2,
      signal: opts.signal,
    })) as { success?: boolean; id?: string };
    if (!submitted.id) throw new SearchError('firecrawl', 'http', 'extract submit returned no job id');

    for (;;) {
      if (Date.now() >= deadline) {
        throw new SearchError('firecrawl', 'timeout', `extract job did not finish within budget`);
      }
      const status = (await requestJson({
        provider: 'firecrawl',
        url: `${BASE}/extract/${submitted.id}`,
        method: 'GET',
        headers,
        timeoutMs: 30_000,
        retries: 2,
        signal: opts.signal,
      })) as ExtractStatus;
      if (status.status === 'failed' || status.status === 'cancelled') {
        throw new SearchError('firecrawl', 'http', `extract job ${status.status}${status.error ? `: ${status.error}` : ''}`);
      }
      if (status.status === 'completed') {
        if (status.data == null) throw new SearchError('firecrawl', 'empty_results', 'extract returned no data');
        auditSearchCall({ provider: 'firecrawl', endpoint: '/extract', query, resultCount: 1, ok: true });
        return status.data;
      }
      await delay(pollIntervalMs, undefined, { signal: opts.signal });
    }
  } catch (err) {
    auditFailure('/extract', query, err);
    throw err;
  }
}
