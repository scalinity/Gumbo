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
import { computeNextFire, describeRecurrence, parseRecurrence, type Recurrence } from './recurrence.ts';
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

  /** One poll: fire every due pending row. Public so tests drive it without timers. Never
   *  throws: this runs on a setInterval tick with no uncaughtException net, so a sqlite
   *  hiccup on the query or a mark-fired must degrade to "retry next poll," never crash the
   *  daemon (voice, tasks, and every other scheduled row ride the same process). */
  sweepNow() {
    let due: ScheduleRow[];
    try {
      due = this.store.duePendingSchedules(Date.now());
    } catch (err) {
      console.error('scheduler: due-query failed, retrying next poll:', err);
      return;
    }
    for (const row of due) {
      // Mark fired BEFORE delivering (at-most-once): if delivery crashes, one spoken
      // reminder is lost — EventKit still notified at the OS level. Marking after would
      // re-fire a throwing row every poll, forever. Mark + event share a transaction so
      // a crash between them can't consume a fire without its audit trace (review 🔵). If
      // the transaction itself throws, the row stays pending and retries next poll — so we
      // skip delivery rather than announce a fire we didn't record.
      // M8: a RECURRING row also inserts its next pending occurrence in the SAME
      // transaction (chain-of-rows — mutating fire_at in place would leave the row
      // pending across delivery and break at-most-once). Next fire computes from NOW, so
      // a slept-through Mac never causes a catch-up storm; duePendingSchedules was
      // prefetched, so the fresh future row can't be swept in this same pass.
      try {
        this.store.transaction(() => {
          this.store.updateScheduleStatus(row.id, 'fired');
          const eventType = row.kind === 'routine' ? 'routine.fired' : 'reminder.fired';
          this.store.addEvent(null, eventType, { id: row.id, kind: row.kind, text: row.text, fire_at: row.fire_at });
          if (row.recurrence) {
            // Guarded parse (review 🟡, corroborated): a non-JSON recurrence would THROW
            // here, roll back the mark-fired (breaking at-most-once — the row would
            // re-fire every poll forever) and escape the interval timer. A corrupt row
            // degrades to the same loud chain-end as a schema-invalid one.
            let rec = null;
            try {
              rec = parseRecurrence(JSON.parse(row.recurrence));
            } catch {
              rec = null;
            }
            if (rec) {
              this.store.createSchedule({
                id: randomUUID().slice(0, 8),
                fire_at: computeNextFire(rec, Date.now()),
                kind: row.kind,
                text: row.text,
                status: 'pending',
                eventkit_id: null,
                created_at: Date.now(),
                recurrence: row.recurrence,
                series_id: row.series_id ?? row.id,
              });
            } else {
              // A corrupt recurrence must not silently end the chain (Law 5) — say so.
              this.store.addEvent(null, 'session.error', { message: `schedule ${row.id}: unparseable recurrence — the chain ends here` });
            }
          }
        });
      } catch (err) {
        console.error(`scheduler: marking ${row.id} fired failed, retrying next poll:`, err);
        continue;
      }
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
      recurrence: null,
      series_id: null,
    };
    this.store.createSchedule(row);
    this.store.addEvent(null, 'reminder.set', { id: row.id, kind: row.kind, text, fire_at: fireAtMs });
    this.hub.broadcast({ type: 'create_reminder', id: row.id, text, fire_at: fireAtMs }, 'shell');
    return row;
  }

  /**
   * M8: schedule a saved procedure — one-shot or recurring. NO EventKit twin by design:
   * Reminders.app can't run a computer task, and the resync repair loop would otherwise
   * mint one Reminders.app entry per re-armed occurrence forever. Daemon-only firing is
   * the honest M5 stance (fires late on wake); the tool description says so.
   */
  scheduleRoutine(procedureName: string, fireAtMs: number, recurrence: Recurrence | null): ScheduleRow {
    const id = randomUUID().slice(0, 8);
    const row: ScheduleRow = {
      id,
      fire_at: fireAtMs,
      kind: 'routine',
      text: JSON.stringify({ procedure: procedureName }),
      status: 'pending',
      eventkit_id: null,
      created_at: Date.now(),
      recurrence: recurrence ? JSON.stringify(recurrence) : null,
      series_id: id,
    };
    this.store.createSchedule(row);
    this.store.addEvent(null, 'routine.scheduled', {
      id, procedure: procedureName, fire_at: fireAtMs,
      ...(recurrence ? { recurrence: describeRecurrence(recurrence) } : {}),
    });
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

  /**
   * Shell (re)connected: repair the EventKit mirror (review 🟡, corroborated). The
   * create/remove broadcasts are one-shot, so anything sent while no shell was connected
   * (relaunch window, dashboard-driven sessions) was silently dropped — leaving a pending
   * reminder without its OS-durable twin, or worse, a CANCELLED reminder whose twin
   * still notifies in Reminders.app. Re-send creation for pending rows without a twin
   * and removal for cancelled rows with one (clearing the stored id so the removal
   * re-send is itself one-shot). Known trade-off: if a twin was created but the
   * reminder_created reply was lost mid-flight, the re-create duplicates the
   * Reminders.app entry — rarer and more benign than a lost or undead reminder.
   */
  resyncEventKit() {
    for (const row of this.store.listSchedules(200)) {
      // M8: routines are EXCLUDED from the mirror — every re-armed occurrence is a fresh
      // pending row with a null eventkit_id, so this repair loop would otherwise create
      // one Reminders.app entry per occurrence on every shell hello, forever.
      if (row.kind !== 'reminder') continue;
      if (row.status === 'pending' && !row.eventkit_id) {
        this.hub.broadcast({ type: 'create_reminder', id: row.id, text: row.text, fire_at: row.fire_at }, 'shell');
      } else if (row.status === 'cancelled' && row.eventkit_id) {
        this.hub.broadcast({ type: 'remove_reminder', id: row.id, eventkit_id: row.eventkit_id }, 'shell');
        this.store.setScheduleEventkitId(row.id, null);
      }
    }
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
