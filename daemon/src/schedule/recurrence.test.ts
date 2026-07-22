import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { computeNextFire, parseRecurrence, describeRecurrence } = await import('./recurrence.ts');

// All expectations in LOCAL time — computeNextFire is wall-clock math on the user's machine.
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('parseRecurrence: valid shapes pass, incomplete/garbage rejected', () => {
  assert.ok(parseRecurrence({ freq: 'daily', hour: 9, minute: 0 }));
  assert.ok(parseRecurrence({ freq: 'weekly', hour: 8, minute: 30, weekday: 1 }));
  assert.ok(parseRecurrence({ freq: 'monthly', hour: 9, minute: 0, weekday: 1, nth: 1 }));
  assert.ok(parseRecurrence({ freq: 'monthly', hour: 9, minute: 0, day: 5 }));
  assert.equal(parseRecurrence(null), null);
  assert.equal(parseRecurrence({ freq: 'hourly', hour: 1, minute: 0 }), null);
  assert.equal(parseRecurrence({ freq: 'daily', hour: 24, minute: 0 }), null);
  assert.equal(parseRecurrence({ freq: 'weekly', hour: 9, minute: 0 }), null, 'weekly needs a weekday');
  assert.equal(parseRecurrence({ freq: 'monthly', hour: 9, minute: 0 }), null, 'monthly needs day or weekday+nth');
  assert.equal(parseRecurrence({ freq: 'monthly', hour: 9, minute: 0, day: 31 }), null, 'day must be 1-28 (every month has them)');
});

test('daily: later today when the time is ahead, else tomorrow', () => {
  const rec = parseRecurrence({ freq: 'daily', hour: 9, minute: 0 })!;
  assert.equal(computeNextFire(rec, local(2026, 7, 20, 7, 0)), local(2026, 7, 20, 9, 0));
  assert.equal(computeNextFire(rec, local(2026, 7, 20, 9, 0)), local(2026, 7, 21, 9, 0), 'exactly-now goes to tomorrow (strictly after)');
  assert.equal(computeNextFire(rec, local(2026, 7, 20, 23, 30)), local(2026, 7, 21, 9, 0));
});

test('weekly: the next matching weekday, one week out when today has passed', () => {
  // 2026-07-20 is a Monday.
  const rec = parseRecurrence({ freq: 'weekly', hour: 8, minute: 30, weekday: 1 })!;
  assert.equal(computeNextFire(rec, local(2026, 7, 20, 7, 0)), local(2026, 7, 20, 8, 30), 'this Monday, time still ahead');
  assert.equal(computeNextFire(rec, local(2026, 7, 20, 9, 0)), local(2026, 7, 27, 8, 30), 'passed → next Monday');
  assert.equal(computeNextFire(rec, local(2026, 7, 22, 12, 0)), local(2026, 7, 27, 8, 30), 'midweek → next Monday');
});

test('monthly nth-weekday: "the first Monday at 9" — the SPEC demo case', () => {
  const rec = parseRecurrence({ freq: 'monthly', hour: 9, minute: 0, weekday: 1, nth: 1 })!;
  // First Monday of Aug 2026 is the 3rd; of Sep 2026 the 7th.
  assert.equal(computeNextFire(rec, local(2026, 7, 20, 12, 0)), local(2026, 8, 3, 9, 0));
  assert.equal(computeNextFire(rec, local(2026, 8, 3, 9, 0)), local(2026, 9, 7, 9, 0), 'firing moment itself advances a month');
  // First Monday of July 2026 is the 6th — asking BEFORE it stays inside the month.
  assert.equal(computeNextFire(rec, local(2026, 7, 1, 0, 0)), local(2026, 7, 6, 9, 0));
});

test('monthly fixed day: day 5 at 18:00 rolls into the next month once passed', () => {
  const rec = parseRecurrence({ freq: 'monthly', hour: 18, minute: 0, day: 5 })!;
  assert.equal(computeNextFire(rec, local(2026, 7, 4, 12, 0)), local(2026, 7, 5, 18, 0));
  assert.equal(computeNextFire(rec, local(2026, 7, 5, 19, 0)), local(2026, 8, 5, 18, 0));
  assert.equal(computeNextFire(rec, local(2026, 12, 31, 23, 0)), local(2027, 1, 5, 18, 0), 'year boundary');
});

test('the next fire is always strictly in the future', () => {
  for (const rec of [
    parseRecurrence({ freq: 'daily', hour: 0, minute: 0 })!,
    parseRecurrence({ freq: 'weekly', hour: 23, minute: 59, weekday: 6 })!,
    parseRecurrence({ freq: 'monthly', hour: 12, minute: 0, weekday: 0, nth: 4 })!,
  ]) {
    const now = Date.now();
    assert.ok(computeNextFire(rec, now) > now, `${describeRecurrence(rec)} produced a non-future fire`);
  }
});

test('describeRecurrence reads naturally', () => {
  assert.equal(describeRecurrence(parseRecurrence({ freq: 'monthly', hour: 9, minute: 0, weekday: 1, nth: 1 })!), 'the first Monday of each month at 9:00');
  assert.equal(describeRecurrence(parseRecurrence({ freq: 'weekly', hour: 8, minute: 30, weekday: 1 })!), 'every Monday at 8:30');
  assert.equal(describeRecurrence(parseRecurrence({ freq: 'daily', hour: 21, minute: 5 })!), 'every day at 21:05');
});
