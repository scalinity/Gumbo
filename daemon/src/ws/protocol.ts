// Wire protocol between daemon ⇄ shell and daemon ⇄ dashboard.
// Text frames are JSON envelopes; binary frames (audio) arrive in M2+.
import type { EventRow } from '../events/store.ts';

export type ClientRole = 'shell' | 'dashboard';

// client → daemon
export type InboundMessage =
  | { type: 'hello'; role: ClientRole }
  | { type: 'debug_text'; text: string }
  | { type: 'task_action'; task_id: string; action: 'cancel' };

// daemon → client
export type OutboundMessage =
  | { type: 'event'; event: EventRow }
  | { type: 'session_state'; state: 'idle' | 'listening' | 'thinking' | 'speaking' }
  | { type: 'assistant_delta'; item_id: string; delta: string };
