import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { Hub } from './hub.ts';
import type { MacAction, MacActionResult, MacErrorKind, MacHealth } from './protocol.ts';

const ERROR_KINDS: ReadonlySet<string> = new Set([
  'element_not_found', 'stale_ref', 'ax_unavailable', 'timeout', 'out_of_scope',
  'secure_field', 'script_error', 'aborted', 'capture_denied',
] satisfies MacErrorKind[]);
const HEALTH_STATES: ReadonlySet<string> = new Set(
  ['healthy', 'stale_cache', 'ax_disabled', 'not_granted'] satisfies MacHealth[],
);

/** A bridge-level failure shaped exactly like an executor failure, so callers branch on
 *  one contract (`error_kind`) whether the shell answered, timed out, or never existed. */
function failure(kind: MacErrorKind, output: string): MacActionResult {
  return { ok: false, error_kind: kind, output };
}

/**
 * M6 computer-use bridge: brain = daemon, hands = shell (the shell owns the TCC grants,
 * so AX and osascript execute there). Same shape as ConfirmBridge — correlation id,
 * pending map, per-request timer — but resolving to a typed MacActionResult instead of a
 * boolean. Fails safe the same way: no shell, a timeout, or an aborted task all resolve
 * to a typed error result, never a hang (a sub-agent loop or a live voice turn is
 * waiting on every one of these).
 */
export class MacBridge {
  private pending = new Map<string, (result: MacActionResult) => void>();
  private hub: Hub;
  private timeoutMs: number;
  // Refcount of running computer-use tasks. The shell's kill-switch tap and ghost cursor
  // are armed while any task runs; edge-triggered broadcasts keep the wire quiet.
  private activeTasks = 0;

  // No parameter properties: daemon tests run node --test in strip-only mode. timeoutMs
  // is injectable so tests don't wait real budgets to exercise the timeout path.
  constructor(hub: Hub, timeoutMs: number = config.mac.rpcTimeoutMs) {
    this.hub = hub;
    this.timeoutMs = timeoutMs;
  }

  /** Send one action to the shell and await its typed result. Scripts pass their own
   *  timeoutMs (script budget + margin); AX actions ride the default RPC budget. */
  request(action: MacAction, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<MacActionResult> {
    if (!this.hub.hasRole('shell')) {
      return Promise.resolve(failure('ax_unavailable', 'The Mac control surface is offline (Gumbo shell not connected).'));
    }
    if (opts.signal?.aborted) return Promise.resolve(failure('aborted', 'Task was cancelled.'));
    const budget = opts.timeoutMs ?? this.timeoutMs;
    const id = randomUUID().slice(0, 8);
    return new Promise<MacActionResult>((resolve) => {
      const settle = (result: MacActionResult) => {
        if (!this.pending.has(id)) return; // already settled (timeout / result / abort race)
        this.pending.delete(id);
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => settle(failure('aborted', 'Task was cancelled.'));
      const timer = setTimeout(
        () => settle(failure('timeout', `The shell did not answer within ${budget} ms.`)),
        budget,
      );
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, settle);
      this.hub.broadcast({ type: 'mac_action', id, action }, 'shell');
    });
  }

  /** Wire-facing: the shell's payload is untrusted-shaped (hand-built [String: Any]
   *  JSON), so coerce it into the typed contract before it reaches a caller. */
  handleResult(id: string, raw: unknown) {
    const settle = this.pending.get(id);
    if (!settle) return; // late/duplicate/unknown id after settle — no-op like confirms
    settle(this.sanitize(raw));
  }

  private sanitize(raw: unknown): MacActionResult {
    if (typeof raw !== 'object' || raw === null) {
      return failure('ax_unavailable', 'Malformed result from the shell.');
    }
    const r = raw as { ok?: unknown; output?: unknown; error_kind?: unknown; health?: unknown };
    const output = typeof r.output === 'string' ? r.output.slice(0, config.mac.outputMaxChars) : '';
    const result: MacActionResult = { ok: r.ok === true, output };
    if (typeof r.error_kind === 'string' && ERROR_KINDS.has(r.error_kind)) {
      result.error_kind = r.error_kind as MacErrorKind;
    } else if (!result.ok) {
      result.error_kind = 'ax_unavailable'; // a failure must always carry a branchable kind
    }
    if (typeof r.health === 'string' && HEALTH_STATES.has(r.health)) {
      result.health = r.health as MacHealth;
    }
    if ((r as { no_change?: unknown }).no_change === true) result.no_change = true;
    return result;
  }

  /** Computer-use task lifecycle — arms/disarms the shell's kill-switch tap + ghost
   *  cursor. Refcounted so two concurrent tasks don't disarm each other's kill switch. */
  taskStarted() {
    this.activeTasks += 1;
    if (this.activeTasks === 1) this.hub.broadcast({ type: 'mac_task', active: true }, 'shell');
  }

  taskFinished() {
    if (this.activeTasks === 0) return; // underflow guard — already disarmed, stay quiet
    this.activeTasks -= 1;
    if (this.activeTasks === 0) this.hub.broadcast({ type: 'mac_task', active: false }, 'shell');
  }

  /** "the user's input is expected": while active, the shell's kill switch treats his input
   *  as the answer (not an abort) and the ghost cursor hides. Covers the M7 cooperative
   *  handoff AND every notch confirm a computer task raises (host approvals, risky
   *  scripts, submit gates) — reaching the Approve button takes his mouse (live-demo
   *  Catch-22; manager.makeStandDown is the one bracket). Edge-triggered like mac_task;
   *  single flag — one computer task drives at a time by construction. */
  setHandoff(active: boolean) {
    if (this.handoffActive === active) return;
    this.handoffActive = active;
    this.hub.broadcast({ type: 'mac_handoff', active }, 'shell');
  }
  private handoffActive = false;

  /** M8 teaching state: while active, the shell's tap runs in RECORD mode (the user's
   *  input is the demonstration). Edge-triggered like setHandoff; teaching and computer
   *  tasks are mutually exclusive (manager), so one flag suffices. */
  setTeaching(active: boolean) {
    if (this.teachingActive === active) return;
    this.teachingActive = active;
    this.hub.broadcast({ type: 'mac_teach', active }, 'shell');
  }
  private teachingActive = false;

  /** A shell that (re)connects mid-task must arm its kill switch immediately —
   *  broadcast the current state on every hello (shell relaunches are routine).
   *  Handoff state rides along: reconnecting mid-handoff must NOT abort on the user's
   *  in-progress typing. M8: teach state is UNCONDITIONAL like mac_task — a shell
   *  still recording for a restarted (teach-less) daemon must be told to stop, and a
   *  fresh shell mid-teach must re-arm its recorder. */
  resync() {
    this.hub.broadcast({ type: 'mac_task', active: this.activeTasks > 0 }, 'shell');
    if (this.handoffActive) this.hub.broadcast({ type: 'mac_handoff', active: true }, 'shell');
    this.hub.broadcast({ type: 'mac_teach', active: this.teachingActive }, 'shell');
  }
}
