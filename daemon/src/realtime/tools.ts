import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { webQuickLookup } from '../search/tavily.ts';
import type { TaskManager } from '../tasks/manager.ts';
import type { Store } from '../events/store.ts';

// Keep note filenames confined to the notes/ dir — one flat, predictable slug per topic.
function noteSlug(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}

export function createOrchestratorTools(manager: TaskManager, store: Store) {
  const spawnSubagent = tool({
    name: 'spawn_subagent',
    description:
      'Spawn a background sub-agent to do research, analysis, or writing. Returns immediately with a task id; the user is notified on completion. The brief must be detailed and self-contained — the sub-agent cannot ask follow-up questions.',
    parameters: z.object({
      title: z.string().describe('Short human-readable task title, a few words'),
      brief: z.string().describe('Detailed, self-contained instructions for the sub-agent'),
    }),
    execute: async ({ title, brief }) => {
      const task = manager.spawnSubagent(title, brief);
      return `Started background task ${task.id} ("${title}"). You will be told when it finishes — no need to wait.`;
    },
  });

  const listTasks = tool({
    name: 'list_tasks',
    description: 'List recent background tasks with their statuses.',
    parameters: z.object({}),
    execute: async () => {
      const tasks = store.listTasks(20);
      if (tasks.length === 0) return 'No tasks yet.';
      return tasks.map((t) => `${t.id} · ${t.title} · ${t.status}`).join('\n');
    },
  });

  const getTaskStatus = tool({
    name: 'get_task_status',
    description: 'Get the current status and recent activity of one background task.',
    parameters: z.object({ task_id: z.string() }),
    execute: async ({ task_id }) => {
      const task = store.getTask(task_id);
      if (!task) return `No task with id ${task_id}.`;
      const recent = store
        .listEvents({ taskId: task_id, limit: 5 })
        .map((e) => `${e.type}: ${JSON.stringify(e.payload).slice(0, 200)}`)
        .join('\n');
      return `${task.title} — ${task.status}\nRecent activity:\n${recent}`;
    },
  });

  const cancelTask = tool({
    name: 'cancel_task',
    description: 'Cancel a running background task.',
    parameters: z.object({ task_id: z.string() }),
    execute: async ({ task_id }) => (manager.cancel(task_id) ? `Cancelled ${task_id}.` : `${task_id} is not running.`),
  });

  const readReport = tool({
    name: 'read_report',
    description: "Read a finished task's report so you can summarize or quote it.",
    parameters: z.object({ task_id: z.string() }),
    execute: async ({ task_id }) => {
      const report = manager.readReport(task_id);
      return report ? report.slice(0, config.reportMaxChars) : `No report for ${task_id} (task may still be running).`;
    },
  });

  const saveNote = tool({
    name: 'save_note',
    description:
      'Persist a note into your organized notes folder, one file per topic. Use this to keep durable knowledge — facts about the user, decisions, running context — organized rather than losing it when the session ends. Append to grow an existing topic; replace to rewrite it.',
    parameters: z.object({
      topic: z.string().describe('Short topic name; becomes the note filename'),
      content: z.string().describe('Markdown to store'),
      mode: z.enum(['append', 'replace']).default('append'),
    }),
    execute: async ({ topic, content, mode }) => {
      const slug = noteSlug(topic);
      const path = join(config.home.notes, `${slug}.md`);
      if (mode === 'replace') {
        writeFileSync(path, `# ${topic}\n\n${content}\n`);
      } else {
        appendFileSync(path, `${content}\n`);
      }
      store.addEvent(null, 'note.saved', { topic, slug, mode });
      return `Saved note "${topic}" (${mode}) → notes/${slug}.md`;
    },
  });

  // Hot path: Tavily, ≤2 s, no retries. The description below IS the router between this
  // and spawn_subagent — its wording is part of the spec; don't loosen it.
  const quickLookup = tool({
    name: 'web_quick_lookup',
    description:
      "Use ONLY for quick factual lookups about the current world — scores, prices, weather, news " +
      "one-liners, 'is X true today'. For anything open-ended, multi-part, or research-like, do NOT " +
      'use this tool; delegate to the background task queue (spawn_subagent) instead. Returns a ' +
      'spoken-ready `answer` (read it aloud nearly verbatim) plus source titles/URLs as metadata. ' +
      'If it returns lookup_failed, follow its instruction — never guess.',
    parameters: z.object({
      query: z.string().describe('One specific, factual question about the current world'),
      topic: z
        .enum(['general', 'news'])
        .default('general')
        .describe("'news' for scores, headlines, breaking or very recent events; 'general' otherwise"),
    }),
    execute: async ({ query, topic }) => webQuickLookup(query, topic),
  });

  return [spawnSubagent, quickLookup, listTasks, getTaskStatus, cancelTask, readReport, saveNote];
}
