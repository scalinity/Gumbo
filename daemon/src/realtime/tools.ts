import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { webQuickLookup } from '../search/tavily.ts';
import { xLookup } from '../search/grok.ts';
import { runImageGeneration } from '../images/generate.ts';
import { runImageEdit } from '../images/edit.ts';
import { findGalleryImages, safeImageFile } from '../images/files.ts';
import type { ImageEditContext } from '../images/context.ts';
import { readForPresentation, type PresentedFile } from '../files/present.ts';
import { runFileEdit } from '../files/edit.ts';
import type { FileEditContext } from '../files/context.ts';
import type { TaskManager } from '../tasks/manager.ts';
import type { Store } from '../events/store.ts';
import type { Scheduler } from '../schedule/scheduler.ts';
import type { MacBridge } from '../ws/mac.ts';
import { executeMacDo } from '../mac/run.ts';

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
  /** The shell file viewer's open document (edit_file resolves "this document" from here). */
  fileContext: FileEditContext;
  /** Push a file onto the user's screen (shell document card → Gumbo's renderer).
   *  Returns false when no shell is connected — nothing would be shown. */
  presentFile: (payload: PresentedFile) => boolean;
  /** Open a gallery image in the shell viewer/editor (open_image tool). Returns false
   *  when no shell is connected. */
  openImage: (file: string) => boolean;
  // M6: the hands (shell executor) + the notch confirm for a risky one-shot command.
  macBridge: MacBridge;
  confirmMacDo: (detail: string) => Promise<boolean>;
  /** M8: procedure memory — "save that as a procedure" distills a finished computer
   *  task's trace. Optional so bare test harnesses keep working. */
  procedures?: { saveFromTask(taskId: string, name: string): Promise<{ name: string; version: number; stepCount: number }> };
}

export function createOrchestratorTools(manager: TaskManager, store: Store, deps: OrchestratorToolDeps) {
  const spawnSubagent = tool({
    name: 'spawn_subagent',
    description:
      'Spawn a background sub-agent to do research, analysis, or writing — OR a multi-step task on ' +
      "this Mac's apps and windows (task_type \"mac\"): ACTING INSIDE an app — clicking buttons, typing " +
      'into fields, navigating menus, filling forms, doing something to the content of a page. Merely ' +
      'opening an app OR sending it to a URL is NOT this — that is one command, use mac_do. Reach here ' +
      'only when, after opening, you must click/type/navigate inside. Returns immediately with a task ' +
      'id; the user is notified on completion. The brief must be detailed and self-contained — the ' +
      'sub-agent cannot ask follow-up questions.',
    parameters: z.object({
      title: z.string().describe('Short human-readable task title, a few words'),
      brief: z.string().describe('Detailed, self-contained instructions for the sub-agent'),
      task_type: z
        .enum(['research', 'mac'])
        .default('research')
        .describe('"mac" ONLY for clicking/typing/navigating INSIDE an app — never for merely opening an app or loading a URL (that is mac_do); "research" for everything web/writing'),
    }),
    execute: async ({ title, brief, task_type }) => {
      // The voice model tends to echo tool results verbatim — keep the id clearly
      // marked as internal so it isn't read aloud.
      try {
        const task = manager.spawnSubagent(title, brief, task_type);
        return `Started "${title}" in the background (internal task_id ${task.id} — never say it aloud). You will be told when it finishes — no need to wait.`;
      } catch (err) {
        return `Could not start that: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // M6 hot tier: one-shot Mac commands the voice model writes itself. The description IS
  // the router between this and spawn_subagent(task_type "mac") — one command, one result,
  // sub-second; anything needing looking-then-acting goes to the sub-agent.
  const macDo = tool({
    name: 'mac_do',
    description:
      'Run ONE quick command on this Mac and return its output — a single bash or AppleScript line. ' +
      'Opening an app and sending it to a website is ONE command. IMPORTANT: Gumbo runs in the ' +
      'background, so `open -a` opens an app WITHOUT bringing it to the front — to open an app visibly ' +
      'you MUST use osascript with `activate` (the app fronts itself). Example — "open Chrome and go to ' +
      'claude.ai" is one osascript that foregrounds AND navigates: `tell application "Google Chrome" to ' +
      'activate` then `tell application "Google Chrome" to open location "https://claude.ai"`. Any app: ' +
      '`tell application "Notes" to activate`. Also single-shot: toggle a setting, read system info ' +
      '(tmutil, defaults read, osascript one-liners). Only escalate to spawn_subagent(task_type "mac") ' +
      'when you must then CLICK, TYPE, or navigate menus INSIDE the app. NEVER pair the two for the web: ' +
      'if a computer task will read or act on a page ("check my notifications", "who am I logged in ' +
      'as"), do NOT also open that page here — the task drives its own separate automation browser and ' +
      'navigates itself; opening it in the user\'s Chrome only plants a decoy window. Risky commands ask ' +
      'the user via the notch first; if declined, report that and move on.',
    parameters: z.object({
      script: z.string().describe('The one-liner to run, complete and self-contained'),
      interpreter: z
        .enum(['bash', 'osascript', 'shortcuts'])
        .default('bash')
        .describe("'bash' for shell commands, 'osascript' for AppleScript, 'shortcuts' to run a Shortcut by name"),
    }),
    execute: async ({ script, interpreter }) =>
      executeMacDo(script, interpreter, { macBridge: deps.macBridge, confirm: deps.confirmMacDo }),
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
      'Send a follow-up instruction, answer, or course-correction into a background task: a Claude ' +
      'Code session (paused, needing input, or resuming an interrupted one) — or a RUNNING ' +
      'computer-use task driving this Mac or its browser, where it lands as live steering ("use the ' +
      'personal account", "skip that dialog"). The message must be self-contained.',
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
    description:
      "Get one background task's full picture: status, why it's paused (if it is), its original " +
      'brief, the plan awaiting approval (if any), and recent activity. Use it to answer ANY ' +
      'question about what a task is doing, did, or was originally asked to do — it works for ' +
      'finished and cancelled tasks too, so you can always recover the original instructions.',
    parameters: z.object({ task_id: z.string() }),
    execute: async ({ task_id }) => {
      const task = store.getTask(task_id);
      if (!task) return `No task with id ${task_id}.`;
      // The 5-events × 200-chars digest this replaces left the voice model blind — it could
      // see "paused, blocked" but not the brief, the plan, or what the session had done
      // (live failure 2026-07-16). Everything below survives cancellation and restarts.
      const parts = [`${task.title} — ${task.status}${task.kind === 'claude' ? ' (coding session)' : ''}`];
      const brief = store.getClaudeSession(task_id)?.brief ?? store.getTaskBrief(task_id);
      if (brief) parts.push(`Original brief: ${brief.slice(0, 800)}`);
      const events = store.listEvents({ taskId: task_id, limit: 200 });
      const lastStatus = [...events].reverse().find((e) => e.type === 'task.status');
      const statusReason = (lastStatus?.payload as { reason?: string } | null)?.reason;
      if (task.status === 'needs_input' && statusReason) parts.push(`Paused because: ${statusReason}`);
      if (task.status === 'needs_input') {
        // Direct SQL, not the 200-event window above — a chatty session can push the
        // plan event out of the slice while it's still the one awaiting approval.
        const plan = (store.getLatestEventPayload(task_id, 'claude.plan') as { plan?: string } | null)?.plan;
        if (plan && plan !== '{}') parts.push(`Claude's plan (awaiting the user's approval — read it to him on request):\n${plan.slice(0, 3000)}`);
      }
      const recent = events
        .slice(-12)
        .map((e) => `${e.type}: ${JSON.stringify(e.payload).slice(0, 200)}`)
        .join('\n');
      parts.push(`Recent activity (oldest first):\n${recent}`);
      return parts.join('\n\n');
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
      quality: z
        .enum(['low', 'medium', 'high', 'auto'])
        .default('high')
        .describe("Render quality — default 'high'; lower it ONLY if the user asks for a quick or draft version"),
    }),
    execute: async ({ prompt, shape, quality }) => {
      // Fire-and-forget: runImageGeneration handles (and speaks) its own failures; this
      // catch only guards the announce path itself so nothing becomes an unhandled rejection.
      runImageGeneration({ prompt, shape, quality, store, announce: deps.announce }).catch((err: unknown) => {
        store.addEvent(null, 'session.error', { message: `image announce: ${String(err)}` });
      });
      return 'Image generation started — a generating orb is already on the user\'s screen (top right) and will become the image when it lands; you will be told when it does. If you already told him it\'s coming, add at most ONE short sentence — never repeat yourself, and never tell him to check the gallery or open anything himself.';
    },
  });

  // M5.5 follow-up (live gap: the model REGENERATED an image the user already had because
  // it had no way back into the gallery): open any gallery image by its word-name.
  const openImage = tool({
    name: 'open_image',
    description:
      "Open one of the user's existing images from his gallery on his screen (the viewer/editor) and " +
      'make it the edit target. Use whenever he references an image he already has ("get the ember ' +
      'back up", "open the dragon one") — NEVER regenerate an image that already exists. Pass words ' +
      "from how he referred to it, or null for his most recent image. Image names are plain words — " +
      'say them naturally, without the .png.',
    parameters: z.object({
      name: z.string().nullable().describe("Words identifying the image ('green ember'), or null for the most recent"),
    }),
    execute: async ({ name }) => {
      const query = name?.trim() || null;
      const matches = findGalleryImages(query);
      if (matches.length === 0) {
        const recent = findGalleryImages(null, 5);
        return recent.length === 0
          ? 'The gallery is empty — nothing to open yet.'
          : `No image matches "${query}". Recent images: ${recent.join(', ')} — ask the user which he means.`;
      }
      const file = matches[0];
      if (query && matches.length > 1) {
        return `Several images match: ${matches.slice(0, 4).join(', ')}. Ask the user which one, then call open_image with its name.`;
      }
      if (!deps.openImage(file)) {
        return 'The shell is not connected right now, so nothing can be shown on screen.';
      }
      return `Opened ${file} on the user's screen — it's now the edit target. Refer to it by its name (without the .png).`;
    },
  });

  // M5.5: edits ride the shell viewer's armed context — the user highlights an area with
  // the brush and just SAYS the change; the strokes never pass through the voice model.
  const editImageTool = tool({
    name: 'edit_image',
    description:
      'Edit a previously generated image with a plain-language instruction. Use when the user asks to ' +
      'change, tweak, fix, or redo an image. Pass file null (the usual case): that targets the image ' +
      'he has open in the image panel — including any area he highlighted with the brush — or, if ' +
      'none is open, the most recently created image ("edit the image you just made"). Only pass a ' +
      'filename if the user explicitly named a different image. Returns immediately; the edit lands ' +
      "as a NEW version and you will be told when it's ready.",
    parameters: z.object({
      prompt: z.string().describe("The edit instruction, faithful to the user's words"),
      file: z
        .string()
        .nullable()
        .describe('null = the open image, else the latest created one (the usual case); a filename only if the user named one'),
    }),
    execute: async ({ prompt, file }) => {
      const ctx = deps.imageContext.get();
      const named = file?.trim() || null;
      // Resolution ladder (live gap 2026-07-16): named file → the viewer's open image →
      // the most recently created image (in-memory note, exact) → the newest gallery
      // file on DISK. The last rung is what survives daemon restarts — tsx-watch reloads
      // are constant in dev, and the in-memory note dying with them left "edit the pine
      // forest" refusing while the image sat right there in the gallery (live, 20:33).
      const target = named ?? ctx?.file ?? deps.imageContext.latest ?? findGalleryImages(null, 1)[0];
      if (!target) {
        return 'No image is open, none was named, and the gallery is empty — ask the user to describe the image he wants created.';
      }
      // The brush selection belongs to the viewer's OPEN image; a target resolved any
      // other way (named differently, or the latest-created fallback) must not inherit it.
      const strokes = target === ctx?.file ? ctx?.strokes : undefined;
      try {
        safeImageFile(target);
      } catch {
        return `"${target}" is not a valid image filename — check the gallery name and try again.`;
      }
      runImageEdit({ file: target, prompt, strokes, store, announce: deps.announce }).catch((err: unknown) => {
        store.addEvent(null, 'session.error', { message: `image edit announce: ${String(err)}` });
      });
      return `Edit started in the background${strokes && strokes.length > 0 ? ' on the highlighted area' : ''} — a working orb is on the user's screen and becomes the new version when it lands; you will be told when it does. If you already told him it's on the way, add at most ONE short sentence.`;
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

  // File presentation (2026-07-16): a coding session's deliverable is often a FILE (a
  // spec, a doc) — the user shouldn't have to dig through Finder to see it. The daemon reads
  // the file and pushes it to the shell, which shows a document card that opens in Gumbo's
  // own markdown renderer. Guards: absolute path only, secret paths refused, text only,
  // size-capped.
  const presentFileTool = tool({
    name: 'present_file',
    description:
      'Show the user a file on his screen — a document card appears in the corner and opens in a ' +
      'clean reader (markdown rendered nicely). Use whenever a task produced a file (a spec, ' +
      'plan, report, doc, or code) and the user should see it — offer it instead of telling him ' +
      'to go find the file himself. Pass the absolute path exactly as it appears in the task ' +
      'report or activity.',
    parameters: z.object({
      path: z.string().describe('Absolute path of the file to show'),
      title: z.string().nullable().describe('Short display title for the card; null → the filename'),
    }),
    execute: async ({ path, title }) => {
      const read = readForPresentation(path, title);
      if ('error' in read) return read.error;
      const shown = deps.presentFile(read);
      store.addEvent(null, 'file.presented', { path: read.path, shown });
      return shown
        ? 'It is on the user\'s screen now — the document card in the corner opens the full view (he can also prompt edits from there). Tell him it\'s up.'
        : 'No shell is connected, so nothing can be shown on screen — tell the user, and offer to read it aloud instead.';
    },
  });

  // Editable file viewer (2026-07-16): the user prompts a change to the document he has open
  // and the agent rewrites it in place (lightweight LLM round-trip, no coding session). The
  // filename never passes through the voice model — resolved from the viewer's file_context.
  const editFileTool = tool({
    name: 'edit_file',
    description:
      'Edit the document the user currently has open in the file viewer — apply a plain-language ' +
      'change (fix wording, correct a fact, add or remove a section, reformat). Use when he asks ' +
      'to change, fix, tweak, or rewrite the document he is looking at. Returns immediately; the ' +
      'updated version refreshes on screen. Only works on documents in his Gumbo workspace — for ' +
      'repo or code files use spawn_claude_session instead.',
    parameters: z.object({
      prompt: z.string().describe("The edit instruction, faithful to the user's words"),
    }),
    execute: async ({ prompt }) => {
      const open = deps.fileContext.get();
      if (!open) {
        return 'No document is open in the viewer — ask the user to open the document card first, then say the change.';
      }
      runFileEdit({ path: open, prompt, store, present: deps.presentFile, announce: deps.announce }).catch((err: unknown) => {
        store.addEvent(null, 'session.error', { message: `file edit announce: ${String(err)}` });
      });
      return "Editing the document in the background — tell the user it's on the way; the updated version will refresh on his screen. You'll be told when it lands.";
    },
  });

  // M8 watch-me teaching: the user demonstrates a task ONCE and the shell's tap records it
  // semantically. The description is the router (start/stop/cancel are voice phrases, not
  // separate tools — the registry stays lean, the M6 lesson).
  const teachProcedure = tool({
    name: 'teach_procedure',
    description:
      'Learn a Mac procedure by WATCHING the user demonstrate it himself. action "start" begins ' +
      'recording his clicks and typing as a named procedure — use when he says "watch me", "let me ' +
      'show you how", "I\'ll teach you"; needs a short name (infer one from what he says he\'s about ' +
      'to demonstrate, e.g. "file expense report"). While recording, everything he does on the Mac ' +
      'is the demonstration; passwords are never recorded. action "stop" ends and saves the ' +
      'recording — use when he says "done", "that\'s it", "stop watching". action "cancel" discards ' +
      'it ("never mind", "forget that"). Recording shows in the notch the whole time. action ' +
      '"save_last_run": when Gumbo itself just finished a multi-step computer task and the user says ' +
      '"save that as a procedure" / "remember how you did that" — distills that run instead of a ' +
      'demonstration (name: infer from his words or the task).',
    parameters: z.object({
      action: z.enum(['start', 'stop', 'cancel', 'save_last_run']),
      name: z
        .string()
        .nullable()
        .describe('Short procedure name — required for start, optional for save_last_run (defaults to the task title); null for stop/cancel'),
    }),
    execute: async ({ action, name }) => {
      try {
        if (action === 'start') {
          const trimmed = name?.trim();
          if (!trimmed) return 'A name is needed to start — ask the user what to call this procedure.';
          await manager.startTeaching(trimmed);
          return `Recording — watching the user demonstrate "${trimmed}". Tell him to go ahead and to say "done" when he's finished.`;
        }
        if (action === 'stop') {
          const done = await manager.stopTeaching();
          return `Recording finished — captured ${done.stepCount} step${done.stepCount === 1 ? '' : 's'} of "${done.name}"; now distilling it into a procedure (the result will be announced). Confirm briefly to the user.`;
        }
        if (action === 'save_last_run') {
          if (!deps.procedures) return 'Procedure saving is not wired up right now.';
          const last = store
            .listTasks(50)
            .find((t) => t.kind === 'computer' && t.status === 'done' && !t.title.startsWith('Teaching:'));
          if (!last) return 'No finished computer task to save — Gumbo has to complete one first.';
          const saved = await deps.procedures.saveFromTask(last.id, name?.trim() || last.title);
          return `Saved "${saved.name}" (version ${saved.version}, ${saved.stepCount} steps) as a reusable procedure.`;
        }
        return manager.cancelTeaching('cancelled by the user')
          ? 'Recording discarded — nothing was kept.'
          : 'No recording is active.';
      } catch (err) {
        return `Could not do that: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // M8 replay: a saved procedure runs deterministically (fast, near-zero model chatter),
  // falling back to the full computer-use loop only when the UI drifted. The description
  // routes between this and spawn_subagent: taught/saved tasks come HERE.
  const runProcedure = tool({
    name: 'run_procedure',
    description:
      'Run a SAVED procedure — something Gumbo learned by watching the user demonstrate it, or saved ' +
      'from a successful run. Use when he asks for a task he taught or saved ("file this month\'s ' +
      'expense report", "do the invoices thing like I showed you"). Pass his words as `procedure` — ' +
      'exact name or a description both match. If nothing matches, tell him what IS saved and offer a ' +
      'normal task (spawn_subagent) instead — never guess. Replay is fast and quiet, and still asks ' +
      'via the notch before anything risky (approvals never carry over from the demonstration).',
    parameters: z.object({
      procedure: z.string().describe("The procedure name or the user's description of it"),
      notes: z
        .string()
        .nullable()
        .describe('Run-specific details from the user (a month, a filename, an account) — applied to parameterized steps; null if none'),
    }),
    execute: async ({ procedure: query, notes }) => {
      try {
        const row = store.getProcedure(query.trim()) ?? store.searchProcedures(query, 1)[0];
        if (!row) {
          const saved = store.listProcedures(5).map((p) => `"${p.name}"`).join(', ');
          return `No saved procedure matches "${query}". ${saved ? `Saved procedures: ${saved}.` : 'Nothing has been saved yet.'} Offer to do it as a normal task instead (spawn_subagent) — don't guess.`;
        }
        const parsed = JSON.parse(row.body) as { goal?: string };
        const brief =
          `Replay of the saved procedure "${row.name}" (v${row.version}). Goal: ${parsed.goal ?? row.title}.` +
          (notes ? ` Run-specific notes from the user: ${notes}` : '');
        const task = manager.spawnSubagent(row.name, brief, 'mac', {
          procedure: JSON.parse(row.body),
          notes: notes ?? null,
        });
        return `Running the saved procedure "${row.name}" (internal task_id ${task.id} — never say it aloud). You will be told when it finishes.`;
      } catch (err) {
        return `Could not start that: ${err instanceof Error ? err.message : String(err)}`;
      }
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

  // Hot path, X-first: Grok's live X access, hard-capped at config.grok.quickLookupTimeoutMs,
  // no retries. Its description is the router between this and web_quick_lookup — X/real-time-
  // social lives here, general facts stay on Tavily. Don't cross the streams; the wording is
  // load-bearing (realtime/tools.test.ts asserts both are registered).
  const xLookupTool = tool({
    name: 'x_lookup',
    description:
      "Use for what's happening on X (Twitter) RIGHT NOW — a post from a specific account, real-time " +
      'social reaction, or a breaking announcement made ON X (e.g. "did the Claude Dev account post ' +
      'about the usage-limit reset?"). Powered by Grok\'s live X access, which the general web lookup ' +
      'lacks. For general facts, scores, prices, or "is X true today", use web_quick_lookup instead — ' +
      'not this. Returns a spoken-ready `answer` (read it aloud nearly verbatim) plus source URLs as ' +
      'metadata. If it returns lookup_failed, follow its instruction — never guess.',
    parameters: z.object({
      query: z.string().describe('What to check on X right now — a specific account, post, or breaking claim'),
    }),
    execute: async ({ query }) => xLookup(query),
  });

  return [
    spawnSubagent, spawnClaudeSession, sendToSession, undoSession, quickLookup, xLookupTool, macDo,
    teachProcedure, runProcedure,
    generateImage, editImageTool, openImage, setReminder, listReminders, cancelReminder,
    listTasks, getTaskStatus, cancelTask, readReport, saveNote, presentFileTool, editFileTool,
  ];
}
