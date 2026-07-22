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
  private pending = new Map<string, {
    taskId: string;
    rememberHost?: string;
    settle: (approved: boolean) => void;
    /** The full request frame + absolute deadline — M8: pending confirms re-broadcast on
     *  shell hello (30 s windows made a shell relaunch a non-event; the hour-scale
     *  unattended-routine pause would otherwise park invisibly until auto-deny). */
    wire: Record<string, unknown>;
    expiresAt: number;
  }>();
  private hub: Hub;
  private timeoutMs: number;
  /** M7: invoked when the user approves WITH the "remember" toggle on a host confirm —
   *  index.ts wires it to the allowlist write-through (mac/hosts.rememberHost). */
  onRemember: (host: string) => void = () => {};

  // No parameter properties: daemon tests run node --test in strip-only mode. timeoutMs is
  // injectable so tests don't wait the full 60 s to exercise deny-on-timeout.
  constructor(hub: Hub, timeoutMs: number = config.claude.confirmTimeoutMs) {
    this.hub = hub;
    this.timeoutMs = timeoutMs;
  }

  /** `body` is the optional long-form content behind the one-line title/detail — the full
   *  plan text for a plan approval, expandable in the shell (chevron → scrollable view).
   *  `rememberHost` labels a "Remember <host>" toggle on the panel (M7 host confirms).
   *  `confirmLabel`/`denyLabel` override the button text (handoffs say Done/Cancel).
   *  M8 `opts.waitForShell`: an unattended routine's confirm PARKS when no shell is
   *  connected (registered pending, broadcast on the next hello via resync) instead of
   *  the instant deny — its long window is the real bound, and deny-on-timeout stays. */
  request(taskId: string, taskTitle: string, title: string, detail: string, signal?: AbortSignal, timeoutMs?: number, body?: string, rememberHost?: string, confirmLabel?: string, denyLabel?: string, opts?: { waitForShell?: boolean }): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (!this.hub.hasRole('shell') && !opts?.waitForShell) return Promise.resolve(false); // nobody to ask
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
      const wire = {
        type: 'confirm_request', id, task_id: taskId, task_title: taskTitle, title, detail, timeout_ms: budget,
        ...(body ? { body } : {}),
        ...(rememberHost ? { remember_host: rememberHost } : {}),
        ...(confirmLabel ? { confirm_label: confirmLabel } : {}),
        ...(denyLabel ? { deny_label: denyLabel } : {}),
      };
      this.pending.set(id, { taskId, rememberHost, settle, wire, expiresAt: Date.now() + budget });
      if (this.hub.hasRole('shell')) this.hub.broadcast(wire as never, 'shell');
    });
  }

  /** M8: shell (re)connected — re-present every still-pending confirm with its REMAINING
   *  window (the shell's countdown renders from timeout_ms). ConfirmController state died
   *  with the shell; without this, a long-window pause parks invisibly until auto-deny. */
  resync() {
    const now = Date.now();
    for (const entry of this.pending.values()) {
      const remaining = entry.expiresAt - now;
      if (remaining <= 0) continue; // the timer is about to settle it — don't re-ask
      this.hub.broadcast({ ...entry.wire, timeout_ms: remaining } as never, 'shell');
    }
  }

  handleResponse(id: string, approved: boolean, remember = false) {
    const entry = this.pending.get(id);
    if (!entry) return; // late/duplicate answer after settle — no-op
    // Write-through BEFORE settling: the waiting caller may immediately re-check the
    // allowlist (memoization aside), and remember-on-deny is meaningless.
    if (approved && remember && entry.rememberHost) {
      try {
        this.onRemember(entry.rememberHost);
      } catch (err) {
        console.error('confirm remember write-through failed:', err);
      }
    }
    entry.settle(approved);
  }

  /** A task reached a terminal state — deny + dismiss every confirm it still has pending.
   *  Belt-and-suspenders with the per-request abort signal: the cap-parked path (no live
   *  runner, so no abort wired) and any future signal-less caller are covered here, and the
   *  shell additionally self-dismisses on task removal for the daemon-restart case where
   *  this bridge never knew the confirm existed. */
  cancelForTask(taskId: string) {
    for (const [id, entry] of [...this.pending]) {
      if (entry.taskId !== taskId) continue;
      this.hub.broadcast({ type: 'confirm_cancel', id }, 'shell');
      entry.settle(false);
    }
  }
}
