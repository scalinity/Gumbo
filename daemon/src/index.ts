import { mkdirSync } from 'node:fs';
import { config } from './config.ts';
import { echoForInstructions } from './audio/announce.ts';
import { Store } from './events/store.ts';
import { createHttpServer } from './http.ts';
import { Hub } from './ws/hub.ts';
import { ConfirmBridge } from './ws/confirm.ts';
import { MacBridge } from './ws/mac.ts';
import { TaskManager } from './tasks/manager.ts';
import { Scheduler } from './schedule/scheduler.ts';
import { applyImageContext, ImageEditContext } from './images/context.ts';
import { acceptImageEditRequest } from './images/edit.ts';
import { Orchestrator } from './realtime/session.ts';

const missing = ['OPENAI_API_KEY', 'EXA_API_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing ${missing.join(', ')} — put them in the repo .env`);
  process.exit(1);
}

// Organized agent home: one directory per concern, never a flat dump.
for (const dir of [config.home.tasks, config.home.images, config.home.notes, config.home.db, config.home.logs]) {
  mkdirSync(dir, { recursive: true });
}

const store = new Store(config.dbPath);
const reaped = store.reapInterruptedTasks();
if (reaped.length) console.log(`reaped ${reaped.length} task(s) left running by a previous run`);

const server = createHttpServer(store);
const hub = new Hub(server);
// M4: supervisor escalations resolve through the notch (deny on timeout / no shell).
const confirms = new ConfirmBridge(hub);
// M6: computer-use actions execute in the shell (it owns the TCC grants); this bridge
// is the daemon's hands. Fails safe to typed errors — never hangs a waiting loop.
const macBridge = new MacBridge(hub);
const manager = new TaskManager(
  store,
  (taskId, taskTitle, req, signal) => confirms.request(taskId, taskTitle, req.title, req.detail, signal),
  // Plan approval: a longer notch window (the user reads the full plan in the dashboard/bubble;
  // the confirm shows a one-line summary). Deny/timeout parks the task — nothing is lost.
  (taskId, taskTitle, plan, signal) =>
    confirms.request(taskId, taskTitle, 'Approve Claude’s plan?', plan.replace(/\s+/g, ' ').slice(0, 140), signal, config.claude.planConfirmTimeoutMs),
  undefined, // default ClaudeRunner factory
  macBridge, // M6: computer-use tasks execute through the shell
);
// M5: the Gumbo-owned scheduler. Its fire loop delivers through the M3 announce path —
// live session injection when one is open, cold one-shot TTS otherwise (never opens a
// session just to remind). Reminder text is the user's own words from his own request.
const scheduler = new Scheduler(store, hub);
// M5.5: the shell image viewer's live state (open image + brush selection) — what voice
// edits resolve "this image" and "the highlighted area" against.
const imageContext = new ImageEditContext();
const orchestrator = new Orchestrator(store, hub, manager, scheduler, imageContext, macBridge, confirms);
scheduler.onFire = (row) =>
  orchestrator.speakProactively(
    // Cold TTS speaks the raw text verbatim; the LIVE instruction echo is defanged
    // (review 🔵 — the M3 neutralization precedent applied to short echoes).
    `the user, reminder: ${row.text}.`,
    `A reminder the user set has just come due: "${echoForInstructions(row.text, 200)}". Deliver it to him now — brief and direct, one sentence. Do not mention ids or the scheduler.`,
  );
manager.onFinished = (task) => {
  // Floating promise: an unexpected sync throw (dead transport, store failure) would
  // otherwise become an unhandled rejection and take the whole daemon down.
  orchestrator.announceTaskFinished(task).catch((err: unknown) => {
    store.addEvent(task.id, 'session.error', { message: `announce: ${String(err)}` });
  });
};

// Events go to dashboards AND the shell (M3.1): the bubble mini-panel live-tails its
// task's activity. The shell ignores types it doesn't render.
store.onEvent((event) => hub.broadcast({ type: 'event', event }));

// M5: a fired reminder pulses the notch — the visual cue beside the spoken delivery.
// The shell's pulse already defers to a live session display, so always sending is safe.
store.onEvent((event) => {
  if (event.type === 'reminder.fired') hub.broadcast({ type: 'notch_pulse', status: 'reminder' }, 'shell');
});

// M3 completion presence: mirror the task lifecycle to the shell as bubbles, pulse the
// notch on completion, and remove finished bubbles after a linger (registered after the
// restart reaper ran, so reaped tasks from a previous run don't pulse on boot).
const bubbleRemoveTimers = new Map<string, NodeJS.Timeout>();
store.onEvent((event) => {
  if (!event.task_id) return;
  if (event.type === 'task.created') {
    const payload = event.payload as { title?: string };
    hub.broadcast({ type: 'bubble_upsert', task_id: event.task_id, title: payload?.title ?? event.task_id, status: 'running' }, 'shell');
  } else if (event.type === 'task.status') {
    // M4: needs_input ⇄ running flips mid-run (notch confirm pending, cap hit, resume).
    const task = store.getTask(event.task_id);
    const status = (event.payload as { status?: string })?.status;
    if (!task || (status !== 'running' && status !== 'needs_input')) return;
    hub.broadcast({ type: 'bubble_upsert', task_id: task.id, title: task.title, status }, 'shell');
  } else if (event.type === 'task.finished') {
    const task = store.getTask(event.task_id);
    if (!task || task.status === 'running' || task.status === 'needs_input') return;
    hub.broadcast({ type: 'bubble_upsert', task_id: task.id, title: task.title, status: task.status }, 'shell');
    hub.broadcast({ type: 'notch_pulse', status: task.status }, 'shell');
    const previous = bubbleRemoveTimers.get(task.id);
    if (previous) clearTimeout(previous);
    bubbleRemoveTimers.set(task.id, setTimeout(() => {
      bubbleRemoveTimers.delete(task.id);
      hub.broadcast({ type: 'bubble_remove', task_id: task.id }, 'shell');
    }, config.bubbleLingerMs));
  }
});

// A shell that (re)connects mid-run must not miss its bubbles — shell relaunches and
// tsx-watch daemon restarts are routine.
hub.onHello((role) => {
  if (role !== 'shell') return;
  // Bubbles for tasks the boot reaper flipped to 'failed' died with the old daemon —
  // no listener existed when those task.finished events fired, the running-only
  // re-sync below skips them, and the shell's failsafe is cancelled while a bubble
  // shows 'running'. Without this, a routine tsx-watch restart leaves a stale ember
  // orb claiming a dead task is running forever.
  for (const id of reaped) {
    hub.broadcast({ type: 'bubble_remove', task_id: id }, 'shell');
  }
  for (const task of store.listTasks()) {
    if (task.status !== 'running' && task.status !== 'needs_input') continue;
    hub.broadcast({ type: 'bubble_upsert', task_id: task.id, title: task.title, status: task.status }, 'shell');
  }
  // M5: repair the EventKit mirror — create/remove broadcasts dropped while no shell
  // was connected get re-sent now (pending w/o twin, cancelled w/ surviving twin).
  scheduler.resyncEventKit();
  // M6: a shell that (re)connects while a computer-use task runs must arm its kill
  // switch + ghost cursor immediately.
  macBridge.resync();
});

hub.onMessage((msg, role) => {
  if (msg.type === 'debug_text' && typeof msg.text === 'string' && msg.text.trim()) {
    orchestrator.handleDebugText(msg.text).catch((err: unknown) => {
      store.addEvent(null, 'session.error', { message: String(err) });
    });
  } else if (msg.type === 'task_action' && msg.action === 'cancel' && typeof msg.task_id === 'string') {
    manager.cancel(msg.task_id);
  } else if (msg.type === 'ptt_press' && role === 'shell') {
    orchestrator.handlePttPress();
  } else if (msg.type === 'ptt_release' && role === 'shell') {
    orchestrator.handlePttRelease();
  } else if (msg.type === 'playback_state' && role === 'shell') {
    orchestrator.handlePlaybackState(msg.draining === true);
  } else if (msg.type === 'confirm_response' && role === 'shell' && typeof msg.id === 'string') {
    // Role is self-asserted at hello, so this inherits the existing loopback trust model
    // (any local client can claim 'shell') rather than widening it — track for M4.1 auth.
    confirms.handleResponse(msg.id, msg.approved === true);
  } else if (msg.type === 'reminder_created' && role === 'shell' && typeof msg.id === 'string') {
    // M5: EventKit's answer to create_reminder — store the Reminders.app id on the row.
    scheduler.handleReminderCreated(msg.id, typeof msg.eventkit_id === 'string' ? msg.eventkit_id : null);
  } else if (msg.type === 'image_context' && role === 'shell') {
    // M5.5: viewer state — a bad payload clears the context (fail toward "no target").
    applyImageContext(imageContext, msg, (detail) => {
      store.addEvent(null, 'session.error', { message: `image_context: ${detail}` });
    });
  } else if (msg.type === 'mac_action_result' && role === 'shell' && typeof msg.id === 'string') {
    // M6: the executor's answer to a mac_action — payload is sanitized inside the bridge.
    macBridge.handleResult(msg.id, msg.result);
  } else if (msg.type === 'mac_abort' && role === 'shell') {
    // M6 kill switch: the user touched the machine (or hit the hotkey) while a computer-use
    // task was driving it — cancel every running computer task, instantly and audibly.
    manager.cancelComputerTasks(String(msg.reason ?? 'human_input'));
  } else if (msg.type === 'image_edit_request' && role === 'shell') {
    // M5.5: typed edit from the viewer panel — no realtime session involved; the
    // completion (or failure) is spoken through the same proactive announce path, and
    // acceptImageEditRequest guarantees the viewer's busy state always gets an exit event.
    acceptImageEditRequest(msg, store, (cold, live) => orchestrator.speakProactively(cold, live));
  }
});

// A shell that dies mid-drain must not leave 'speaking' (and the idle-close guard) stuck —
// nor a stale image armed for voice edits (M5.5: the viewer died with the shell).
hub.onClose((role) => {
  if (role === 'shell' && !hub.hasRole('shell')) {
    orchestrator.handlePlaybackState(false);
    imageContext.set(null);
  }
});

// Binary frames from the shell are raw mic pcm16 (streamed only while ⌃⌥ is armed).
hub.onBinary((frame, role) => {
  if (role === 'shell') orchestrator.handleMicFrame(frame);
});

// Pending schedule rows persisted by a previous run resume here — the first sweep is one
// poll interval in (grace for the shell to reconnect before an overdue reminder speaks).
scheduler.start();

server.listen(config.port, config.host, () => {
  console.log(`gumbo daemon listening on http://${config.host}:${config.port} (ws: /ws)`);
});
