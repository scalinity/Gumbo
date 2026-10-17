import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.ts';
import { recordUsage } from '../usage/recorder.ts';

export interface LiveEvent {
  type: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  client_event_id?: string;
  delegation?: { id: string; target: string };
  usage?: { seconds: number };
  session?: { id: string; model?: string };
  error?: { code?: string; client_event_id?: string };
}

export function pcmRms(frame: Buffer): number {
  const samples = frame.length >> 1;
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += frame.readInt16LE(i * 2) ** 2;
  return Math.sqrt(sum / samples);
}

/** A byte ceiling is deliberately conservative: context appends allow 500 tokens. */
export function liveContext(text: string): string {
  let result = '';
  for (const char of text.trim()) {
    if (Buffer.byteLength(result + char) > 480) break;
    result += char;
  }
  return result;
}

function spokenContext(text: string): string {
  if (Buffer.byteLength(text) <= 480) return text;
  const excerpt = liveContext(text).slice(0, 330);
  const end = Math.max(excerpt.lastIndexOf('. '), excerpt.lastIndexOf('! '), excerpt.lastIndexOf('? '));
  return `${end > 0 ? excerpt.slice(0, end + 1) : excerpt.slice(0, excerpt.lastIndexOf(' ')) + '…'} More detail is in the activity view.`;
}

/** Primary GPT-Live WebSocket. No Realtime commit/create events or synthetic turn-done.
 * Continuous 20 ms frames keep Live's clock moving while PTT is released. */
export class LiveSession extends EventEmitter {
  private socket: WebSocket | null = null;
  private started = false;
  private closing = false;
  private finalized = false;
  private startedAt = 0;
  private seconds = 0;
  private sequence = 0;
  private tick: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private mic = Buffer.alloc(0);
  private muted = true;
  private wantsMic = false;
  private releaseAt = 0;
  private controls = Promise.resolve();
  private commands = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private outputTailMs = 0;
  private suppressOutput = false;
  private suppressedAt = 0;
  private quietMs = 0;
  private quietTimer: NodeJS.Timeout | null = null;
  private preRoll: Buffer[] = [];
  private instructions: string;
  constructor(instructions: string) { super(); this.instructions = instructions; }

  async connect(): Promise<void> {
    const socket = new WebSocket('wss://api.openai.com/v1/live/sessions', {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, handshakeTimeout: 15_000,
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('GPT-Live startup timed out')); this.close(); }, 15_000);
      const fail = () => { clearTimeout(timeout); reject(new Error('GPT-Live connection failed')); };
      socket.once('open', () => this.send({ type: 'session.start', session: {
        model: config.models.live, instructions: this.instructions,
        audio: { format: { type: 'audio/pcm', rate: 24_000 }, output: { voice: config.voice } },
        delegation: { type: 'client' },
      } }));
      socket.on('message', data => {
        let event: LiveEvent;
        try { event = JSON.parse(data.toString()); } catch { this.emit('fault', new Error('Invalid GPT-Live event')); return; }
        if (event.type === 'session.started') {
          this.started = true; this.startedAt = Date.now();
          clearTimeout(timeout);
          // Input starts muted even if startup defaults change. Queue first words until
          // the matching unmute acknowledgment; input clock continues with silence.
          this.tick = setInterval(() => this.pump(), 20);
          this.command('session.input_audio.mute').then(resolve, reject);
        }
        this.receive(event);
      });
      socket.on('error', () => { fail(); this.emit('fault', new Error('GPT-Live network error')); });
      socket.on('close', () => {
        fail(); this.finish(false); this.emit('disconnected');
      });
    });
  }

  private send(event: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }

  private command(type: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.started || this.closing) return Promise.reject(new Error('GPT-Live is closed'));
    const id = `gumbo_${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.commands.delete(id); reject(new Error(`GPT-Live ${type} timed out`)); }, 5000);
      this.commands.set(id, { resolve, reject, timer });
      this.send({ type, event_id: id, ...extra });
    });
  }

  private receive(event: LiveEvent) {
    if (event.usage && Number.isFinite(event.usage.seconds)) this.seconds = Math.max(this.seconds, event.usage.seconds);
    const id = event.client_event_id ?? event.error?.client_event_id;
    const pending = id ? this.commands.get(id) : undefined;
    if (pending) {
      clearTimeout(pending.timer); this.commands.delete(id!);
      if (event.type === 'error') pending.reject(new Error(`GPT-Live command rejected (${event.error?.code ?? 'unknown'})`));
      else pending.resolve();
    }
    if (event.type === 'session.output_audio.delta' && event.delta && !this.closing) this.output(Buffer.from(event.delta, 'base64'));
    if (event.type === 'session.closed') { this.finish(true); this.socket?.close(); }
    if (event.type === 'error') this.emit('fault', new Error(`GPT-Live error (${event.error?.code ?? 'unknown'})`));
    this.emit('event', event);
  }

  /** Silence is not queued to the native speaker forever. Keep a small leading buffer
   * and a 240 ms tail so the gate preserves consonants and natural short pauses. */
  private output(frame: Buffer) {
    const ms = frame.length / 48;
    const voiced = pcmRms(frame) >= 70;
    if (this.suppressOutput) {
      this.waitForOutputGap();
      this.quietMs = voiced ? 0 : this.quietMs + ms;
      if (this.quietMs >= 240) { this.suppressOutput = false; this.preRoll = []; }
      else if (Date.now() - this.suppressedAt > 4000) this.emit('fault', new Error('GPT-Live did not settle after interruption'));
      return;
    }
    if (voiced) {
      for (const lead of this.preRoll) this.emit('audio', lead);
      this.preRoll = []; this.outputTailMs = 240;
      this.emit('audio', frame);
    } else if (this.outputTailMs > 0) {
      this.outputTailMs -= ms; this.emit('audio', frame);
    } else {
      this.preRoll.push(frame);
      while (this.preRoll.reduce((n, f) => n + f.length, 0) > 3840) this.preRoll.shift();
    }
  }

  setInput(active: boolean) {
    this.wantsMic = active;
    if (active) {
      this.releaseAt = 0;
      this.controls = this.controls.then(async () => {
        await this.command('session.input_audio.unmute'); this.muted = false;
      }).catch(error => this.emit('fault', error)).then(() => {});
    } else this.releaseAt = Date.now() + 300;
  }

  sendAudio(frame: Buffer) {
    if (this.closing || frame.length % 2) return;
    if (this.mic.length + frame.length > 480_000) { this.emit('fault', new Error('GPT-Live microphone queue overflow')); return; }
    this.mic = Buffer.concat([this.mic, frame]);
  }

  private pump() {
    if (this.closing) return;
    let frame = Buffer.alloc(960);
    if (!this.muted && this.mic.length) {
      const n = Math.min(frame.length, this.mic.length);
      this.mic.copy(frame, 0, 0, n); this.mic = this.mic.subarray(n);
      if (!this.wantsMic) this.releaseAt = Date.now() + 300;
    } else if (!this.wantsMic && this.releaseAt && Date.now() >= this.releaseAt) {
      this.releaseAt = 0;
      this.controls = this.controls.then(async () => {
        // A new press may have arrived while an earlier command was pending.
        if (!this.wantsMic) { await this.command('session.input_audio.mute'); this.muted = true; }
      }).catch(error => this.emit('fault', error)).then(() => {});
    }
    this.send({ type: 'session.input_audio.append', audio: frame.toString('base64') });
  }

  append(kind: 'commentary' | 'thinking' | 'instructions', text: string, delegationId: string | null = null) {
    return this.command(`session.${kind}.append`, { content: kind === 'commentary' ? spokenContext(text) : liveContext(text), delegation_id: delegationId });
  }

  private waitForOutputGap() {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    // Some transports omit silent output frames. A gap in received audio is also
    // acoustic silence; it is independent of instruction acknowledgment timing.
    this.quietTimer = setTimeout(() => { this.suppressOutput = false; this.preRoll = []; }, 350);
  }

  interrupt() {
    this.suppressOutput = true; this.suppressedAt = Date.now(); this.quietMs = 0; this.preRoll = [];
    this.waitForOutputGap();
    void this.append('instructions', 'Stop speaking immediately and listen to the user. Wait for the backend before answering a request that needs tools.').catch(error => this.emit('fault', error));
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    if (this.tick) clearInterval(this.tick);
    if (this.started && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: 'session.close' });
      this.closeTimer = setTimeout(() => { this.finish(false); this.socket?.terminate(); }, 15_000);
    } else { this.finish(false); this.socket?.terminate(); }
  }

  private finish(confirmed: boolean) {
    if (this.finalized) return;
    this.finalized = true; this.closing = true;
    if (this.tick) clearInterval(this.tick);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.quietTimer) clearTimeout(this.quietTimer);
    for (const pending of this.commands.values()) { clearTimeout(pending.timer); pending.reject(new Error('GPT-Live closed')); }
    this.commands.clear(); this.mic = Buffer.alloc(0);
    if (this.started) {
      const seconds = confirmed ? this.seconds : Math.max(this.seconds, (Date.now() - this.startedAt) / 1000);
      recordUsage({ provider: 'openai', model: config.models.live, kind: 'live_session', units: seconds,
        costUsd: seconds * 0.05 / 60, billed: true, estimated: !confirmed, detail: { finalization: confirmed ? 'confirmed' : 'unconfirmed' } });
    }
  }
}
