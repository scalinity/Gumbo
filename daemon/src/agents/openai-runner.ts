import { Agent, run, tool, codeInterpreterTool } from '@openai/agents';
import { z } from 'zod';
import { Exa } from 'exa-js';
import { config } from '../config.ts';
import type { Store } from '../events/store.ts';

let exa: Exa | null = null;

const webSearch = tool({
  name: 'web_search',
  description: 'Search the live web. Returns titles, URLs, publish dates, and page text for the top results.',
  parameters: z.object({
    query: z.string(),
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
  async execute({ query, max_age_days }) {
    exa ??= new Exa(process.env.EXA_API_KEY);
    const { results } = await exa.searchAndContents(query, {
      type: 'auto',
      numResults: 5,
      text: { maxCharacters: 2000 },
      // Maps to Exa's startPublishedDate — a hard API-level cutoff, not a prompt hint.
      // Verified live: with 1 day, every result's publishedDate fell inside 24 h.
      ...(max_age_days != null && {
        startPublishedDate: new Date(Date.now() - max_age_days * 86_400_000).toISOString(),
      }),
    });
    return results
      .map((r: { title?: string | null; url: string; publishedDate?: string; text?: string }) =>
        `## ${r.title ?? 'untitled'}\n${r.url}\n${r.publishedDate ?? ''}\n${r.text ?? ''}`)
      .join('\n\n');
  },
});

// Rebuilt per run so the date is always current — without it the model assumes its
// training-data "today" and returns stale results for time-sensitive briefs.
function instructions(): string {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  return `You are a background sub-agent working for Gumbo, a personal voice assistant.
Today is ${today} — treat words like "today", "latest", and "recent" relative to that date.
You were spawned to complete one task. Work autonomously — nobody will answer questions.
Use web_search whenever current or factual information matters; include the current month and
year in queries about recent events, prefer recently-published results, and cite source URLs.
For time-sensitive briefs (news, scores, "latest", "today"): search snippets are often stale
previews — when you see an event scheduled for today or recently, run a follow-up search to
check whether it has ALREADY CONCLUDED and report the outcome, not the preview. A report that
calls a finished event "upcoming" is wrong. Say explicitly what you could not confirm.
Scope searches with web_search's max_age_days: 1 when the brief says "today", 2–7 for "this
week" — this excludes stale sources at the API level. Loosen it only if a tight search comes
back empty, and say so if you had to.
Your FINAL message must be the complete deliverable as a well-structured markdown report
(it is saved verbatim as report.md and read back to the user), starting with a one-paragraph summary.`;
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
    tools: [webSearch, codeInterpreterTool()],
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
