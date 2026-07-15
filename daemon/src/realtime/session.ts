import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { config } from '../config.ts';
import type { Store, TaskRow } from '../events/store.ts';
import type { Hub } from '../ws/hub.ts';
import type { TaskManager } from '../tasks/manager.ts';
import { AUDIO_REALTIME } from '../ws/protocol.ts';
import { announcementText, speakAnnouncement } from '../audio/announce.ts';
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

interface TransportLike {
  requestResponse?: (response?: { instructions?: string }) => void;
  // On OpenAIRealtimeBase, so present for every OpenAI transport (we use 'websocket').
  updateSessionConfig: (config: unknown) => void;
  sendEvent: (event: unknown) => void;
}

function itemText(item: HistoryItemLike): string {
  return (item.content ?? []).map((p) => p.text ?? p.transcript ?? '').join('');
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  // ws buffers share pooled memory, so slicing out an exact copy is required anyway.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data as ArrayBuffer);
}

const REALTIME_HEADER = Buffer.from([AUDIO_REALTIME]);
// Mic audio buffered while the session is still connecting (so the first words of the
// first turn aren't clipped). 20 ms frames → 500 ≈ 10 s, far beyond any connect time.
const MAX_PENDING_MIC_FRAMES = 500;

export class Orchestrator {
  private session: RealtimeSession | null = null;
  private connecting: Promise<RealtimeSession> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private persisted = new Set<string>();
  private state: SessionState = 'idle';

  // PTT turn state — the shell owns the ⌃⌥ chord; this mirrors it per armed window.
  private armed = false;
  private armedBytes = 0; // mic bytes received since press (commit decision while connecting)
  private pendingMic: Buffer[] = []; // frames that arrived before connect resolved
  private pendingRelease: number | null = null; // armedBytes at a release that beat the connect
  private speechActive = false; // between VAD speech_started and speech_stopped
  private hadSpeech = false; // any VAD speech this armed window → worth responding to
  private sawCommit = false; // VAD auto-committed this window → don't double-commit
  private responding = false; // a response is in flight (thinking or speaking)

  constructor(
    private store: Store,
    private hub: Hub,
    private manager: TaskManager,
  ) {}

  private setState(state: SessionState) {
    if (state === this.state) return;
    this.state = state;
    this.hub.broadcast({ type: 'session_state', state });
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.closeSession(), config.sessionIdleMs);
  }

  private resetPtt() {
    this.armed = false;
    this.armedBytes = 0;
    this.pendingMic = [];
    this.pendingRelease = null;
    this.speechActive = false;
    this.hadSpeech = false;
    this.sawCommit = false;
  }

  private closeSession() {
    if (!this.session) return;
    const session = this.session;
    this.session = null; // null first so connection_change sees an intentional close
    session.close();
    this.resetPtt();
    this.responding = false;
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
          config: {
            outputModalities: config.outputModalities,
            audio: {
              input: config.realtimeAudio.input,
              output: { ...config.realtimeAudio.output, voice: config.voice },
            },
          },
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
          switch (event.type) {
            case 'response.output_text.delta':
            case 'response.output_audio_transcript.delta':
              // Dashboard streaming line + the shell's notch transcript line.
              this.hub.broadcast({ type: 'assistant_delta', item_id: event.item_id ?? '', delta: event.delta ?? '' });
              break;
            case 'input_audio_buffer.speech_started':
              this.speechActive = true;
              this.hadSpeech = true;
              break;
            case 'input_audio_buffer.speech_stopped':
              this.speechActive = false;
              break;
            case 'input_audio_buffer.committed':
              this.sawCommit = true;
              break;
          }
        });
        session.transport.on('function_call', (call: { name?: string; arguments?: string }) => {
          this.store.addEvent(null, 'tool.call', { name: call.name, args: call.arguments?.slice(0, 500) });
        });
        session.on('audio', (event) => {
          this.hub.sendBinary(Buffer.concat([REALTIME_HEADER, toBuffer(event.data)]), 'shell');
          // While armed, 'listening' wins the display — the user's intent is to talk.
          if (!this.armed) this.setState('speaking');
          this.resetIdleTimer(); // a long spoken reply must not be torn down mid-sentence
        });
        session.on('audio_interrupted', () => {
          // Barge-in: the server truncated the response; the shell must drop queued audio NOW.
          this.hub.broadcast({ type: 'playback_flush' }, 'shell');
          if (this.armed) this.setState('listening');
        });
        session.on('agent_start', () => {
          this.responding = true;
          if (!this.armed) this.setState('thinking');
          this.resetIdleTimer(); // keep a long, legitimate turn from being torn down mid-response
        });
        session.transport.on('turn_done', () => {
          this.responding = false;
          this.setState(this.armed ? 'listening' : 'idle');
          this.resetIdleTimer();
        });
        session.transport.on('connection_change', (status) => {
          if (status === 'disconnected' && this.session === session) {
            // Unexpected drop (network/server) — clean up so the next press or message
            // opens a fresh session instead of throwing on a dead transport.
            this.session = null;
            this.resetPtt();
            this.responding = false;
            this.persisted.clear();
            if (this.idleTimer) clearTimeout(this.idleTimer);
            this.store.addEvent(null, 'session.closed', { reason: 'transport_disconnected' });
            this.setState('idle');
          }
        });
        session.on('error', (err) => {
          this.store.addEvent(null, 'session.error', { message: String((err as { error?: unknown }).error ?? err) });
        });

        await session.connect({ apiKey: process.env.OPENAI_API_KEY! });
        this.store.addEvent(null, 'session.opened', { model: config.models.realtime });
        this.session = session;
        // Flush mic audio that arrived while connecting, in order, before anything else
        // touches the input buffer. Same synchronous block as the assignment above, so no
        // live frame can interleave.
        for (const frame of this.pendingMic) session.sendAudio(toArrayBuffer(frame));
        this.pendingMic = [];
        if (this.pendingRelease !== null) {
          // ⌃⌥ was released before the session finished connecting. The VAD hasn't seen
          // this audio yet, so commit manually — unless it was a sub-100 ms tap.
          const bytes = this.pendingRelease;
          this.pendingRelease = null;
          const transport = session.transport as TransportLike;
          if (bytes >= config.minPttAudioBytes) {
            transport.sendEvent({ type: 'input_audio_buffer.commit' });
            this.requestTurnResponse(session);
            this.setState('thinking');
          } else {
            transport.sendEvent({ type: 'input_audio_buffer.clear' });
            this.setState('idle');
          }
          this.resetVadState(transport);
        }
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

  private requestTurnResponse(session: RealtimeSession) {
    const transport = session.transport as TransportLike;
    // requestResponse defers until any in-flight response completes (only one active
    // response is allowed); fall back to a raw event if the SDK build lacks it.
    if (typeof transport.requestResponse === 'function') {
      transport.requestResponse();
    } else {
      transport.sendEvent({ type: 'response.create' });
    }
  }

  handlePttPress() {
    this.armed = true;
    this.armedBytes = 0;
    this.pendingRelease = null;
    this.speechActive = false;
    this.hadSpeech = false;
    this.sawCommit = false;
    this.resetIdleTimer();
    // Pressing while Gumbo is speaking only ARMS the mic — playback (and the display)
    // changes when the server actually hears speech (audio_interrupted).
    if (this.state !== 'speaking') this.setState('listening');
    this.ensureSession().catch((err: unknown) => {
      this.resetPtt();
      this.setState('idle');
      this.store.addEvent(null, 'session.error', { message: String(err) });
    });
  }

  handlePttRelease() {
    if (!this.armed) return; // stray release (shell restart, duplicate events)
    this.armed = false;
    this.resetIdleTimer();
    if (this.session) {
      this.finishTurn(this.session);
    } else if (this.connecting) {
      this.pendingRelease = this.armedBytes;
    }
    this.armedBytes = 0;
  }

  handleMicFrame(frame: Buffer) {
    if (!this.armed) return; // stale frames after release — the shell gates, this is defense
    this.armedBytes += frame.byteLength;
    this.resetIdleTimer();
    if (this.session) {
      this.session.sendAudio(toArrayBuffer(frame));
    } else if (this.connecting && this.pendingMic.length < MAX_PENDING_MIC_FRAMES) {
      this.pendingMic.push(frame);
    }
  }

  private finishTurn(session: RealtimeSession) {
    const transport = session.transport as TransportLike;
    // The server VAD auto-commits at speech pauses; a manual commit is only needed for an
    // uncommitted tail — released mid-speech, faster than the VAD silence window (the common
    // PTT case) — or when no auto-commit happened at all. Committing an empty buffer errors,
    // so be exact rather than always committing.
    const needCommit = this.speechActive || (this.hadSpeech && !this.sawCommit);
    if (needCommit) transport.sendEvent({ type: 'input_audio_buffer.commit' });
    if (this.hadSpeech) {
      this.requestTurnResponse(session);
      this.setState('thinking');
    } else {
      // Armed but never spoke: a stray tap, or arming during Gumbo's reply without barging in.
      this.setState(this.responding ? 'speaking' : 'idle');
    }
    // Drop any uncommitted remainder (trailing silence) so it can't bleed into the next turn.
    transport.sendEvent({ type: 'input_audio_buffer.clear' });
    this.resetVadState(transport);
    this.speechActive = false;
    this.hadSpeech = false;
    this.sawCommit = false;
  }

  private resetVadState(transport: TransportLike) {
    // The server VAD's speech/silence state rides the audio timeline, and PTT mic-gating
    // means a mid-speech ⌃⌥ release (the normal gesture) leaves it stuck in "speech" — the
    // next armed window then never gets speech_started (a deaf turn) and loses VAD barge-in.
    // input_audio_buffer.clear does NOT reset it (verified); toggling turn detection does.
    transport.updateSessionConfig({ audio: { input: { turnDetection: null } } });
    transport.updateSessionConfig({ audio: { input: { turnDetection: config.realtimeAudio.input.turnDetection } } });
  }

  async handleDebugText(text: string) {
    const session = await this.ensureSession();
    this.resetIdleTimer();
    this.setState('thinking');
    session.sendMessage(text);
  }

  async announceTaskFinished(task: TaskRow) {
    if (!this.session) {
      // No live session — never open one just to announce (locked decision). Persist the
      // pending marker for the dashboard, then speak it cold via one-shot TTS. Skipped
      // when no shell is connected: nobody would hear it, so don't spend on synthesis.
      this.store.addEvent(task.id, 'announce.pending', { title: task.title, status: task.status });
      if (this.hub.hasRole('shell')) {
        try {
          await speakAnnouncement(this.hub, announcementText(task));
        } catch (err) {
          this.store.addEvent(task.id, 'session.error', { message: `announce tts: ${String(err)}` });
        }
      }
      return;
    }
    this.resetIdleTimer();
    const instructions = `Briefly tell the user that the background task "${task.title}" (id ${task.id}) just finished with status "${task.status}". One or two sentences; offer to share details.`;
    const transport = this.session.transport as TransportLike;
    if (typeof transport.requestResponse === 'function') {
      transport.requestResponse({ instructions });
    } else {
      transport.sendEvent({ type: 'response.create', response: { instructions } });
    }
  }
}
