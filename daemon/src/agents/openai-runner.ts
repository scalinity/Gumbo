import { Agent, run, tool, codeInterpreterTool } from '@openai/agents';
import { z } from 'zod';
import { config, todayLabel } from '../config.ts';
import type { Store } from '../events/store.ts';
import { exaSearch, exaContents, type ExaResult } from '../search/exa.ts';
import { firecrawlScrape, firecrawlMap, firecrawlCrawl, firecrawlExtract, type FirecrawlPage } from '../scrape/firecrawl.ts';
import { SearchError } from '../search/client.ts';

// Rebuilt per run so the date is always current — without it the model assumes its
// training-data "today" and returns stale results for time-sensitive briefs.
function instructions(): string {
  return `You are a background sub-agent working for Gumbo, a personal voice assistant.
Today is ${todayLabel()} — treat words like "today", "latest", and "recent" relative to that date.
You were spawned to complete one task. Work autonomously — nobody will answer questions.
Use web_search whenever current or factual information matters; include the current month and
year in queries about recent events, prefer recently-published results, and cite source URLs.
When the highlights aren't enough, follow up with fetch_page_contents on the most promising
URLs to read them in full.
For time-sensitive briefs (news, scores, "latest", "today"): search snippets are often stale
previews — when you see an event scheduled for today or recently, run a follow-up search to
check whether it has ALREADY CONCLUDED and report the outcome, not the preview. A report that
calls a finished event "upcoming" is wrong. Say explicitly what you could not confirm.
Scope searches with web_search's max_age_days: 1 when the brief says "today", 2–7 for "this
week" — this excludes stale sources at the API level. Loosen it only if a tight search comes
back empty, and say so if you had to.
When the brief or your searches give you specific URLs or a known site, acquire content with
scrape_page (one page, full markdown), map_site (list a site's URLs), crawl_site (a bounded
site section), or extract_structured (schema-shaped JSON). Prefer map_site then scrape_page
on the few pages that matter over crawl_site — crawls cost per page. These tools fetch known
locations; they never search.
Your FINAL message must be the complete deliverable as a well-structured markdown report
(it is saved verbatim as report.md and read back to the user), starting with a one-paragraph summary.`;
}

function formatResults(results: ExaResult[]): string {
  return results
    .map((r) => {
      const highlights = (r.highlights ?? []).map((h) => `> ${h}`).join('\n');
      return `## ${r.title ?? 'untitled'}\n${r.url}\n${r.publishedDate ?? ''}\n${highlights}\n\n${r.text ?? ''}`;
    })
    .join('\n\n---\n\n');
}

// Persistence is deferred and best-effort: FTS tokenization of full page bodies (up to
// ~200 KB each) is synchronous sqlite work on the same loop that carries realtime audio,
// so rows are indexed one per event-loop turn — and an indexing failure logs and moves on
// rather than discarding a successful search or failing the task.
export function persistResults(
  store: Pick<Store, 'saveSearchResult'>,
  taskId: string,
  query: string,
  results: Array<Pick<ExaResult, 'url' | 'title' | 'text' | 'highlights'>>,
  provider: 'exa' | 'firecrawl' = 'exa',
) {
  const rows = results.map((r) => ({
    taskId,
    provider,
    query,
    url: r.url,
    title: r.title ?? undefined,
    body: r.text ?? (r.highlights ?? []).join('\n'),
  }));
  const next = () => {
    const row = rows.shift();
    if (!row) return;
    try {
      store.saveSearchResult(row);
    } catch (err) {
      console.error(`task ${taskId}: memory persist failed (continuing):`, err);
    }
    setImmediate(next);
  };
  setImmediate(next);
}

// Provider failures come back to the model as text so it can adapt mid-task instead of
// dying; anything else (cancellation, programming errors) propagates and fails the run.
export function describeToolFailure(name: string, err: unknown): string {
  if (err instanceof SearchError) {
    return `${name} failed (${err.kind}): ${err.message}. Adjust the query/urls or continue without it.`;
  }
  throw err;
}

// Tools close over the task so every raw result lands in searchable memory under its id,
// and over the abort signal so cancelling the task tears down in-flight provider requests.
function createSubagentTools(taskId: string, store: Store, signal: AbortSignal) {

  const webSearch = tool({
    name: 'web_search',
    description:
      'Search the live web (Exa). Returns titles, URLs, highlights, and FULL page text for the top ' +
      'results. Use tier "deep" only when the brief is explicitly research-class (thorough, ' +
      'multi-source investigation); otherwise leave it "auto".',
    parameters: z.object({
      query: z.string(),
      tier: z.enum(['fast', 'auto', 'deep']).default('auto'),
      max_age_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .nullable()
        .describe(
          'Hard recency filter: only pages published within the last N days. Use 1 for "today" briefs, 2–7 for "this week". Pass null for evergreen topics.',
        ),
    }),
    async execute({ query, tier, max_age_days }) {
      try {
        const results = await exaSearch(query, { tier, signal, maxAgeDays: max_age_days });
        persistResults(store, taskId, query, results);
        return formatResults(results);
      } catch (err) {
        return describeToolFailure('web_search', err);
      }
    },
  });

  const fetchPageContents = tool({
    name: 'fetch_page_contents',
    description:
      'Fetch the full text of specific pages by URL (Exa /contents). Use after web_search when the ' +
      'most promising results deserve a complete read, not just highlights.',
    parameters: z.object({ urls: z.array(z.string()).min(1).max(10) }),
    async execute({ urls }) {
      try {
        const results = await exaContents(urls, { signal });
        persistResults(store, taskId, `contents: ${urls.join(' ')}`, results);
        return formatResults(results);
      } catch (err) {
        return describeToolFailure('fetch_page_contents', err);
      }
    },
  });

  // Firecrawl page → the shared formatResults/persistResults row shape.
  const pageRows = (pages: FirecrawlPage[]) =>
    pages.map((p) => ({ title: p.title ?? null, url: p.url, text: p.markdown }));

  // Firecrawl tools: content acquisition from KNOWN URLs/sites only — never a third
  // search provider. The descriptions are the router; their wording is load-bearing.
  const scrapePage = tool({
    name: 'scrape_page',
    description:
      'Fetch one page you already have the URL for and return its full content as clean markdown ' +
      '(Firecrawl; renders JavaScript, so dynamic pages work). Content acquisition only — it cannot ' +
      'find pages. To discover information or URLs, use web_search instead.',
    parameters: z.object({
      url: z.string(),
      wait_for_ms: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .nullable()
        .describe('Extra milliseconds to let a dynamic page settle before capture; null for normal pages'),
    }),
    async execute({ url, wait_for_ms }) {
      try {
        const page = await firecrawlScrape(url, { waitForMs: wait_for_ms, signal });
        persistResults(store, taskId, `scrape: ${url}`, pageRows([page]), 'firecrawl');
        return formatResults(pageRows([page]));
      } catch (err) {
        return describeToolFailure('scrape_page', err);
      }
    },
  });

  const mapSite = tool({
    name: 'map_site',
    description:
      "List the URLs of a website you already know (Firecrawl /map) — cheap, fast site-structure " +
      'discovery. Prefer map_site followed by scrape_page on the few URLs that matter over ' +
      'crawl_site, which costs credits per page. This ' +
      'lists ONE known site’s pages; it does not search the web.',
    parameters: z.object({
      url: z.string(),
      limit: z.number().int().min(1).max(5000).default(500),
    }),
    async execute({ url, limit }) {
      try {
        const links = await firecrawlMap(url, { limit, signal });
        return links.map((l) => (l.title ? `${l.url} — ${l.title}` : l.url)).join('\n');
      } catch (err) {
        return describeToolFailure('map_site', err);
      }
    },
  });

  const crawlSite = tool({
    name: 'crawl_site',
    description:
      'Crawl a site or site section you already know, from a seed URL, returning full markdown for ' +
      'every page (Firecrawl). EXPENSIVE — one credit per page — so prefer map_site + scrape_page ' +
      'when only part of a site matters. Breadth is bounded by max_pages/max_depth and optional ' +
      'path patterns; robots.txt is respected. Content acquisition from a known site only — never ' +
      'use it to search.',
    parameters: z.object({
      url: z.string(),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Hard cap on pages crawled (each costs a credit) — keep it as low as the task allows'),
      max_depth: z.number().int().min(1).max(10).default(3).describe('Maximum link-discovery depth from the seed URL'),
      include_paths: z
        .array(z.string())
        .nullable()
        .describe('Regex pathname patterns to include, e.g. ["^/docs/.*"]; null for the whole site'),
      exclude_paths: z.array(z.string()).nullable().describe('Regex pathname patterns to exclude'),
    }),
    async execute({ url, max_pages, max_depth, include_paths, exclude_paths }) {
      try {
        // Progress lands in the task's activity feed (dashboard + bubble mini-panel);
        // emit only on change so a long poll loop doesn't flood the event store.
        let lastCompleted = -1;
        const pages = await firecrawlCrawl(url, {
          maxPages: max_pages,
          maxDepth: max_depth,
          includePaths: include_paths,
          excludePaths: exclude_paths,
          signal,
          onProgress: (p) => {
            if (p.completed === lastCompleted) return;
            lastCompleted = p.completed;
            store.addEvent(taskId, 'crawl.status', { url, ...p });
          },
        });
        persistResults(store, taskId, `crawl: ${url}`, pageRows(pages), 'firecrawl');
        return formatResults(pageRows(pages));
      } catch (err) {
        return describeToolFailure('crawl_site', err);
      }
    },
  });

  const extractStructured = tool({
    name: 'extract_structured',
    description:
      'Extract structured JSON from pages you already know, shaped by a JSON Schema you supply ' +
      '(Firecrawl /extract). Use it to pull specific fields — prices, specs, listings — out of ' +
      'known URLs. Not a search tool.',
    parameters: z.object({
      urls: z.array(z.string()).min(1).max(10),
      schema: z.string().describe('JSON Schema (as a JSON string) describing the exact output shape'),
      prompt: z.string().nullable().describe('Optional guidance on what to extract'),
    }),
    async execute({ urls, schema, prompt }) {
      let parsedSchema: unknown;
      try {
        parsedSchema = JSON.parse(schema);
      } catch {
        return 'extract_structured failed: `schema` is not valid JSON — pass a JSON Schema object as a JSON string.';
      }
      try {
        const data = await firecrawlExtract(urls, { schema: parsedSchema, prompt, signal });
        const json = JSON.stringify(data, null, 2);
        // One memory row per source URL (max 10) so every record carries its own provenance.
        persistResults(
          store,
          taskId,
          `extract: ${urls.join(' ')}`,
          urls.map((u) => ({ title: 'structured extraction', url: u, text: json })),
          'firecrawl',
        );
        return json;
      } catch (err) {
        return describeToolFailure('extract_structured', err);
      }
    },
  });

  return [webSearch, fetchPageContents, scrapePage, mapSite, crawlSite, extractStructured, codeInterpreterTool()];
}

function itemText(item: unknown): string {
  const raw = (item as { rawItem?: { content?: unknown } }).rawItem;
  const content = raw?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => p?.text ?? p?.transcript ?? '').join('');
  }
  return '';
}

export async function runSubagent(opts: {
  taskId: string;
  brief: string;
  store: Store;
  signal: AbortSignal;
}): Promise<string> {
  const { taskId, brief, store, signal } = opts;
  const agent = new Agent({
    name: `subagent-${taskId}`,
    instructions: instructions(),
    model: config.models.subagent,
    tools: createSubagentTools(taskId, store, signal),
  });

  // Pass the signal so the SDK aborts the underlying model/tool request promptly on cancel;
  // the in-loop check below stays as a belt-and-suspenders guard between stream events.
  const stream = await run(agent, brief, { stream: true, maxTurns: 25, signal });
  const limit = config.activityLogMaxChars;
  for await (const event of stream) {
    if (signal.aborted) {
      throw new Error('cancelled');
    }
    if (event.type !== 'run_item_stream_event') continue;
    const item = event.item;
    if (item.type === 'tool_call_item') {
      const raw = item.rawItem as { name?: string; arguments?: string; type?: string };
      store.addEvent(taskId, 'tool.call', { name: raw.name ?? raw.type, args: raw.arguments?.slice(0, limit) });
    } else if (item.type === 'tool_call_output_item') {
      store.addEvent(taskId, 'tool.result', { output: String((item as { output?: unknown }).output ?? '').slice(0, limit) });
    } else if (item.type === 'message_output_item') {
      store.addEvent(taskId, 'subagent.message', { text: itemText(item) });
    }
  }
  await stream.completed;
  return String(stream.finalOutput ?? '');
}
