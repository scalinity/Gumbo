import { config } from '../config.ts';
import { postJson, SearchError } from './client.ts';
import { auditSearchCall } from './audit.ts';

// Verified against exa.ai/docs 2026-07: Exa 2.0 `type` accepts instant | fast | auto |
// deep-lite | deep | deep-reasoning. Gumbo exposes the three it routes between.
export type ExaTier = 'fast' | 'auto' | 'deep';

export interface ExaResult {
  title: string | null;
  url: string;
  publishedDate?: string;
  author?: string | null;
  text?: string;
  highlights?: string[];
}

interface ExaResponse {
  requestId?: string;
  results?: ExaResult[];
}

function exaHeaders(): Record<string, string> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new SearchError('exa', 'auth', 'EXA_API_KEY is not set');
  return { 'x-api-key': apiKey };
}

// Background quality over latency/cost: full page text + highlights, deliberately
// unclamped — no maxCharacters anywhere on this path.
const FULL_CONTENTS = { text: true, highlights: true };

/** Background Exa /search with full contents. `deep` is for explicitly research-class tasks. */
export async function exaSearch(
  query: string,
  opts: { tier?: ExaTier; numResults?: number } = {},
): Promise<ExaResult[]> {
  const tier = opts.tier ?? 'auto';
  let raw: ExaResponse;
  try {
    raw = (await postJson({
      provider: 'exa',
      url: 'https://api.exa.ai/search',
      headers: exaHeaders(),
      body: {
        query,
        type: tier,
        numResults: opts.numResults ?? config.search.backgroundNumResults,
        contents: FULL_CONTENTS,
      },
      // deep runs multi-step searches server-side; give it real room.
      timeoutMs: tier === 'deep' ? 180_000 : 60_000,
      retries: 2,
    })) as ExaResponse;
  } catch (err) {
    auditFailure('/search', query, err);
    throw err;
  }
  const results = raw.results ?? [];
  if (results.length === 0) {
    const err = new SearchError('exa', 'empty_results', 'no results for query');
    auditFailure('/search', query, err);
    throw err;
  }
  auditSearchCall({ provider: 'exa', endpoint: '/search', query, resultCount: results.length, ok: true });
  return results;
}

/** Follow-up Exa /contents fetch for the most promising URLs — full text, unclamped. */
export async function exaContents(urls: string[]): Promise<ExaResult[]> {
  const query = `contents: ${urls.join(' ')}`;
  let raw: ExaResponse;
  try {
    raw = (await postJson({
      provider: 'exa',
      url: 'https://api.exa.ai/contents',
      headers: exaHeaders(),
      body: { urls, ...FULL_CONTENTS },
      timeoutMs: 60_000,
      retries: 2,
    })) as ExaResponse;
  } catch (err) {
    auditFailure('/contents', query, err);
    throw err;
  }
  const results = raw.results ?? [];
  if (results.length === 0) {
    const err = new SearchError('exa', 'empty_results', 'no contents returned for urls');
    auditFailure('/contents', query, err);
    throw err;
  }
  auditSearchCall({ provider: 'exa', endpoint: '/contents', query, resultCount: results.length, ok: true });
  return results;
}

function auditFailure(endpoint: string, query: string, err: unknown) {
  auditSearchCall({
    provider: 'exa',
    endpoint,
    query,
    resultCount: 0,
    ok: false,
    error: err instanceof SearchError ? err.kind : String(err),
  });
}
