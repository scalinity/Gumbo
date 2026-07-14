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

store.onEvent((event) => hub.broadcast({ type: 'event', event }, 'dashboard'));

hub.onMessage((msg) => {
  if (msg.type === 'debug_text' && typeof msg.text === 'string' && msg.text.trim()) {
    orchestrator.handleDebugText(msg.text).catch((err: unknown) => {
      store.addEvent(null, 'session.error', { message: String(err) });
    });
  } else if (msg.type === 'task_action' && msg.action === 'cancel' && typeof msg.task_id === 'string') {
    manager.cancel(msg.task_id);
  }
});

server.listen(config.port, config.host, () => {
  console.log(`gumbo daemon listening on http://${config.host}:${config.port} (ws: /ws)`);
});
