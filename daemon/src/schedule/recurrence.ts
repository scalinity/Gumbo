// M8 recurrence: a deliberately tiny DSL — daily/weekly/monthly at a local wall-clock
// time — not RRULE (an n-of-1 voice agent schedules "every first Monday at 9", not
// iCalendar). All math is LOCAL time via Date (the daemon runs on the user's machine);
// computeNextFire always returns a time strictly AFTER `after`, computed from now at
// re-arm so a slept-through occurrence never causes a catch-up storm.

export type Recurrence = {
  freq: 'daily' | 'weekly' | 'monthly';
  hour: number; // 0-23 local
  minute: number; // 0-59
  /** weekly: which day (0=Sunday … 6=Saturday); monthly with nth: the weekday. */
  weekday?: number;
  /** monthly: the nth `weekday` of the month (1=first … 4=fourth). */
  nth?: number;
  /** monthly alternative: a fixed day of month (1-28 — never a day a month can lack). */
  day?: number;
};

function int(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/** Coerce untrusted JSON into a valid Recurrence, or null. */
export function parseRecurrence(raw: unknown): Recurrence | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.freq !== 'daily' && r.freq !== 'weekly' && r.freq !== 'monthly') return null;
  const hour = int(r.hour, 0, 23);
  const minute = int(r.minute, 0, 59);
  if (hour === undefined || minute === undefined) return null;
  const rec: Recurrence = { freq: r.freq, hour, minute };
  const weekday = int(r.weekday, 0, 6);
  const nth = int(r.nth, 1, 4);
  const day = int(r.day, 1, 28);
  if (weekday !== undefined) rec.weekday = weekday;
  if (nth !== undefined) rec.nth = nth;
  if (day !== undefined) rec.day = day;
  if (rec.freq === 'weekly' && rec.weekday === undefined) return null;
  if (rec.freq === 'monthly' && rec.day === undefined && (rec.weekday === undefined || rec.nth === undefined)) return null;
  return rec;
}

/** The next occurrence strictly after `after` (epoch-ms, local wall clock). */
export function computeNextFire(rec: Recurrence, after: number): number {
  const at = (base: Date) => {
    const d = new Date(base);
    d.setHours(rec.hour, rec.minute, 0, 0);
    return d;
  };
  const start = new Date(after);
  if (rec.freq === 'daily') {
    const today = at(start);
    if (today.getTime() > after) return today.getTime();
    const tomorrow = new Date(start);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return at(tomorrow).getTime();
  }
  if (rec.freq === 'weekly') {
    for (let offset = 0; offset <= 7; offset += 1) {
      const d = new Date(start);
      d.setDate(d.getDate() + offset);
      if (d.getDay() !== rec.weekday) continue;
      const t = at(d);
      if (t.getTime() > after) return t.getTime();
    }
    // Unreachable (a week always contains the weekday), but never return the past.
    return after + 7 * 24 * 3600_000;
  }
  // monthly: fixed day, or nth-weekday.
  for (let m = 0; m <= 13; m += 1) {
    const month = new Date(start.getFullYear(), start.getMonth() + m, 1);
    let d: Date | null = null;
    if (rec.day !== undefined) {
      d = new Date(month.getFullYear(), month.getMonth(), rec.day);
    } else {
      // nth `weekday` of this month.
      const first = new Date(month.getFullYear(), month.getMonth(), 1);
      const firstMatch = 1 + ((rec.weekday! - first.getDay() + 7) % 7);
      const dayOfMonth = firstMatch + (rec.nth! - 1) * 7;
      const candidate = new Date(month.getFullYear(), month.getMonth(), dayOfMonth);
      if (candidate.getMonth() === month.getMonth()) d = candidate;
    }
    if (!d) continue;
    const t = at(d);
    if (t.getTime() > after) return t.getTime();
  }
  return after + 31 * 24 * 3600_000; // unreachable guard — never the past
}

/** Spoken-friendly description for tool results / reports. */
export function describeRecurrence(rec: Recurrence): string {
  const time = `${rec.hour}:${String(rec.minute).padStart(2, '0')}`;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (rec.freq === 'daily') return `every day at ${time}`;
  if (rec.freq === 'weekly') return `every ${days[rec.weekday ?? 0]} at ${time}`;
  if (rec.day !== undefined) return `monthly on day ${rec.day} at ${time}`;
  const ordinals = ['first', 'second', 'third', 'fourth'];
  return `the ${ordinals[(rec.nth ?? 1) - 1]} ${days[rec.weekday ?? 0]} of each month at ${time}`;
}
