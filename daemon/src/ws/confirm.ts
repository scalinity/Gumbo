import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { Hub } from './hub.ts';

/**
 * M4 notch-confirm bridge: a supervisor escalation becomes a confirm_request to the
 * shell; the user's confirm_response resolves it. Fails safe — no shell connected, a
 * timeout, an aborted task, or an unknown id all mean deny. Claude sessions run for
 * minutes unattended, so a hung confirm must never be able to wedge one (the timeout is
 * the guarantee). Every request carries its own timer keyed by id; concurrent escalations
 * from two sessions each get their own — the shell shows one at a time, so a second's
 * timer can expire while it waits in the shell queue (rare; still fails safe to deny).
 */
export class ConfirmBridge {
  private pending = new Map<string, (approved: boolean) => void>();
  private hub: Hub;
  private timeoutMs: number;

  // No parameter properties: daemon tests run node --test in strip-only mode. timeoutMs is
  // injectable so tests don't wait the full 60 s to exercise deny-on-timeout.
  constructor(hub: Hub, timeoutMs: number = config.claude.confirmTimeoutMs) {
    this.hub = hub;
    this.timeoutMs = timeoutMs;
  }

  request(taskId: string, taskTitle: string, title: string, detail: string, signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
    if (!this.hub.hasRole('shell') || signal?.aborted) return Promise.resolve(false); // nobody to ask / already cancelled
    const budget = timeoutMs ?? this.timeoutMs; // plan approval passes a longer window
    const id = randomUUID().slice(0, 8);
    return new Promise<boolean>((resolve) => {
      const settle = (approved: boolean) => {
        if (!this.pending.has(id)) return; // already settled (timeout / response / abort race)
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(approved);
      };
      const onAbort = () => {
        // Task cancelled while the confirm was pending — dismiss the shell panel promptly
        // instead of leaving it up until the timeout, and deny.
        this.hub.broadcast({ type: 'confirm_cancel', id }, 'shell');
        settle(false);
      };
      const timer = setTimeout(() => settle(false), budget); // deny on timeout (SPEC §6)
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, settle);
      this.hub.broadcast(
        { type: 'confirm_request', id, task_id: taskId, task_title: taskTitle, title, detail, timeout_ms: budget },
        'shell',
      );
    });
  }

  handleResponse(id: string, approved: boolean) {
    this.pending.get(id)?.(approved); // no-op for a late/duplicate answer after settle
  }
}
