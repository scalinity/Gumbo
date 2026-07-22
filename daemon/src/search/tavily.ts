import { config } from '../config.ts';
import { postJson, SearchError } from './client.ts';
import { auditSearchCall } from './audit.ts';
import { recordUsage } from '../usage/recorder.ts';
import { tavilySearchCost } from '../usage/pricing.ts';

// Verified against docs.tavily.com 2026-07: search_depth ∈ basic | advanced | fast |
// ultra-fast (fast/ultra-fast are the 2026 additions, 1 credit like basic).
export type TavilyDepth = 'basic' | 'advanced' | 'fast' | 'ultra-fast';

export interface TavilySource {
  title: string;
  url: string;
}

export interface TavilyLookup {
  answer: string;
  sources: TavilySource[];
  responseTime?: number;
}

interface TavilySearchResponse {
  answer?: string | null;
  results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
  response_time?: number;
}

/**
 * Voice-hot-path Tavily /search: hard timeout, zero retries (fail fast — a voice turn
 * is waiting), and a missing/empty synthesized answer is an error, not a partial result.
 * The client is the audit choke point: every call lands one JSONL line, success or
 * failure — empty_results is a failure (ok: false), matching the Exa client.
 */
export async function tavilySearch(
  query: string,
  opts: { depth?: TavilyDepth; topic?: 'general' | 'news'; maxResults?: number; timeoutMs?: number } = {},
): Promise<TavilyLookup> {
  try {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new SearchError('tavily', 'auth', 'TAVILY_API_KEY is not set');
    const raw = (await postJson({
      provider: 'tavily',
      url: 'https://api.tavily.com/search',
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        query,
        search_depth: opts.depth ?? config.search.tavilyDepth,
        include_answer: true,
        max_results: opts.maxResults ?? config.search.quickLookupMaxResults,
        // 'news' hits Tavily's fresher news lane — better and faster for scores/headlines.
        ...(opts.topic && opts.topic !== 'general' ? { topic: opts.topic } : {}),
      },
      timeoutMs: opts.timeoutMs ?? config.search.quickLookupTimeoutMs,
      retries: 0,
    })) as TavilySearchResponse;
    const answer = (raw.answer ?? '').trim();
    if (!answer) throw new SearchError('tavily', 'empty_results', 'no synthesized answer for query');
    const lookup: TavilyLookup = {
      answer,
      sources: (raw.results ?? [])
        .filter((r): r is { title?: string; url: string } => typeof r.url === 'string')
        .map((r) => ({ title: r.title ?? 'untitled', url: r.url })),
      responseTime: raw.response_time,
    };
    auditSearchCall({ provider: 'tavily', endpoint: '/search', query, resultCount: lookup.sources.length, ok: true });
    const { units, costUsd } = tavilySearchCost(opts.depth ?? config.search.tavilyDepth);
    recordUsage({ provider: 'tavily', kind: 'search', units, costUsd, estimated: true });
    return lookup;
  } catch (err) {
    auditSearchCall({
      provider: 'tavily',
      endpoint: '/search',
      query,
      resultCount: 0,
      ok: false,
      error: err instanceof SearchError ? err.kind : String(err),
    });
    throw err;
  }
}

/**
 * The exact string contract the web_quick_lookup realtime tool returns to the voice
 * model. Success: `answer` first (read it aloud nearly verbatim), sources as metadata.
 * Failure: a structured shape that steers the model to offer backgrounding the
 * question instead of guessing. Never throws.
 */
export async function webQuickLookup(query: string, topic?: 'general' | 'news'): Promise<string> {
  try {
    const { answer, sources } = await tavilySearch(query, { topic });
    return JSON.stringify({ answer, sources });
  } catch (err) {
    const reason = err instanceof SearchError ? err.kind : 'http';
    return JSON.stringify({
      error: 'lookup_failed',
      reason,
      instruction:
        'The quick lookup failed. Do NOT guess or answer from memory. Tell the user the lookup ' +
        'did not come back, and offer to research it as a background task (spawn_subagent) instead.',
    });
  }
}
