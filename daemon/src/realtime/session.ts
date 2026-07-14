import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { config } from '../config.ts';
import type { Store, TaskRow } from '../events/store.ts';
import type { Hub } from '../ws/hub.ts';
import type { TaskManager } from '../tasks/manager.ts';
import { createOrchestratorTools } from './tools.ts';

const INSTRUCTIONS = `You are Gumbo, the user's personal agent. You speak in short, natural, conversational
replies — you are a voice assistant even when the channel is text. Address the user as the user.
Your superpower is delegation: for anything that takes real work (research, analysis, writing,
comparisons), call spawn_subagent with a short title and a detailed self-contained brief, tell the user
it's running, and move on — never make the user wait while work happens.
When asked about progress, use list_tasks / get_task_status / read_report and answer from what they
return; never guess or fabricate task states. When a task-finished notice arrives, relay it briefly.
You keep an organized home directory (tasks, images, notes). Use save_note to retain durable
knowledge — facts about the user, decisions, standing context — one topic per note, so it survives
across sessions; keep it tidy rather than dumping everything into one note.
Only answer directly yourself when it's quicker than delegating (chat, quick facts, opinions).`;

type SessionState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface HistoryItemLike {
  itemId: string;
  type: string;
  role?: string;
  status?: string;
  content?: Array<{ text?: string; transcript?: string }>;
}

function itemText(item: HistoryItemLike): string {
  return (item.content ?? []).map((p) => p.text ?? p.transcript ?? '').join('');
}

export class Orchestrator {
  private session: RealtimeSession | null = null;
  private connecting: Promise<RealtimeSession> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private persisted = new Set<string>();

  constructor(
    private store: Store,
    private hub: Hub,
    private manager: TaskManager,
  ) {}

  private setState(state: SessionState) {
    this.hub.broadcast({ type: 'session_state', state });
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.closeSession(), config.sessionIdleMs);
  }

  private closeSession() {
    if (!this.session) return;
    this.session.close();
    this.session = null;
    this.persisted.clear();
    this.store.addEvent(null, 'session.closed', {});
    this.setState('idle');
  }

  private async ensureSession(): Promise<RealtimeSession> {
    if (this.session) return this.session;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        const agent = new RealtimeAgent({
          name: 'Gumbo',
          instructions: INSTRUCTIONS,
          tools: createOrchestratorTools(this.manager, this.store),
        });
        const session = new RealtimeSession(agent, {
          transport: 'websocket',
          model: config.models.realtime,
          config: { outputModalities: config.outputModalities },
        });

        session.on('history_updated', (history) => {
          for (const item of history as unknown as HistoryItemLike[]) {
            if (item.type !== 'message' || item.status !== 'completed') continue;
            if (this.persisted.has(item.itemId)) continue;
            const text = itemText(item);
            if (!text) continue;
            this.persisted.add(item.itemId);
            this.store.addEvent(null, `transcript.${item.role}`, { text });
          }
        });
        session.transport.on('*', (event: { type: string; delta?: string; item_id?: string }) => {
          if (event.type === 'response.output_text.delta' || event.type === 'response.output_audio_transcript.delta') {
            this.hub.broadcast({ type: 'assistant_delta', item_id: event.item_id ?? '', delta: event.delta ?? '' }, 'dashboard');
          }
        });
        session.transport.on('function_call', (call: { name?: string; arguments?: string }) => {
          this.store.addEvent(null, 'tool.call', { name: call.name, args: call.arguments?.slice(0, 500) });
        });
        session.on('agent_start', () => {
          this.setState('thinking');
          this.resetIdleTimer(); // keep a long, legitimate turn from being torn down mid-response
        });
        session.transport.on('turn_done', () => {
          this.setState('idle');
          this.resetIdleTimer();
        });
        session.on('error', (err) => {
          this.store.addEvent(null, 'session.error', { message: String((err as { error?: unknown }).error ?? err) });
        });

        await session.connect({ apiKey: process.env.OPENAI_API_KEY! });
        this.store.addEvent(null, 'session.opened', { model: config.models.realtime });
        this.session = session;
        this.resetIdleTimer();
        return session;
      } finally {
        // Clear on BOTH success and failure, so a transient connect error doesn't
        // wedge every future message on a permanently-rejected promise.
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  async handleDebugText(text: string) {
    const session = await this.ensureSession();
    this.resetIdleTimer();
    this.setState('thinking');
    session.sendMessage(text);
  }

  async announceTaskFinished(task: TaskRow) {
    if (!this.session) {
      // No live session: queued for the M3 one-shot TTS path; dashboard still shows task.finished.
      this.store.addEvent(task.id, 'announce.pending', { title: task.title, status: task.status });
      return;
    }
    this.resetIdleTimer();
    const instructions = `Briefly tell the user that the background task "${task.title}" (id ${task.id}) just finished with status "${task.status}". One or two sentences; offer to share details.`;
    const transport = this.session.transport as {
      requestResponse?: (response: { instructions: string }) => void;
      sendEvent: (event: unknown) => void;
    };
    // requestResponse defers until any in-flight response completes (only one active
    // response is allowed); fall back to a raw event if the SDK build lacks it.
    if (typeof transport.requestResponse === 'function') {
      transport.requestResponse({ instructions });
    } else {
      transport.sendEvent({ type: 'response.create', response: { instructions } });
    }
  }
}
