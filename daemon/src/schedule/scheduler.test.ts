import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { Store } = await import('../events/store.ts');
const { Scheduler } = await import('./scheduler.ts');
type ScheduleRow = import('../events/store.ts').ScheduleRow;
type EventRow = import('../events/store.ts').EventRow;

function fakeHub() {
  const sent: Array<{ msg: Record<string, unknown>; to?: string }> = [];
  return { sent, broadcast: (msg: unknown, to?: unknown) => sent.push({ msg: msg as Record<string, unknown>, to: to as string }) };
}

function setup(dbPath?: string) {
  const path = dbPath ?? join(mkdtempSync(join(tmpdir(), 'gumbo-sched-')), 'gumbo.db');
  const store = new Store(path);
  const events: EventRow[] = [];
  store.onEvent((e) => events.push(e));
  const hub = fakeHub();
  const fired: ScheduleRow[] = [];
  const scheduler = new Scheduler(store, hub);
  scheduler.onFire = (row) => fired.push(row);
  return { path, store, events, hub, fired, scheduler };
}

const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test('set_reminder message contract: pending row + create_reminder {id, text, fire_at} to the shell', () => {
  const { hub, scheduler, events, store } = setup();
  const fireAt = Date.now() + 60_000;
  const row = scheduler.setReminder('review the wallpaper', fireAt);

  assert.equal(row.kind, 'reminder');
  assert.equal(row.status, 'pending');
  assert.equal({ ...store.getSchedule(row.id) }.status, 'pending');

  assert.equal(hub.sent.length, 1);
  assert.equal(hub.sent[0].to, 'shell');
  assert.deepEqual(hub.sent[0].msg, { type: 'create_reminder', id: row.id, text: 'review the wallpaper', fire_at: fireAt });

  const set = events.find((e) => e.type === 'reminder.set');
  assert.ok(set, 'reminder.set event emitted');
  assert.deepEqual(set.payload, { id: row.id, kind: 'reminder', text: 'review the wallpaper', fire_at: fireAt });
});

test('a due row fires exactly once: marked fired, reminder.fired emitted, delivery invoked', async () => {
  const { scheduler, store, events, fired } = setup();
  const row = scheduler.setReminder('due now', Date.now() - 5);

  scheduler.sweepNow();
  await drainMicrotasks();
  assert.equal(store.getSchedule(row.id)?.status, 'fired');
  const firedEvent = events.find((e) => e.type === 'reminder.fired');
  assert.ok(firedEvent, 'reminder.fired event emitted');
  assert.equal((firedEvent.payload as { text: string }).text, 'due now');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, row.id);
  assert.equal(fired[0].status, 'fired');

  // A fired row never re-fires.
  scheduler.sweepNow();
  await drainMicrotasks();
  assert.equal(fired.length, 1);
});

test('a future row does not fire', async () => {
  const { scheduler, store, fired } = setup();
  const row = scheduler.setReminder('later', Date.now() + 3_600_000);
  scheduler.sweepNow();
  await drainMicrotasks();
  assert.equal(fired.length, 0);
  assert.equal(store.getSchedule(row.id)?.status, 'pending');
});

test('restart reload: rows persist, the reaper leaves them alone, a new scheduler fires them', async () => {
  const first = setup();
  const row = first.scheduler.setReminder('survive the restart', Date.now() - 5);

  // "Restart": a fresh Store + Scheduler on the same db file, reaper included (it must
  // only reconcile the tasks table — a pending reminder outliving the daemon is the point).
  const second = setup(first.path);
  second.store.reapInterruptedTasks();
  assert.equal(second.store.getSchedule(row.id)?.status, 'pending', 'reaper must not touch schedule rows');

  second.scheduler.sweepNow();
  await drainMicrotasks();
  assert.equal(second.fired.length, 1);
  assert.equal(second.fired[0].text, 'survive the restart');
  assert.equal(second.store.getSchedule(row.id)?.status, 'fired');
});

test('cancel: row cancelled, reminder.cancelled emitted, EventKit twin removed, no fire', async () => {
  const { scheduler, store, events, hub, fired } = setup();
  const row = scheduler.setReminder('cancel me', Date.now() - 5); // already due — cancel still wins
  scheduler.handleReminderCreated(row.id, 'EK-123');
  assert.equal(store.getSchedule(row.id)?.eventkit_id, 'EK-123');

  const cancelled = scheduler.cancelReminder(row.id);
  assert.equal(cancelled?.text, 'cancel me');
  assert.equal(store.getSchedule(row.id)?.status, 'cancelled');
  assert.ok(events.some((e) => e.type === 'reminder.cancelled'));
  const remove = hub.sent.find((s) => s.msg.type === 'remove_reminder');
  assert.deepEqual(remove?.msg, { type: 'remove_reminder', id: row.id, eventkit_id: 'EK-123' });

  scheduler.sweepNow();
  await drainMicrotasks();
  assert.equal(fired.length, 0, 'a cancelled row must not fire');

  // Cancelling again (or anything non-pending) is a clean no-op.
  assert.equal(scheduler.cancelReminder(row.id), null);
  assert.equal(scheduler.cancelReminder('nope'), null);
});

test('reminder_created contract: null id ignored; late reply after cancel removes the fresh twin', () => {
  const { scheduler, store, hub } = setup();
  const row = scheduler.setReminder('race me', Date.now() + 60_000);

  scheduler.handleReminderCreated(row.id, null); // EventKit refused (no grant) — row unchanged
  assert.equal(store.getSchedule(row.id)?.eventkit_id, null);

  scheduler.cancelReminder(row.id); // no twin yet → no remove_reminder here
  assert.ok(!hub.sent.some((s) => s.msg.type === 'remove_reminder'));

  // The shell's reply lands AFTER the cancel: remove the just-created Reminders.app entry
  // instead of orphaning it.
  scheduler.handleReminderCreated(row.id, 'EK-LATE');
  const remove = hub.sent.find((s) => s.msg.type === 'remove_reminder');
  assert.deepEqual(remove?.msg, { type: 'remove_reminder', id: row.id, eventkit_id: 'EK-LATE' });
  assert.equal(store.getSchedule(row.id)?.eventkit_id, null, 'a cancelled row never adopts the twin');
});

test('a throwing delivery is contained: session.error logged, row stays fired', async () => {
  const { scheduler, store, events } = setup();
  scheduler.onFire = () => {
    throw new Error('speaker on fire');
  };
  const row = scheduler.setReminder('boom', Date.now() - 5);
  scheduler.sweepNow();
  await drainMicrotasks();
  assert.equal(store.getSchedule(row.id)?.status, 'fired');
  const err = events.find((e) => e.type === 'session.error');
  assert.match(String((err?.payload as { message: string })?.message), /speaker on fire/);
});

test('the poll loop fires due rows on its own (start/stop)', async () => {
  const { store, hub, fired } = setup();
  const scheduler = new Scheduler(store, hub, 20);
  scheduler.onFire = (row) => fired.push(row);
  scheduler.setReminder('polled', Date.now() + 1);
  scheduler.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fired.length, 1);
    assert.equal(fired[0].text, 'polled');
  } finally {
    scheduler.stop();
  }
});

test('resyncEventKit repairs the mirror on shell hello: re-create missing twins, remove surviving cancelled twins once', () => {
  const { scheduler, store, hub } = setup();
  const now = Date.now();
  const orphanPending = scheduler.setReminder('never mirrored', now + 60_000); // no reply came back
  const mirrored = scheduler.setReminder('mirrored fine', now + 60_000);
  scheduler.handleReminderCreated(mirrored.id, 'EK-OK');
  const undead = scheduler.setReminder('cancelled but twin survives', now + 60_000);
  scheduler.handleReminderCreated(undead.id, 'EK-UNDEAD');
  scheduler.cancelReminder(undead.id); // remove_reminder broadcast below simulates being lost:
  hub.sent.length = 0; // shell was down for everything above — now it reconnects

  scheduler.resyncEventKit();
  const creates = hub.sent.filter((s) => s.msg.type === 'create_reminder');
  const removes = hub.sent.filter((s) => s.msg.type === 'remove_reminder');
  assert.deepEqual(creates.map((s) => s.msg.id), [orphanPending.id], 're-create ONLY the un-mirrored pending row');
  assert.deepEqual(removes.map((s) => s.msg.eventkit_id), ['EK-UNDEAD'], 're-remove ONLY the surviving cancelled twin');
  assert.equal(store.getSchedule(undead.id)?.eventkit_id, null, 'cleared so the removal re-send is one-shot');

  // A second hello re-sends only what is still unrepaired (the pending orphan).
  hub.sent.length = 0;
  scheduler.resyncEventKit();
  assert.equal(hub.sent.filter((s) => s.msg.type === 'remove_reminder').length, 0);
  assert.deepEqual(hub.sent.filter((s) => s.msg.type === 'create_reminder').map((s) => s.msg.id), [orphanPending.id]);
});

test('listSchedules orders upcoming (soonest first) before past (newest first) and honors limit', () => {
  const { scheduler, store } = setup();
  const now = Date.now();
  const soon = scheduler.setReminder('soon', now + 10_000);
  const later = scheduler.setReminder('later', now + 90_000);
  const firedRow = scheduler.setReminder('already fired', now - 5);
  scheduler.sweepNow();
  const order = store.listSchedules().map((r) => r.id);
  assert.deepEqual(order, [soon.id, later.id, firedRow.id]);
  assert.deepEqual(store.listSchedules(2).map((r) => r.id), [soon.id, later.id], 'limit truncates from the tail');
});

// ——— M8 scheduled routines ———

test('M8: a recurring routine re-arms as a NEW pending row in the fire transaction (chain-of-rows)', async () => {
  const { store, scheduler, fired } = setup();
  const rec = { freq: 'daily' as const, hour: 3, minute: 0 };
  const row = scheduler.scheduleRoutine('file expenses', Date.now() - 1000, rec);
  scheduler.sweepNow();
  await drainMicrotasks();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].kind, 'routine');

  const rows = store.listSchedules().filter((r) => r.kind === 'routine');
  assert.equal(rows.length, 2, 'fired occurrence + the fresh pending one');
  const pending = rows.find((r) => r.status === 'pending')!;
  assert.ok(pending, 'the chain re-armed');
  assert.notEqual(pending.id, row.id, 'each occurrence is a fresh row');
  assert.equal(pending.series_id, row.id, 'series identity is the first row\'s id');
  assert.ok(pending.fire_at > Date.now(), 'next fire is in the future');
  assert.equal(pending.recurrence, JSON.stringify(rec));

  // The fresh future row must NOT fire in the same (or an immediate) sweep.
  scheduler.sweepNow();
  await drainMicrotasks();
  assert.equal(fired.length, 1, 'the re-armed occurrence stays pending until due');
});

test('M8: a one-shot routine fires once and ends (no chain), with a routine.fired event — never reminder.fired', async () => {
  const { store, scheduler, fired, events } = setup();
  scheduler.scheduleRoutine('one off', Date.now() - 1000, null);
  scheduler.sweepNow();
  await drainMicrotasks();
  assert.equal(fired.length, 1);
  assert.ok(events.some((e) => e.type === 'routine.fired'), 'routines fire their own event type');
  assert.ok(!events.some((e) => e.type === 'reminder.fired'), 'a routine must never pulse/speak as a reminder');
  assert.equal(store.listSchedules().filter((r) => r.kind === 'routine' && r.status === 'pending').length, 0);
});

// Scan BUG (2026-07-22): a non-routine internal kind must fire its OWN event and stay out
// of the user's reminder list — never get relabeled/surfaced as a reminder.
test('a non-reminder/non-routine internal kind fires its own <kind>.fired event and is hidden from listReminders', async () => {
  const { store, scheduler, events } = setup();
  // Seed an internal "reflection" housekeeping row directly (the extensibility seam).
  store.createSchedule({
    id: 'refl01', fire_at: Date.now() - 1000, kind: 'reflection', text: 'nightly digest',
    status: 'pending', eventkit_id: null, created_at: Date.now(), recurrence: null, series_id: null,
  });
  scheduler.setReminder('call the dentist', Date.now() + 60_000); // a real user reminder

  scheduler.sweepNow();
  await drainMicrotasks();
  assert.ok(events.some((e) => e.type === 'reflection.fired'), 'the internal kind fires reflection.fired');
  assert.ok(!events.some((e) => e.type === 'reminder.fired'), 'it is NEVER mislabeled as reminder.fired');

  const listed = scheduler.listReminders();
  assert.ok(listed.every((r) => r.kind !== 'reflection'), '"what are my reminders" never lists internal housekeeping rows');
  assert.ok(listed.some((r) => r.text === 'call the dentist'), 'real reminders still show');
});

test('M8: routines are EXCLUDED from the EventKit mirror (no Reminders.app spam per occurrence)', () => {
  const { hub, scheduler } = setup();
  scheduler.scheduleRoutine('quiet routine', Date.now() + 60_000, { freq: 'daily', hour: 9, minute: 0 });
  const creates = () => hub.sent.filter((m) => (m.msg as { type?: string }).type === 'create_reminder').length;
  assert.equal(creates(), 0, 'scheduling a routine sends no EventKit create');
  scheduler.resyncEventKit();
  assert.equal(creates(), 0, 'resync must skip routine rows (every re-arm has a null twin id)');
});

test('M8: cancelling a recurring routine\'s pending row ends the whole series', async () => {
  const { store, scheduler, fired } = setup();
  const row = scheduler.scheduleRoutine('cancel me', Date.now() - 1000, { freq: 'daily', hour: 3, minute: 0 });
  scheduler.sweepNow(); // fires + re-arms
  await drainMicrotasks();
  const pending = store.listSchedules().find((r) => r.kind === 'routine' && r.status === 'pending')!;
  assert.ok(pending && pending.series_id === row.id);
  const cancelled = scheduler.cancelReminder(pending.id);
  assert.equal(cancelled?.kind, 'routine');
  // Nothing pending remains, and future sweeps fire nothing — the chain only advances at
  // fire time, so cancelling the pending occurrence IS cancelling the series.
  assert.equal(store.listSchedules().filter((r) => r.kind === 'routine' && r.status === 'pending').length, 0);
  fired.length = 0;
  scheduler.sweepNow();
  await drainMicrotasks();
  assert.equal(fired.length, 0);
});

test('M8 fix: a CORRUPT recurrence string still marks fired (at-most-once) and ends the chain loudly', async () => {
  const { store, scheduler, fired, events } = setup();
  // Write a routine row whose recurrence is not JSON (only reachable via corruption —
  // the guard is defense-in-depth; an unguarded throw here rolled back mark-fired and
  // re-fired the row every poll forever).
  store.createSchedule({
    id: 'corrupt1', fire_at: Date.now() - 1000, kind: 'routine', text: '{"procedure":"x"}',
    status: 'pending', eventkit_id: null, created_at: Date.now(), recurrence: 'not json', series_id: 'corrupt1',
  });
  assert.doesNotThrow(() => scheduler.sweepNow());
  await drainMicrotasks();
  assert.equal(fired.length, 1, 'the occurrence still fires');
  assert.equal(store.getSchedule('corrupt1')?.status, 'fired', 'mark-fired survives the bad recurrence');
  assert.ok(events.some((e) => e.type === 'session.error' && /recurrence/.test(String((e.payload as { message?: string }).message))), 'the chain-end is loud');
  fired.length = 0;
  scheduler.sweepNow();
  await drainMicrotasks();
  assert.equal(fired.length, 0, 'no re-fire loop — at-most-once holds');
});
