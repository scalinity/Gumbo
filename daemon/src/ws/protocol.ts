// Wire protocol between daemon ⇄ shell and daemon ⇄ dashboard.
// Text frames are JSON envelopes. Binary frames carry audio:
//   shell → daemon: raw mic pcm16 (24 kHz mono), streamed only while ⌃⌥ is armed
//   daemon → shell: speaker pcm16 with a 1-byte header — 0x01 realtime voice,
//                   0x02 one-shot TTS (reserved for M3 announcements)
import type { EventRow } from '../events/store.ts';

export type ClientRole = 'shell' | 'dashboard';

export const AUDIO_REALTIME = 0x01;
export const AUDIO_TTS = 0x02;

// client → daemon
export type InboundMessage =
  | { type: 'hello'; role: ClientRole }
  | { type: 'debug_text'; text: string }
  | { type: 'task_action'; task_id: string; action: 'cancel' }
  | { type: 'ptt_press' } // shell: ⌃⌥ went down — mic frames follow
  | { type: 'ptt_release' }; // shell: ⌃⌥ lifted — commit the turn

// Terminal statuses a bubble can show; 'running' is the only live one until M4.
export type BubbleStatus = 'running' | 'done' | 'failed' | 'cancelled';

// daemon → client
export type OutboundMessage =
  | { type: 'event'; event: EventRow }
  | { type: 'session_state'; state: 'idle' | 'listening' | 'thinking' | 'speaking' }
  | { type: 'assistant_delta'; item_id: string; delta: string }
  | { type: 'playback_flush' } // barge-in: drop queued speaker audio immediately
  | { type: 'bubble_upsert'; task_id: string; title: string; status: BubbleStatus } // shell: one panel per task
  | { type: 'bubble_remove'; task_id: string } // shell: fade the panel out (sent after the done-linger)
  | { type: 'notch_pulse'; status: Exclude<BubbleStatus, 'running'> }; // shell: brief completion pulse
