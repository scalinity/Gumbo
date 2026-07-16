// Shared HTTP layer for web-search providers (Tavily, Exa). One POST helper with the
// repo-wide retry policy and one typed error so callers branch on `kind`, never on
// message strings.

export type Provider = 'tavily' | 'exa';
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
 * POST JSON to a provider. Retries only 429/5xx (backoff), never auth or other 4xx.
 * The voice hot path passes retries: 0 — a waiting voice turn must fail fast, not
 * stack backoff.
 */
export async function postJson(opts: {
  provider: Provider;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  retries: number;
  retryDelaysMs?: number[];
}): Promise<unknown> {
  const delays = opts.retryDelaysMs ?? [500, 1500];
  let lastError: SearchError;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
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
