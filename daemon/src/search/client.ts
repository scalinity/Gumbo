// Shared HTTP layer for external providers (Tavily, Exa, Firecrawl). One request helper
// with the repo-wide retry policy and one typed error so callers branch on `kind`, never
// on message strings.

export type Provider = 'tavily' | 'exa' | 'firecrawl';
export type SearchErrorKind = 'timeout' | 'auth' | 'quota' | 'empty_results' | 'http' | 'network';

export class SearchError extends Error {
  provider: Provider;
  kind: SearchErrorKind;
  status?: number;

  // No constructor parameter properties — the daemon runs on strip-only TS (tsx / node).
  constructor(provider: Provider, kind: SearchErrorKind, detail: string, status?: number) {
    super(`${provider} ${kind}: ${detail}`);
    this.name = 'SearchError';
    this.provider = provider;
    this.kind = kind;
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send a JSON request to a provider. Retries only 429/5xx (backoff), never auth or other
 * 4xx. The voice hot path passes retries: 0 — a waiting voice turn must fail fast, not
 * stack backoff. Defaults to POST; GET/DELETE exist for async-job providers (Firecrawl
 * crawl/extract polling + cancellation).
 */
export async function requestJson(opts: {
  provider: Provider;
  url: string;
  method?: 'POST' | 'GET' | 'DELETE';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  retries: number;
  retryDelaysMs?: number[];
  /** Caller cancellation (e.g. task abort) — tears the request down immediately. */
  signal?: AbortSignal;
}): Promise<unknown> {
  const delays = opts.retryDelaysMs ?? [500, 1500];
  let lastError: SearchError;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
    opts.signal?.throwIfAborted();
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(opts.timeoutMs);
      res = await fetch(opts.url, {
        method: opts.method ?? 'POST',
        headers:
          opts.body === undefined ? opts.headers : { 'content-type': 'application/json', ...opts.headers },
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
    } catch (err) {
      // Caller cancellation is not a provider failure — rethrow the raw abort reason so
      // run/task 'cancelled' semantics stay intact upstream.
      if (opts.signal?.aborted) throw err;
      const name = (err as Error)?.name ?? '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new SearchError(opts.provider, 'timeout', `no response within ${opts.timeoutMs} ms`);
      }
      throw new SearchError(opts.provider, 'network', String(err));
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch (err) {
        throw new SearchError(opts.provider, 'http', `invalid JSON in response: ${String(err)}`, res.status);
      }
    }
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new SearchError(opts.provider, 'auth', `HTTP ${res.status} — check API key. ${detail}`, res.status);
    }
    const kind: SearchErrorKind = res.status === 429 ? 'quota' : 'http';
    lastError = new SearchError(opts.provider, kind, `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, res.status);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= opts.retries) throw lastError;
  }
}

/** POST JSON to a provider — the common case. Same contract as requestJson. */
export const postJson = requestJson;
