// Pure bucket math for the usage view — no React, no fetch, testable with plain
// `node --test dashboard/src/rollup.test.ts`. The daemon serves per-day aggregates
// (/api/usage); everything week/month/tile/heatmap-shaped derives here on the client.

export interface UsageDayRow {
  day: string; // 'YYYY-MM-DD' (local, stamped by the daemon at write)
  provider: string;
  model: string | null;
  kind: string;
  billed: 0 | 1;
  estimated: 0 | 1;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  units: number;
  cost_usd: number;
}

export type Granularity = 'day' | 'week' | 'month';
export type Metric = 'cost' | 'tokens';

/** Request/credit-billed providers — no tokens, and the user rides their free tiers, so
 *  their estimated $ stays out of totals unless the credits toggle is on. */
export const CREDIT_PROVIDERS = new Set(['tavily', 'exa', 'firecrawl']);

/** Chart series identity: the model when there is one, else the provider. */
export function seriesKey(row: UsageDayRow): string {
  return row.model ?? row.provider;
}

/** Total token volume a row represents (uncached + cached + cache-write + output). */
export function rowTokens(row: UsageDayRow): number {
  return row.input_tokens + row.cached_tokens + row.cache_write_tokens + row.output_tokens;
}

function metricValue(row: UsageDayRow, metric: Metric): number {
  return metric === 'cost' ? row.cost_usd : rowTokens(row);
}

/** 'YYYY-MM-DD' → local Date. (new Date('YYYY-MM-DD') parses UTC — off-by-one trap.) */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The Monday of a day's week — one convention shared by the bars and the heatmap. */
export function mondayOf(date: Date): Date {
  const monday = new Date(date);
  monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return monday;
}

export function bucketKey(day: string, granularity: Granularity): string {
  if (granularity === 'day') return day;
  if (granularity === 'month') return day.slice(0, 7); // 'YYYY-MM'
  return formatDay(mondayOf(parseDay(day)));
}

function nextBucketKey(key: string, granularity: Granularity): string {
  if (granularity === 'month') {
    const [y, m] = key.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  const d = parseDay(key);
  d.setDate(d.getDate() + (granularity === 'week' ? 7 : 1));
  return formatDay(d);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function bucketLabel(key: string, granularity: Granularity): string {
  if (granularity === 'month') {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  const d = parseDay(key);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export interface Bucket {
  key: string;
  label: string;
  total: number;
  segments: Map<string, number>; // seriesKey → metric value
}

/**
 * Ordered, ZERO-FILLED buckets from the first row's bucket through `today` — an honest
 * time axis (a quiet week shows as a gap, not a splice). Tokens metric drops credit
 * providers entirely (they have no tokens; their bars would be lies).
 */
export function rollup(rows: UsageDayRow[], granularity: Granularity, metric: Metric, today: string): Bucket[] {
  const usable = metric === 'tokens' ? rows.filter((r) => !CREDIT_PROVIDERS.has(r.provider)) : rows;
  if (usable.length === 0) return [];
  const byBucket = new Map<string, Map<string, number>>();
  let firstKey: string | null = null;
  for (const row of usable) {
    const key = bucketKey(row.day, granularity);
    if (firstKey === null || key < firstKey) firstKey = key;
    const segments = byBucket.get(key) ?? new Map<string, number>();
    const series = seriesKey(row);
    segments.set(series, (segments.get(series) ?? 0) + metricValue(row, metric));
    byBucket.set(key, segments);
  }
  const lastKey = bucketKey(today, granularity);
  const buckets: Bucket[] = [];
  for (let key = firstKey!; key <= lastKey; key = nextBucketKey(key, granularity)) {
    const segments = byBucket.get(key) ?? new Map<string, number>();
    let total = 0;
    for (const v of segments.values()) total += v;
    buckets.push({ key, label: bucketLabel(key, granularity), total, segments });
    if (buckets.length > 400) break; // malformed day strings must not loop forever
  }
  return buckets;
}

export interface Tiles {
  billedMonth: number; // real $ this calendar month (billed=1)
  equivalentMonth: number; // Claude equivalent $ this month (billed=0)
  topSeries: string | null; // biggest cost driver across the range (incl. equivalent)
  topShare: number; // its share of range cost, 0..1
  biggestDay: { day: string; cost: number } | null;
}

export function computeTiles(rows: UsageDayRow[], today: string): Tiles {
  const month = today.slice(0, 7);
  let billedMonth = 0;
  let equivalentMonth = 0;
  const bySeries = new Map<string, number>();
  const byDay = new Map<string, number>();
  let rangeCost = 0;
  for (const row of rows) {
    if (row.day.slice(0, 7) === month) {
      if (row.billed === 1) billedMonth += row.cost_usd;
      else equivalentMonth += row.cost_usd;
    }
    rangeCost += row.cost_usd;
    bySeries.set(seriesKey(row), (bySeries.get(seriesKey(row)) ?? 0) + row.cost_usd);
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.cost_usd);
  }
  let topSeries: string | null = null;
  let topCost = 0;
  for (const [series, cost] of bySeries) {
    if (cost > topCost) {
      topSeries = series;
      topCost = cost;
    }
  }
  let biggestDay: Tiles['biggestDay'] = null;
  for (const [day, cost] of byDay) {
    if (!biggestDay || cost > biggestDay.cost) biggestDay = { day, cost };
  }
  return {
    billedMonth,
    equivalentMonth,
    topSeries,
    topShare: rangeCost > 0 ? topCost / rangeCost : 0,
    biggestDay,
  };
}

/** day → metric value, for the heatmap. */
export function heatmapDays(rows: UsageDayRow[], metric: Metric): Map<string, number> {
  const usable = metric === 'tokens' ? rows.filter((r) => !CREDIT_PROVIDERS.has(r.provider)) : rows;
  const byDay = new Map<string, number>();
  for (const row of usable) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + metricValue(row, metric));
  }
  return byDay;
}

/** '12.4M' / '312k' / '87' — compact token counts for axis labels. */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** '$1.84' at normal sizes, sub-cent shows tenths of a cent. */
export function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 0.01 || n === 0) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}
