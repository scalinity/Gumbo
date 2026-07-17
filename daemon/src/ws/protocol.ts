// Wire protocol between daemon ⇄ shell and daemon ⇄ dashboard.
// Text frames are JSON envelopes. Binary frames carry audio:
//   shell → daemon: raw mic pcm16 (24 kHz mono), streamed only while ⌃⌥ is armed
//   daemon → shell: speaker pcm16 with a 1-byte header — 0x01 realtime voice,
//                   0x02 one-shot TTS (reserved for M3 announcements)
import type { EventRow } from '../events/store.ts';

export type ClientRole = 'shell' | 'dashboard';

export const AUDIO_REALTIME = 0x01;
export const AUDIO_TTS = 0x02;

// ——— M6 computer use: daemon = brain, shell = hands (TCC attribution) ———

/** Verbs ax_act dispatches through the ladder (AXPress → CGEventPostToPid → global CGEvent).
 *  wait_for is a verb, not a tool — waits live in the executor, never as model-issued sleeps. */
export type MacActVerb = 'press' | 'focus' | 'set_value' | 'type' | 'key' | 'show_menu' | 'wait_for';

/** One shell-executed step. Nullable fields are per-verb: act needs ref (except wait_for,
 *  which matches on role+name); script carries its own hard timeout (Tahoe -1712 hangs). */
export type MacAction =
  | { kind: 'health' } // LIVE permission probe — AXIsProcessTrusted() has a stale-cache failure mode
  | { kind: 'snapshot'; app: string | null; max_elements: number } // compacted AX tree; app null = frontmost
  | { kind: 'query'; query: string; max_results: number } // grep the shell-held FULL tree for more (it never enters LLM context)
  | { kind: 'act'; verb: MacActVerb; ref: string | null; value: string | null; role: string | null; name: string | null; timeout_ms: number }
  | { kind: 'script'; interpreter: 'osascript' | 'shortcuts'; script: string; timeout_ms: number };

/** SPEC §M6 typed errors (mirrors SearchError.kind — callers branch on kind, never message
 *  strings). The last three are lane-level: secure_field is the executor's hard refusal,
 *  script_error a nonzero exit, aborted the task-cancel/kill-switch path. */
export type MacErrorKind =
  | 'element_not_found' | 'stale_ref' | 'ax_unavailable' | 'timeout' | 'out_of_scope'
  | 'secure_field' | 'script_error' | 'aborted';

/** Permission health is a state machine, not a boolean: stale_cache = trusted-but-broken
 *  (relaunch fixes), ax_disabled = kAXErrorAPIDisabled, not_granted = never authorized. */
export type MacHealth = 'healthy' | 'stale_cache' | 'ax_disabled' | 'not_granted';

/** Every mac_action resolves to this. output is the payload the sub-agent/model reads:
 *  snapshot → flat compacted tree, act → settled before/after DIFF (verify by diff, never
 *  return code — AXPress false-passes), script → stdout/stderr, health → probe detail. */
export type MacActionResult = {
  ok: boolean;
  output: string;
  error_kind?: MacErrorKind;
  health?: MacHealth;
};

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
  | { type: 'image_edit_request'; file: string; prompt: string; strokes?: Array<{ points: Array<[number, number]>; radius: number }> }
  // shell (M6): the executor's answer to a mac_action, matched by correlation id.
  | { type: 'mac_action_result'; id: string; result: MacActionResult }
  // shell (M6): kill switch fired — untagged HID input (the user touched the machine) or
  // the abort hotkey. The daemon cancels every running computer-use task.
  | { type: 'mac_abort'; reason: 'human_input' | 'hotkey' };

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
  | { type: 'remove_reminder'; id: string; eventkit_id: string }
  // shell (M6): execute one computer-use step (AX, script, probe) and reply
  // mac_action_result with the same id.
  | { type: 'mac_action'; id: string; action: MacAction }
  // shell (M6): a computer-use task started/finished — arms/disarms the kill-switch
  // event tap and the ghost-cursor session (refcounted daemon-side; edge-triggered).
  | { type: 'mac_task'; active: boolean };
