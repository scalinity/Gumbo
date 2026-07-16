import { mkdirSync } from 'node:fs';
import { config } from './config.ts';
import { Store } from './events/store.ts';
import { createHttpServer } from './http.ts';
import { Hub } from './ws/hub.ts';
import { TaskManager } from './tasks/manager.ts';
import { Orchestrator } from './realtime/session.ts';

const missing = ['OPENAI_API_KEY', 'EXA_API_KEY'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing ${missing.join(', ')} — put them in the repo .env`);
  process.exit(1);
}

// Organized agent home: one directory per concern, never a flat dump.
for (const dir of [config.home.tasks, config.home.images, config.home.notes, config.home.db]) {
  mkdirSync(dir, { recursive: true });
}

const store = new Store(config.dbPath);
const reaped = store.reapInterruptedTasks();
if (reaped.length) console.log(`reaped ${reaped.length} task(s) left running by a previous run`);

const server = createHttpServer(store);
const hub = new Hub(server);
const manager = new TaskManager(store);
const orchestrator = new Orchestrator(store, hub, manager);
manager.onFinished = (task) => orchestrator.announceTaskFinished(task);

// Events go to dashboards AND the shell (M3.1): the bubble mini-panel live-tails its
// task's activity. The shell ignores types it doesn't render.
store.onEvent((event) => hub.broadcast({ type: 'event', event }));

// M3 completion presence: mirror the task lifecycle to the shell as bubbles, pulse the
// notch on completion, and remove finished bubbles after a linger (registered after the
// restart reaper ran, so reaped tasks from a previous run don't pulse on boot).
const bubbleRemoveTimers = new Map<string, NodeJS.Timeout>();
store.onEvent((event) => {
  if (!event.task_id) return;
  if (event.type === 'task.created') {
    const payload = event.payload as { title?: string };
    hub.broadcast({ type: 'bubble_upsert', task_id: event.task_id, title: payload?.title ?? event.task_id, status: 'running' }, 'shell');
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
    if (task.status !== 'running') continue;
    hub.broadcast({ type: 'bubble_upsert', task_id: task.id, title: task.title, status: 'running' }, 'shell');
  }
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
  }
});

// A shell that dies mid-drain must not leave 'speaking' (and the idle-close guard) stuck.
hub.onClose((role) => {
  if (role === 'shell' && !hub.hasRole('shell')) orchestrator.handlePlaybackState(false);
});

// Binary frames from the shell are raw mic pcm16 (streamed only while ⌃⌥ is armed).
hub.onBinary((frame, role) => {
  if (role === 'shell') orchestrator.handleMicFrame(frame);
});

server.listen(config.port, config.host, () => {
  console.log(`gumbo daemon listening on http://${config.host}:${config.port} (ws: /ws)`);
});
