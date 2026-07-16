import { Agent, run, tool, codeInterpreterTool } from '@openai/agents';
import { z } from 'zod';
import { config } from '../config.ts';
import type { Store } from '../events/store.ts';
import { exaSearch, exaContents, type ExaResult } from '../search/exa.ts';
import { SearchError } from '../search/client.ts';

const INSTRUCTIONS = `You are a background sub-agent working for Gumbo, a personal voice assistant.
You were spawned to complete one task. Work autonomously — nobody will answer questions.
Use web_search whenever current or factual information matters; when the highlights aren't enough,
follow up with fetch_page_contents on the most promising URLs to read them in full. Cite source URLs.
Your FINAL message must be the complete deliverable as a well-structured markdown report
(it is saved verbatim as report.md and read back to the user), starting with a one-paragraph summary.`;

function formatResults(results: ExaResult[]): string {
  return results
    .map((r) => {
      const highlights = (r.highlights ?? []).map((h) => `> ${h}`).join('\n');
      return `## ${r.title ?? 'untitled'}\n${r.url}\n${r.publishedDate ?? ''}\n${highlights}\n\n${r.text ?? ''}`;
    })
    .join('\n\n---\n\n');
}

// Tools close over the task so every raw result lands in searchable memory under its id.
function createSubagentTools(taskId: string, store: Store) {
  const persist = (query: string, results: ExaResult[]) => {
    for (const r of results) {
      store.saveSearchResult({
        taskId,
        provider: 'exa',
        query,
        url: r.url,
        title: r.title ?? undefined,
        body: r.text ?? (r.highlights ?? []).join('\n'),
      });
    }
  };
  // Provider failures come back to the model as text so it can adapt mid-task instead of dying.
  const describeFailure = (name: string, err: unknown) => {
    if (err instanceof SearchError) {
      return `${name} failed (${err.kind}): ${err.message}. Adjust the query/urls or continue without it.`;
    }
    throw err;
  };

  const webSearch = tool({
    name: 'web_search',
    description:
      'Search the live web (Exa). Returns titles, URLs, highlights, and FULL page text for the top ' +
      'results. Use tier "deep" only when the brief is explicitly research-class (thorough, ' +
      'multi-source investigation); otherwise leave it "auto".',
    parameters: z.object({
      query: z.string(),
      tier: z.enum(['fast', 'auto', 'deep']).default('auto'),
    }),
    async execute({ query, tier }) {
      try {
        const results = await exaSearch(query, { tier });
        persist(query, results);
        return formatResults(results);
      } catch (err) {
        return describeFailure('web_search', err);
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
        const results = await exaContents(urls);
        persist(`contents: ${urls.join(' ')}`, results);
        return formatResults(results);
      } catch (err) {
        return describeFailure('fetch_page_contents', err);
      }
    },
  });

  return [webSearch, fetchPageContents, codeInterpreterTool()];
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
    instructions: INSTRUCTIONS,
    model: config.models.subagent,
    tools: createSubagentTools(taskId, store),
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
