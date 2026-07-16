import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { Hub } from './hub.ts';

/**
 * M4 notch-confirm bridge: a supervisor escalation becomes a confirm_request to the
 * shell; the user's confirm_response resolves it. Fails safe — no shell connected, a
 * timeout, or an unknown id all mean deny. Claude sessions run for minutes unattended,
 * so a hung confirm must never be able to wedge one (the timeout is the guarantee).
 */
export class ConfirmBridge {
  private pending = new Map<string, { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }>();
  private hub: Hub;

  // No parameter properties: daemon tests run node --test in strip-only mode.
  constructor(hub: Hub) {
    this.hub = hub;
  }

  request(taskId: string, taskTitle: string, title: string, detail: string): Promise<boolean> {
    if (!this.hub.hasRole('shell')) return Promise.resolve(false); // nobody to ask
    const id = randomUUID().slice(0, 8);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false); // deny on timeout (locked in SPEC §6)
      }, config.claude.confirmTimeoutMs);
      this.pending.set(id, { resolve, timer });
      this.hub.broadcast(
        { type: 'confirm_request', id, task_id: taskId, task_title: taskTitle, title, detail, timeout_ms: config.claude.confirmTimeoutMs },
        'shell',
      );
    });
  }

  handleResponse(id: string, approved: boolean) {
    const entry = this.pending.get(id);
    if (!entry) return; // late/duplicate answer after timeout — already denied
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(approved);
  }
}
