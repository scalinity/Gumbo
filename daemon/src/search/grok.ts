import { config } from '../config.ts';
import { postJson, SearchError } from './client.ts';
import { auditSearchCall } from './audit.ts';

// Grok (xAI) live X/web search via the Agent Tools API — `POST /v1/responses` with server-side
// `web_search`/`x_search` tools (verified against the live API 2026-07-16). The older declarative
// Live Search (`/v1/chat/completions` + `search_parameters`) is DECOMMISSIONED — it returns HTTP
// 410 "switch to the Agent Tools API", which the live smoke caught. Grok agentically decides how
// to query X/web, then returns a trailing `message` item whose `output_text` carries the answer
// and `url_citation` annotations. Still a single non-streaming POST, so it rides the shared
// postJson/SearchError/audit contract like the other providers.

export interface GrokSource {
  title: string;
  url: string;
}

export interface GrokLookup {
  answer: string;
  sources: GrokSource[];
  /** Grok's own server-side sub-searches ("x_keyword_search: from:OpenAI …") — transcript
   *  material for background consumers; the spoken hot path ignores it. */
  trace?: string[];
}

interface ResponsesAnnotation {
  type?: string;
  url?: string;
}

interface ResponsesContentPart {
  type?: string;
  text?: string;
  annotations?: ResponsesAnnotation[];
}

interface ResponsesOutputItem {
  type?: string;
  role?: string;
  content?: ResponsesContentPart[];
  /** custom_tool_call items (measured live 2026-07-22): Grok's own server-side searches,
   *  e.g. name "x_keyword_search" with input '{"query":"from:OpenAI since:…"}'. */
  name?: string;
  input?: string;
}

interface GrokResponse {
  status?: string;
  error?: unknown;
  output?: ResponsesOutputItem[];
}

// Two system prompts (Responses API `instructions`) for the two consumers: the hot path wants a
// spoken one-liner; the background sub-agent wants a fuller, quotable brief. Both are X-first —
// that is the whole reason to reach for Grok over Tavily/Exa. Both forbid inline citation markers
// (belt to the code strip below) so the spoken answer stays clean.
const SYSTEM: Record<'spoken' | 'detailed', string> = {
  spoken:
    "You are Gumbo's live X lookup. Answer in 1–3 spoken-ready sentences — no preamble, no " +
    'markdown, no lists, and NO inline citation markers or bracketed reference numbers. Prefer ' +
    'what is happening on X (Twitter) right now: paraphrase the relevant post(s) and NAME the ' +
    'account (e.g. @AnthropicAI). Web sources are a fallback. If you cannot find it, say so ' +
    'plainly — never guess or pad.',
  detailed:
    "You are Gumbo's live X/social research lookup for a background agent. Report what X is " +
    'saying: summarize the relevant posts, NAME the accounts, quote the key lines, and note ' +
    'timing. Add corroborating web context when it helps. Be thorough and factual; if you cannot ' +
    'confirm something, say so explicitly. Plain prose — no marketing tone.',
};

// Which server-side tool each configured source maps to. Deduped so ['x','web'] → one x_search
// + one web_search.
const TOOL_TYPE: Record<'x' | 'web', string> = { x: 'x_search', web: 'web_search' };
function toolsFromSources(sources: ('x' | 'web')[]): Array<{ type: string }> {
  return [...new Set(sources.map((s) => TOOL_TYPE[s]))].map((type) => ({ type }));
}

function titleForUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'x.com' || host === 'twitter.com' ? 'X post' : host;
  } catch {
    return 'source';
  }
}

// Grok injects markdown citation markers like `[[1]](https://…)` into the answer text; strip them
// so the voice model never tries to read them aloud, then tidy the whitespace they leave behind.
// The URL is matched as `\(\S*\)` (URLs have no spaces) rather than `\([^)]*\)` so a link whose URL
// itself contains parens — e.g. `…/wiki/Foo_(bar)` — is consumed whole, leaving no stray `)`.
function stripInlineCitations(text: string): string {
  return text
    .replace(/\[\[\d+\]\]\(\S*\)/g, '')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Walk every message content part, collecting unique url_citation annotations in order. The
// annotation's own `title` is just the citation number, so derive a spoken-ready title from the URL.
function parseCitations(parts: ResponsesContentPart[]): GrokSource[] {
  const seen = new Set<string>();
  const out: GrokSource[] = [];
  for (const part of parts) {
    for (const ann of part.annotations ?? []) {
      if (ann.type !== 'url_citation' || typeof ann.url !== 'string' || !ann.url || seen.has(ann.url)) continue;
      seen.add(ann.url);
      out.push({ title: titleForUrl(ann.url), url: ann.url });
    }
  }
  return out;
}

/**
 * Core Grok live search. Throws SearchError (kind-mapped by the shared client: 401/403→auth,
 * 429→quota, aborts→timeout) and lands EXACTLY one audit line per call, success or failure —
 * an incomplete response or empty answer is a failure (ok:false), matching Tavily/Exa. The hot
 * path passes retries:0 (a voice turn is waiting); background passes retries:2 + the task signal.
 */
export async function grokLiveSearch(
  query: string,
  opts: {
    model?: string;
    style?: 'spoken' | 'detailed';
    timeoutMs?: number;
    retries?: number;
    signal?: AbortSignal;
  } = {},
): Promise<GrokLookup> {
  try {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new SearchError('grok', 'auth', 'XAI_API_KEY is not set');
    const raw = (await postJson({
      provider: 'grok',
      url: 'https://api.x.ai/v1/responses',
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        // Tiered: xLookup passes the fast non-reasoning hotModel; background defaults to the
        // deeper reasoning model. (max_tool_calls is deliberately omitted — measured live, it
        // doesn't bound the reasoning loop, so the per-call timeout is the real latency guard.)
        model: opts.model ?? config.grok.backgroundModel,
        instructions: SYSTEM[opts.style ?? 'spoken'],
        input: [{ role: 'user', content: query }],
        // Both tools present ⇒ X + web; Grok picks per query.
        tools: toolsFromSources(config.grok.sources),
      },
      timeoutMs: opts.timeoutMs ?? config.grok.backgroundTimeoutMs,
      retries: opts.retries ?? 2,
      signal: opts.signal,
    })) as GrokResponse;
    // Keep a malformed body inside the provider-failure channel (→ text/lookup_failed) instead of
    // a TypeError on raw.status/raw.output that would escape as a non-SearchError. xAI always
    // returns an object, so this is a belt-and-suspenders guard, like the tavily/exa shape casts.
    if (!raw || typeof raw !== 'object') {
      throw new SearchError('grok', 'http', 'non-object response body');
    }
    // A non-completed run (e.g. hit max_tool_calls before answering) has no trustworthy answer.
    if (raw.status && raw.status !== 'completed') {
      throw new SearchError('grok', 'empty_results', `response status ${raw.status}`);
    }
    const parts = (raw.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
    const answer = stripInlineCitations(
      parts
        .filter((p) => p.type === 'output_text')
        .map((p) => p.text ?? '')
        .join('')
        .trim(),
    );
    if (!answer) throw new SearchError('grok', 'empty_results', 'no answer content for query');
    const sources = parseCitations(parts);
    // Grok's OWN sub-searches ride output[] as custom_tool_call items (measured live —
    // the docs don't describe them). Surfaced so a background task's transcript can show
    // what the Grok channel actually searched, not just its synthesized answer. X-side
    // searches carry their full query; web-side ones arrive as web_search_call items
    // whose query xAI does not disclose — counted, never silently dropped.
    const trace: string[] = [];
    for (const o of raw.output ?? []) {
      if (o.type === 'custom_tool_call') {
        let detail = o.input ?? '';
        try {
          const parsed = JSON.parse(o.input ?? '{}') as { query?: unknown };
          if (typeof parsed.query === 'string' && parsed.query) detail = parsed.query;
        } catch { /* unparseable input renders raw */ }
        trace.push(`${o.name ?? 'search'}: ${detail}`.slice(0, 200));
      } else if (o.type === 'web_search_call') {
        trace.push('web_search (query not disclosed by xAI)');
      }
    }
    auditSearchCall({ provider: 'grok', endpoint: '/responses', query, resultCount: sources.length, ok: true });
    return { answer, sources, trace };
  } catch (err) {
    auditSearchCall({
      provider: 'grok',
      endpoint: '/responses',
      query,
      resultCount: 0,
      ok: false,
      error: err instanceof SearchError ? err.kind : String(err),
    });
    throw err;
  }
}

/**
 * The exact string contract the x_lookup realtime tool returns to the voice model — the same
 * shape as tavily.ts's webQuickLookup so the model needs no new parsing. Success: `answer` first
 * (read it aloud nearly verbatim), sources as metadata. Failure: a structured lookup_failed shape
 * that steers the model to offer backgrounding instead of guessing. Never throws. Fast hot model,
 * hot-path budget, and zero retries — a waiting voice turn must fail fast.
 */
export async function xLookup(query: string): Promise<string> {
  try {
    const { answer, sources } = await grokLiveSearch(query, {
      model: config.grok.hotModel,
      style: 'spoken',
      timeoutMs: config.grok.quickLookupTimeoutMs,
      retries: 0,
    });
    return JSON.stringify({ answer, sources });
  } catch (err) {
    const reason = err instanceof SearchError ? err.kind : 'http';
    return JSON.stringify({
      error: 'lookup_failed',
      reason,
      instruction:
        'The X lookup failed. Do NOT guess or answer from memory. Tell the user the X lookup did ' +
        'not come back, and offer to research it as a background task (spawn_subagent) instead.',
    });
  }
}
