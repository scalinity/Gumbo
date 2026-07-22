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
export type MacActVerb = 'press' | 'focus' | 'set_value' | 'type' | 'key' | 'show_menu' | 'wait_for' | 'select_text' | 'menu_path' | 'replace_text' | 'paste';

/** One shell-executed step. Nullable fields are per-verb: act needs ref (except wait_for,
 *  which matches on role+name); script carries its own hard timeout (Tahoe -1712 hangs).
 *  M7 vision lane (ocr/screenshot/point): capture rides ScreenCaptureKit — the Screen
 *  Recording TCC grant prompts on FIRST use, the last planned grant. `region` is a global
 *  TOP-LEFT points rect [x,y,w,h]; ALL coordinate math (Retina DPR, multi-display,
 *  Vision's bottom-left origin) stays SHELL-side, so the model only ever sees global
 *  points it can hand straight back to `point` (the documented #1 offset-click cause,
 *  structurally removed). */
export type MacAction =
  | { kind: 'health' } // LIVE permission probe — AXIsProcessTrusted() has a stale-cache failure mode
  | { kind: 'snapshot'; app: string | null; max_elements: number } // compacted AX tree; app null = frontmost
  | { kind: 'query'; query: string; max_results: number } // grep the shell-held FULL tree for more (it never enters LLM context)
  | { kind: 'act'; verb: MacActVerb; ref: string | null; value: string | null; role: string | null; name: string | null; timeout_ms: number; occurrence?: number; rtf?: string } // occurrence: select_text match index (0-based); rtf: paste — base64 RTF of the captured clipboard so styling survives
  | { kind: 'script'; interpreter: 'osascript' | 'shortcuts'; script: string; timeout_ms: number }
  | { kind: 'ocr'; app: string | null; region: [number, number, number, number] | null } // on-device Vision OCR → text lines w/ global point centers
  | { kind: 'screenshot'; app: string | null; region: [number, number, number, number] | null; out_path: string } // PNG to a daemon-supplied workspace path
  | { kind: 'point'; verb: 'click' | 'double_click' | 'right_click'; x: number; y: number } // vision-lane action at global point coords
  | { kind: 'cursor_to'; x: number; y: number } // pure visualization: fly the ghost cursor (browser-lane acts ride CDP, not HID — the ghost is their only visible trace)
  | { kind: 'clipboard_snapshot' } // M8 image-save: losslessly save the user's clipboard before a "Copy Image" clobbers it
  | { kind: 'clipboard_restore' } // M8 image-save: put the saved clipboard back after the file is written+verified
  | { kind: 'activate'; app: string } // bring an app to the FRONT via the shell's AX grant (the system suppresses plain open/activate — Foreground.swift)
  // M8 teaching: flip the shell's kill-switch tap into RECORD mode — the user's untagged
  // input becomes the demonstration (streamed back as teach_event), never an abort. The
  // stop ack arrives AFTER the shell flushes its pending typing burst, so the daemon has
  // every step by the time record_stop resolves (ordering is load-bearing — manager.ts).
  | { kind: 'record_start' }
  | { kind: 'record_stop' }
  // M8 replay resolution: match a taught target (role/name/identifier) against the LAST
  // snapshot's nodes, shell-side, returning ONLY the ref string — never by parsing
  // snapshot text daemon-side (unescaped quotes + clipping break parsers, and screen-text
  // values choosing the acted-on element would be an injection surface). Resolution is an
  // observation; the subsequent act inherits every gate.
  | { kind: 'resolve'; role: string | null; name: string | null; identifier: string | null }
  // M8 teaching outcome: read the DEMONSTRATED text document of an app — full text +
  // styled ranges (AXAttributedString style names/list structure/underline/font traits).
  // Captured at teach-stop so the compiler builds CONTENT from the observed RESULT
  // instead of keystroke archaeology. identifier/role (when present) select the exact
  // field the demonstration typed into; the largest text area is only the fallback —
  // capture scope should match what the user actually demonstrated, not the biggest thing
  // on screen.
  | { kind: 'document_state'; app: string | null; identifier?: string | null; role?: string | null };

/** SPEC §M6 typed errors (mirrors SearchError.kind — callers branch on kind, never message
 *  strings). The lane-level ones: secure_field is the executor's hard refusal,
 *  script_error a nonzero exit, aborted the task-cancel/kill-switch path, capture_denied
 *  the missing/declined Screen Recording grant (M7 — stop and tell the user; other capture
 *  failures ride timeout/ax_unavailable). */
export type MacErrorKind =
  | 'element_not_found' | 'stale_ref' | 'ax_unavailable' | 'timeout' | 'out_of_scope'
  | 'secure_field' | 'script_error' | 'aborted' | 'capture_denied' | 'element_disabled';

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
  /** act only: the settled before/after diff was EMPTY — a structured no-op signal. The
   *  stall detector keys on this, never on output text (on-screen content echoed into the
   *  output could otherwise spoof or suppress it). */
  no_change?: boolean;
  /** select_text only: which mechanism made the selection. 'ax-write' is a SHADOW — the
   *  range reads back but the app's format actions may not track it; the replay engine
   *  branches on this structurally (never on output text, same rationale as no_change). */
  select_how?: 'real click' | 'keyboard' | 'ax-write';
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
  // shell: the user answered a notch confirm (M4 supervisor escalation). M7: `remember`
  // rides an approval whose request carried remember_host — write the host through to
  // the allowlist so this site never asks again.
  | { type: 'confirm_response'; id: string; approved: boolean; remember?: boolean }
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
  // shell (2026-07-16): the file viewer's open document — what an edit_file voice edit
  // resolves "this document" against. path null = viewer closed.
  | { type: 'file_context'; path: string | null }
  // shell (2026-07-16): a typed edit request from the file viewer's composer (voice edits
  // ride the realtime session + edit_file tool instead).
  | { type: 'file_edit_request'; path: string; prompt: string }
  // shell (M6): the executor's answer to a mac_action, matched by correlation id.
  | { type: 'mac_action_result'; id: string; result: MacActionResult }
  // shell (M6): kill switch fired — untagged HID input (the user touched the machine), the
  // abort hotkey, or the kill switch failing to arm (fail closed). The daemon cancels every
  // running computer-use task.
  | { type: 'mac_abort'; reason: 'human_input' | 'hotkey' | 'kill_switch_unavailable' }
  // shell (M8): one semantically-resolved demonstration step from the record-mode tap
  // (role/label/identifier — never coordinates, and secure-field content never leaves the
  // shell). Untrusted-shaped hand-built JSON — sanitized in tasks/teach.ts before use.
  | { type: 'teach_event'; step: unknown };

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
  // shell: brief notch pulse — task completion statuses, 'reminder' (M5) when a
  // scheduled reminder fires, and 'needs_input' (M8) when a task pauses for the user
  // (the unattended-routine pause must be visible, not just spoken into an empty room).
  | { type: 'notch_pulse'; status: Exclude<BubbleStatus, 'running'> | 'reminder' }
  // shell: a supervisor escalation needs the user's yes/no; deny happens daemon-side on timeout.
  // `body` is optional long-form content behind the one-liner (the full plan text for a plan
  // approval) — the shell renders it behind a chevron as a scrollable view.
  // M7: remember_host labels the "Remember <host>" toggle on host-approval confirms;
  // confirm_label/deny_label override the button text (a handoff says Done/Cancel).
  | { type: 'confirm_request'; id: string; task_id: string; task_title: string; title: string; detail: string; timeout_ms: number; body?: string; remember_host?: string; confirm_label?: string; deny_label?: string }
  // shell: dismiss a pending confirm — its task was cancelled (daemon already resolved it deny).
  | { type: 'confirm_cancel'; id: string }
  // shell (M5): mirror a scheduled reminder into Reminders.app via EventKit (OS-durable —
  // fires even if the daemon is off). fire_at is epoch-ms like every other timestamp.
  | { type: 'create_reminder'; id: string; text: string; fire_at: number }
  // shell (M5): best-effort removal of a cancelled reminder's Reminders.app entry.
  | { type: 'remove_reminder'; id: string; eventkit_id: string }
  // shell (2026-07-16): present a file the user should see — a document card in the top-right
  // stack; clicking it opens Gumbo's own renderer (markdown prettified). Content rides
  // inline (size-capped daemon-side) so no new HTTP file-serving surface is exposed.
  | { type: 'file_present'; title: string; file: string; path: string; content: string }
  // shell (M5.5 follow-up): open a gallery image in the viewer/editor by voice — the
  // open_image tool resolved the word-name daemon-side; the viewer arms the edit context.
  | { type: 'open_image'; file: string }
  // shell (M6): execute one computer-use step (AX, script, probe) and reply
  // mac_action_result with the same id.
  | { type: 'mac_action'; id: string; action: MacAction }
  // shell (M6): a computer-use task started/finished — arms/disarms the kill-switch
  // event tap and the ghost-cursor session (refcounted daemon-side; edge-triggered).
  | { type: 'mac_task'; active: boolean }
  // shell (M7): cooperative handoff — the user is performing a step THEMSELVES (login,
  // permission dialog). The kill switch stands down (their input is the handoff, not an
  // abort) and the ghost cursor hides until the handoff ends.
  | { type: 'mac_handoff'; active: boolean }
  // shell (M8): teaching state, resync-broadcast on every hello like mac_task — a shell
  // that (re)connects while the daemon is mid-teach re-arms its recorder; active:false
  // stops a recorder whose daemon-side teach session died (restart, cancel).
  | { type: 'mac_teach'; active: boolean };
