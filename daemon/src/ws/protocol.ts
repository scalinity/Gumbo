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
  | { type: 'ptt_release' } // shell: ⌃⌥ lifted — commit the turn
  // shell: speaker queue state. Generation finishes long before audible playback, so the
  // daemon needs this to keep session_state 'speaking' (and the session alive) until
  // the user actually stops hearing Gumbo.
  | { type: 'playback_state'; draining: boolean }
  // shell: the user answered a notch confirm (M4 supervisor escalation).
  | { type: 'confirm_response'; id: string; approved: boolean }
  // shell: EventKit accepted (or failed) a create_reminder — eventkit_id is null on failure.
  // The daemon stores it on the schedule row so cancel can remove the Reminders.app entry.
  | { type: 'reminder_created'; id: string; eventkit_id: string | null }
  // shell (M5.5): the image viewer's live state — which image is open and the current
  // brush selection (normalized round-capped strokes; the daemon rasterizes the mask).
  // file null = viewer closed. This is what voice edits resolve "this image" against.
  | { type: 'image_context'; file: string | null; strokes?: Array<{ points: Array<[number, number]>; radius: number }> }
  // shell (M5.5): a typed edit request from the viewer panel (voice edits ride the
  // realtime session + edit_image tool instead).
  | { type: 'image_edit_request'; file: string; prompt: string; strokes?: Array<{ points: Array<[number, number]>; radius: number }> };

// Statuses a bubble can show; 'running' and 'needs_input' are the live ones (M4).
export type BubbleStatus = 'running' | 'needs_input' | 'done' | 'failed' | 'cancelled';

// daemon → client
export type OutboundMessage =
  | { type: 'event'; event: EventRow }
  | { type: 'session_state'; state: 'idle' | 'listening' | 'thinking' | 'speaking' }
  | { type: 'assistant_delta'; item_id: string; delta: string }
  | { type: 'playback_flush' } // barge-in: drop queued speaker audio immediately
  | { type: 'bubble_upsert'; task_id: string; title: string; status: BubbleStatus } // shell: one panel per task
  | { type: 'bubble_remove'; task_id: string } // shell: fade the panel out (sent after the done-linger)
  // shell: brief notch pulse — task completion statuses, plus 'reminder' (M5) when a
  // scheduled reminder fires (the visual cue alongside the spoken delivery).
  | { type: 'notch_pulse'; status: Exclude<BubbleStatus, 'running' | 'needs_input'> | 'reminder' }
  // shell: a supervisor escalation needs the user's yes/no; deny happens daemon-side on timeout.
  | { type: 'confirm_request'; id: string; task_id: string; task_title: string; title: string; detail: string; timeout_ms: number }
  // shell: dismiss a pending confirm — its task was cancelled (daemon already resolved it deny).
  | { type: 'confirm_cancel'; id: string }
  // shell (M5): mirror a scheduled reminder into Reminders.app via EventKit (OS-durable —
  // fires even if the daemon is off). fire_at is epoch-ms like every other timestamp.
  | { type: 'create_reminder'; id: string; text: string; fire_at: number }
  // shell (M5): best-effort removal of a cancelled reminder's Reminders.app entry.
  | { type: 'remove_reminder'; id: string; eventkit_id: string };
