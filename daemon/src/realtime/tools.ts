import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { webQuickLookup } from '../search/tavily.ts';
import { runImageGeneration } from '../images/generate.ts';
import { runImageEdit } from '../images/edit.ts';
import { safeImageFile } from '../images/files.ts';
import type { ImageEditContext } from '../images/context.ts';
import type { TaskManager } from '../tasks/manager.ts';
import type { Store } from '../events/store.ts';
import type { Scheduler } from '../schedule/scheduler.ts';

// Keep note filenames confined to the notes/ dir — one flat, predictable slug per topic.
function noteSlug(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}

// Spoken-friendly fire time for tool results (the model relays these nearly verbatim).
function fireAtLabel(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** M5 seams the tools need beyond manager/store: the scheduler, the orchestrator's
 *  proactive-speech path (image completions announce through it), and the shell image
 *  viewer's live context (which image + brush selection a voice edit targets). */
export interface OrchestratorToolDeps {
  scheduler: Scheduler;
  announce: (coldText: string, liveInstructions: string) => Promise<void>;
  imageContext: ImageEditContext;
}

export function createOrchestratorTools(manager: TaskManager, store: Store, deps: OrchestratorToolDeps) {
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
      // The voice model tends to echo tool results verbatim — keep the id clearly
      // marked as internal so it isn't read aloud.
      return `Started "${title}" in the background (internal task_id ${task.id} — never say it aloud). You will be told when it finishes — no need to wait.`;
    },
  });

  // M4: real code/file/shell work = a full Claude Code session, supervised. The
  // description routes between this and spawn_subagent (research/writing) — like
  // web_quick_lookup, its wording is part of the spec.
  const spawnClaudeSession = tool({
    name: 'spawn_claude_session',
    description:
      'Start a supervised Claude Code session as a background task for real code, file, or shell work ' +
      'on this Mac — writing or changing code, running commands, working in a repo. NOT for research ' +
      'or writing prose (use spawn_subagent). Returns immediately; a supervisor answers its questions ' +
      'and dangerous actions ask the user via the notch. The brief must be detailed and self-contained.',
    parameters: z.object({
      title: z.string().describe('Short human-readable task title, a few words'),
      brief: z.string().describe('Detailed, self-contained instructions for the coding session'),
      project_dir: z
        .string()
        .nullable()
        .describe(
          'Absolute path of the project directory to work in, ONLY if the user named one (or a note holds it). Pass null to work in a fresh private workspace — never guess a path.',
        ),
    }),
    execute: async ({ title, brief, project_dir }) => {
      try {
        const task = manager.spawnClaudeSession(title, brief, project_dir);
        return `Started Claude Code session "${title}" in the background (internal task_id ${task.id} — never say it aloud). You will be told when it finishes — no need to wait.`;
      } catch (err) {
        return `Could not start the session: ${String(err)}. Ask the user to clarify the project location.`;
      }
    },
  });

  const sendToSession = tool({
    name: 'send_to_session',
    description:
      'Send a follow-up instruction, answer, or course-correction into a Claude Code session — use it ' +
      'when a session is paused needing input, when the user wants to redirect one, or to resume a ' +
      'session that was interrupted (e.g. by a restart). The message must be self-contained.',
    parameters: z.object({
      task_id: z.string(),
      message: z.string().describe("the user's instruction or answer, self-contained"),
    }),
    execute: async ({ task_id, message }) => {
      try {
        const outcome = manager.sendToSession(task_id, message);
        return outcome === 'queued'
          ? 'Delivered to the running session.'
          : 'Session resumed with the message. You will be told when it finishes.';
      } catch (err) {
        return `Could not deliver: ${String(err)}`;
      }
    },
  });

  const undoSession = tool({
    name: 'undo_session',
    description:
      "Undo a running Claude Code session's file changes — rewind the files it edited back to the start " +
      'of its current run. Use when the user wants to throw away what a session just did. Only works while ' +
      'the session is still live and not paused waiting on input; a finished session\'s edits are recovered via git instead.',
    parameters: z.object({ task_id: z.string() }),
    execute: async ({ task_id }) => manager.undoSession(task_id),
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

  // M5: image generation takes tens of seconds — never block the voice turn on it. The
  // tool acks instantly; the background half emits image.created (filename only) and
  // speaks a brief completion through the M3 announce path when the PNG lands.
  const generateImage = tool({
    name: 'generate_image',
    description:
      'Generate an image from a text prompt. Returns immediately — the image lands in the ' +
      "dashboard gallery seconds later and you will be told when it's ready, so tell the user " +
      "it's on the way and move on. Write a vivid, self-contained prompt.",
    parameters: z.object({
      prompt: z.string().describe('Complete visual description of the image to generate'),
      shape: z
        .enum(['square', 'landscape', 'portrait'])
        .default('square')
        .describe("'landscape' for wallpapers and scenes, 'portrait' for people or posters, 'square' otherwise"),
    }),
    execute: async ({ prompt, shape }) => {
      // Fire-and-forget: runImageGeneration handles (and speaks) its own failures; this
      // catch only guards the announce path itself so nothing becomes an unhandled rejection.
      runImageGeneration({ prompt, shape, store, announce: deps.announce }).catch((err: unknown) => {
        store.addEvent(null, 'session.error', { message: `image announce: ${String(err)}` });
      });
      return "Image generation started in the background — tell the user it's on the way. You will be told when it lands in his gallery; no need to wait.";
    },
  });

  // M5.5: edits ride the shell viewer's armed context — the user highlights an area with
  // the brush and just SAYS the change; the strokes never pass through the voice model.
  const editImageTool = tool({
    name: 'edit_image',
    description:
      'Edit a previously generated image with a plain-language instruction. Use when the user asks to ' +
      'change, tweak, fix, or redo an image. If he is viewing one in the image panel, that image — ' +
      'and any area he highlighted with the brush — is targeted automatically: pass file null. Only ' +
      'pass a filename if the user explicitly named a different image. Returns immediately; the edit ' +
      "lands as a NEW version and you will be told when it's ready.",
    parameters: z.object({
      prompt: z.string().describe("The edit instruction, faithful to the user's words"),
      file: z
        .string()
        .nullable()
        .describe('null = the image the user is currently viewing (the usual case); a filename only if he named one'),
    }),
    execute: async ({ prompt, file }) => {
      const ctx = deps.imageContext.get();
      const named = file?.trim() || null;
      const target = named ?? ctx?.file;
      if (!target) {
        return 'No image is open in the viewer and none was named — ask the user to open the image (click its thumbnail) or say which one to edit.';
      }
      // The brush selection belongs to the viewer's image; a differently-named target
      // must not inherit it.
      const strokes = named && named !== ctx?.file ? undefined : ctx?.strokes;
      try {
        safeImageFile(target);
      } catch {
        return `"${target}" is not a valid image filename — check the gallery name and try again.`;
      }
      runImageEdit({ file: target, prompt, strokes, store, announce: deps.announce }).catch((err: unknown) => {
        store.addEvent(null, 'session.error', { message: `image edit announce: ${String(err)}` });
      });
      return `Edit started in the background${strokes && strokes.length > 0 ? ' on the highlighted area' : ''} — tell the user it's on the way. You will be told when the new version lands; no need to wait.`;
    },
  });

  // M5 reminders: one call, both halves — a schedule row (Gumbo speaks it when it fires)
  // AND an EventKit mirror in Reminders.app (OS-durable, fires even if Gumbo is off).
  const setReminder = tool({
    name: 'set_reminder',
    description:
      "Set a reminder for the user. It goes into Gumbo's own scheduler (you will speak it at the " +
      'right time) AND into Reminders.app (so it fires even if Gumbo is off). You must resolve ' +
      'natural phrasing ("at 5", "in 10 minutes") to an absolute future local date-time yourself ' +
      'using the current date and time from your instructions.',
    parameters: z.object({
      text: z.string().describe('What to remind the user about, in his words'),
      fire_at: z
        .string()
        .describe('Absolute LOCAL date-time, ISO 8601 with no timezone suffix, e.g. 2026-07-16T17:00:00'),
    }),
    execute: async ({ text, fire_at }) => {
      // Shape guard BEFORE parsing (review 🔵, corroborated): Date.parse treats
      // date-only strings and Z/offset forms as UTC — hours silently off with only
      // future-ness validated. Require a local date-time, reject everything else.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(fire_at) || /(z|[+-]\d{2}:?\d{2})$/i.test(fire_at)) {
        return `fire_at must be a LOCAL date-time like 2026-07-16T17:00:00 — no date-only strings, no timezone suffix. Got "${fire_at}"; re-resolve and call again.`;
      }
      // Date.parse of a no-offset ISO date-time is local time (ES2015+) — exactly the
      // contract the parameter asks for.
      const fireAtMs = Date.parse(fire_at);
      if (Number.isNaN(fireAtMs)) {
        return `Could not parse "${fire_at}" — pass an ISO local date-time like 2026-07-16T17:00:00.`;
      }
      if (fireAtMs <= Date.now()) {
        // Include the CURRENT time (review 🟡): the session's instructions carry the
        // clock from connect time, which goes stale in a long session — this is the
        // model's only fresh reference to re-resolve "in 10 minutes" against.
        return `${fireAtLabel(fireAtMs)} is in the past — it is now ${fireAtLabel(Date.now())}. Re-resolve the time against that and call again.`;
      }
      const row = deps.scheduler.setReminder(text, fireAtMs);
      return `Reminder set for ${fireAtLabel(row.fire_at)} (internal id ${row.id} — never say it aloud).`;
    },
  });

  const listReminders = tool({
    name: 'list_reminders',
    description:
      "List the user's reminders — upcoming first, then recently fired/cancelled. Use it to answer " +
      '"what are my reminders" and to find the id for cancel_reminder.',
    parameters: z.object({}),
    execute: async () => {
      const rows = deps.scheduler.listReminders();
      if (rows.length === 0) return 'No reminders.';
      return rows
        .map((r) => `${r.id} · ${r.status} · ${fireAtLabel(r.fire_at)} · ${r.text}`)
        .join('\n');
    },
  });

  const cancelReminder = tool({
    name: 'cancel_reminder',
    description:
      'Cancel a pending reminder (removes it from both the scheduler and Reminders.app). Get the ' +
      'id from list_reminders; ids are internal — never say one aloud.',
    parameters: z.object({ reminder_id: z.string() }),
    execute: async ({ reminder_id }) => {
      const row = deps.scheduler.cancelReminder(reminder_id);
      return row
        ? `Cancelled the reminder "${row.text}".`
        : `No pending reminder with that id — it may have fired or been cancelled already. Check list_reminders.`;
    },
  });

  // Hot path: Tavily, hard-capped at config.search.quickLookupTimeoutMs, no retries. The
  // description below IS the router between this and spawn_subagent — its wording is part
  // of the spec; don't loosen it.
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

  return [
    spawnSubagent, spawnClaudeSession, sendToSession, undoSession, quickLookup,
    generateImage, editImageTool, setReminder, listReminders, cancelReminder,
    listTasks, getTaskStatus, cancelTask, readReport, saveNote,
  ];
}
