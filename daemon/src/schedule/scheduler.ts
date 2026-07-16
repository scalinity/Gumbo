// M5: the Gumbo-owned scheduler — a persistent timed-action primitive, not a one-shot.
// Rows live in sqlite (restart-safe by design; the boot reaper never touches them) and a
// poll loop fires due work so Gumbo proactively speaks at scheduled times. `kind` is the
// extensibility seam (recurring digests, timed task spawns later); M5 ships only
// kind:'reminder', one-shot.
//
// The honest split this module is designed around: the poll loop only fires while the
// daemon runs — a sleeping Mac fires late, on wake. EventKit (the create_reminder mirror
// the shell handles) is the reliable OS-level delivery; this loop is Gumbo's spoken
// presence when awake. Both together = complete.
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { ScheduleRow, Store } from '../events/store.ts';
import type { Hub } from '../ws/hub.ts';

/** What the scheduler needs from the hub — the full Hub in prod, a capture fake in tests. */
type HubLike = Pick<Hub, 'broadcast'>;

export class Scheduler {
  private store: Store;
  private hub: HubLike;
  private pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  /** Delivery seam, bound in index.ts (speak via the M3 announce path). Kept settable
   *  like manager.onFinished so construction order can't go circular. */
  onFire: (row: ScheduleRow) => void | Promise<void> = () => {};

  // No parameter properties: daemon tests run node --test in strip-only mode.
  constructor(store: Store, hub: HubLike, pollIntervalMs: number = config.schedule.pollIntervalMs) {
    this.store = store;
    this.hub = hub;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Resume polling over whatever pending rows persist in sqlite. Deliberately NO
   * immediate sweep: at daemon boot the shell hasn't reconnected yet (it retries every
   * 1.5 s), so a row that came due while the daemon was down would speak into a
   * shell-less hub and the spoken delivery would be silently lost. One poll interval of
   * grace costs nothing against 20 s poll granularity — and EventKit already delivered
   * the on-time notification if the daemon was off.
   */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweepNow(), this.pollIntervalMs);
    this.timer.unref(); // never the reason the process stays alive
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll: fire every due pending row. Public so tests drive it without timers. */
  sweepNow() {
    for (const row of this.store.duePendingSchedules(Date.now())) {
      // Mark fired BEFORE delivering (at-most-once): if delivery crashes, one spoken
      // reminder is lost — EventKit still notified at the OS level. Marking after would
      // re-fire a throwing row every poll, forever.
      this.store.updateScheduleStatus(row.id, 'fired');
      this.store.addEvent(null, 'reminder.fired', { id: row.id, kind: row.kind, text: row.text, fire_at: row.fire_at });
      Promise.resolve()
        .then(() => this.onFire({ ...row, status: 'fired' }))
        .catch((err: unknown) => {
          this.store.addEvent(null, 'session.error', { message: `reminder delivery: ${String(err)}` });
        });
    }
  }

  /**
   * Both halves, complementary (SPEC M5): the schedule row is Gumbo's own awareness —
   * it speaks the reminder when awake; the create_reminder mirror is EventKit durability —
   * Reminders.app fires at the OS level even if the daemon is off or the Mac is asleep.
   * The shell replies reminder_created with the EventKit id (stored for cancellation).
   */
  setReminder(text: string, fireAtMs: number): ScheduleRow {
    const row: ScheduleRow = {
      id: randomUUID().slice(0, 8),
      fire_at: fireAtMs,
      kind: 'reminder',
      text,
      status: 'pending',
      eventkit_id: null,
      created_at: Date.now(),
    };
    this.store.createSchedule(row);
    this.store.addEvent(null, 'reminder.set', { id: row.id, kind: row.kind, text, fire_at: fireAtMs });
    this.hub.broadcast({ type: 'create_reminder', id: row.id, text, fire_at: fireAtMs }, 'shell');
    return row;
  }

  /** Cancel a pending row + best-effort removal of its Reminders.app twin. Returns the
   *  cancelled row, or null when there was nothing pending to cancel. */
  cancelReminder(id: string): ScheduleRow | null {
    const row = this.store.getSchedule(id);
    if (!row || row.status !== 'pending') return null;
    this.store.updateScheduleStatus(id, 'cancelled');
    this.store.addEvent(null, 'reminder.cancelled', { id, text: row.text });
    if (row.eventkit_id) {
      this.hub.broadcast({ type: 'remove_reminder', id, eventkit_id: row.eventkit_id }, 'shell');
    }
    return { ...row, status: 'cancelled' };
  }

  listReminders(limit = 20): ScheduleRow[] {
    return this.store.listSchedules(limit);
  }

  /** Shell reply to create_reminder. A null eventkit_id means EventKit refused (no TCC
   *  grant, no calendar) — the row still fires daemon-side, so nothing else to do. If the
   *  row was cancelled while the shell was still creating the entry, remove the fresh
   *  EventKit twin immediately instead of orphaning it in Reminders.app. */
  handleReminderCreated(id: string, eventkitId: string | null) {
    if (!eventkitId) return;
    const row = this.store.getSchedule(id);
    if (!row) return;
    if (row.status === 'cancelled') {
      this.hub.broadcast({ type: 'remove_reminder', id, eventkit_id: eventkitId }, 'shell');
      return;
    }
    this.store.setScheduleEventkitId(id, eventkitId);
  }
}
