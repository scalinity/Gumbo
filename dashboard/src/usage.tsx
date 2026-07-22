// Usage view — what Gumbo's providers cost and where the tokens go. Fetched on open
// (ws.ts fetchUsage), all rollup math in rollup.ts, charts are hand-rolled SVG.
//
// Series colors: the 8 fixed categorical slots below were ordered for this dashboard and
// validated (CVD + normal-vision + contrast, dark surface #201a15) with the dataviz
// palette checks on 2026-07-21 — the ORDER is the colorblind-safety mechanism, never
// reorder or cycle it. Chart series fold to stay within the slots: every Anthropic model
// folds into one 'claude' series (equivalent value — rendered dimmed), tts/transcription/
// credit providers fold into 'other'; the breakdown table keeps full per-model detail.
import { useState, type ReactNode } from 'react';
import { useStore } from './store';
import { fetchUsage } from './ws';
import {
  CREDIT_PROVIDERS,
  bucketLabel,
  compactTokens,
  computeTiles,
  formatDay,
  formatUsd,
  heatmapDays,
  mondayOf,
  parseDay,
  rollup,
  type Bucket,
  type UsageDayRow,
} from './rollup';

const SLOT_COLORS = ['#d95926', '#199e70', '#c98500', '#3987e5', '#d55181', '#008300', '#9085e9', '#e66767'];
const FIXED_SERIES = [
  'gpt-realtime-2.1', // voice — the flagship, warm slot
  'claude', // all Anthropic models fold here (equivalent value)
  'gpt-5.6-terra', // background agents + supervisor + vision
  'grok-4.5', // background X research
  'gpt-image-2',
  'grok-4.20-non-reasoning', // hot X lookups
];
const OTHER_SERIES = 'other';
const OTHER_COLOR = '#857a6e'; // a fold, not an identity — deliberately quiet
const EQUIVALENT_SERIES = 'claude'; // billed=0 — dimmed in charts, labeled in the legend

function seriesColor(key: string): string {
  const slot = FIXED_SERIES.indexOf(key);
  return slot >= 0 ? SLOT_COLORS[slot] : OTHER_COLOR;
}

/** Color for a RAW label (per-model table rows, tile driver) — folds like the charts do,
 *  so claude-opus-4-8 wears the claude slot instead of falling through to 'other'. */
function colorForLabel(label: string): string {
  if (FIXED_SERIES.includes(label)) return seriesColor(label);
  if (label.startsWith('claude')) return seriesColor(EQUIVALENT_SERIES);
  return OTHER_COLOR;
}

/** Chart-level fold: per-model series for the big six, everything else groups. */
function chartSeries(row: UsageDayRow): string {
  if (row.provider === 'anthropic') return EQUIVALENT_SERIES;
  if (row.model && FIXED_SERIES.includes(row.model)) return row.model;
  return OTHER_SERIES;
}

/** Stable render order for stacked segments + legend: fixed slots first, other last. */
function orderedSeries(present: Set<string>): string[] {
  return [...FIXED_SERIES.filter((s) => present.has(s)), ...(present.has(OTHER_SERIES) ? [OTHER_SERIES] : [])];
}

function localToday(): string {
  return formatDay(new Date());
}

export function UsagePage() {
  const usage = useStore((s) => s.usage);
  const usageError = useStore((s) => s.usageError);
  const includeCredits = useStore((s) => s.includeCredits);
  if (usageError) {
    return (
      <div className="usage-page">
        <div className="usage-empty">
          Usage didn&apos;t load — is the daemon up?{' '}
          <button className="usage-retry" onClick={() => fetchUsage()}>retry</button>
        </div>
      </div>
    );
  }
  if (usage === null) {
    return <div className="usage-page"><div className="usage-empty">Loading usage…</div></div>;
  }
  const rows = includeCredits ? usage : usage.filter((r) => !CREDIT_PROVIDERS.has(r.provider));
  const today = localToday();
  if (rows.length === 0) {
    return (
      <div className="usage-page">
        <Controls />
        <div className="usage-empty">Nothing burned yet — usage shows up here as Gumbo works.</div>
      </div>
    );
  }
  return (
    <div className="usage-page">
      <Controls />
      <Tiles rows={rows} today={today} />
      <div className="chart-card">
        <div className="chart-title">Last 16 weeks</div>
        <Heatmap rows={rows} today={today} />
      </div>
      <div className="chart-card">
        <StackedBars rows={rows} today={today} />
      </div>
      <BreakdownTable rows={rows} />
    </div>
  );
}

function Controls() {
  const granularity = useStore((s) => s.granularity);
  const setGranularity = useStore((s) => s.setGranularity);
  const metric = useStore((s) => s.usageMetric);
  const setMetric = useStore((s) => s.setUsageMetric);
  const includeCredits = useStore((s) => s.includeCredits);
  const toggleCredits = useStore((s) => s.toggleCredits);
  return (
    <div className="usage-controls">
      <div className="usage-switch" role="group" aria-label="bucket size">
        {(['day', 'week', 'month'] as const).map((g) => (
          <button key={g} data-on={granularity === g} onClick={() => setGranularity(g)}>{g}</button>
        ))}
      </div>
      <div className="usage-switch" role="group" aria-label="metric">
        {(['cost', 'tokens'] as const).map((m) => (
          <button key={m} data-on={metric === m} onClick={() => setMetric(m)}>{m}</button>
        ))}
      </div>
      <button
        className="usage-credits"
        data-on={includeCredits}
        title="Tavily / Exa / Firecrawl estimates — free tiers"
        onClick={toggleCredits}
      >
        search credits{includeCredits ? '' : ' off'}
      </button>
    </div>
  );
}

function Tiles({ rows, today }: { rows: UsageDayRow[]; today: string }) {
  const t = computeTiles(rows, today);
  return (
    <div className="usage-tiles">
      <div className="tile">
        <div className="tile-kicker">this month</div>
        <div className="tile-value">{formatUsd(t.billedMonth)}</div>
        <div className="tile-sub">billed API spend</div>
      </div>
      <div className="tile" data-equivalent>
        <div className="tile-kicker">claude this month</div>
        <div className="tile-value">{formatUsd(t.equivalentMonth)}</div>
        <div className="tile-sub">not billed</div>
      </div>
      <div className="tile">
        <div className="tile-kicker">top driver</div>
        <div className="tile-value tile-value-text">
          <span className="series-dot" style={{ background: colorForLabel(t.topSeries ?? OTHER_SERIES) }} />
          {t.topSeries ?? '—'}
        </div>
        <div className="tile-sub">{t.topSeries ? `${Math.round(t.topShare * 100)}% of range cost` : 'no spend yet'}</div>
      </div>
      <div className="tile">
        <div className="tile-kicker">biggest day</div>
        <div className="tile-value">{t.biggestDay ? formatUsd(t.biggestDay.cost) : '—'}</div>
        <div className="tile-sub">{t.biggestDay ? bucketLabel(t.biggestDay.day, 'day') : 'quiet so far'}</div>
      </div>
    </div>
  );
}

// ── Heatmap: 16 Monday-start weeks × 7 days, ember heat by quarter-of-max ─────

const CELL = 13;
const GAP = 3;
const WEEKS = 16;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function Heatmap({ rows, today }: { rows: UsageDayRow[]; today: string }) {
  const metric = useStore((s) => s.usageMetric);
  const byDay = heatmapDays(rows, metric);
  let max = 0;
  for (const v of byDay.values()) max = Math.max(max, v);
  const todayDate = parseDay(today);
  const firstMonday = mondayOf(todayDate);
  firstMonday.setDate(firstMonday.getDate() - (WEEKS - 1) * 7);
  const left = 30;
  const top = 16;
  const width = left + WEEKS * (CELL + GAP);
  const height = top + 7 * (CELL + GAP);
  const cells: ReactNode[] = [];
  const monthLabels: ReactNode[] = [];
  let lastMonth = -1;
  for (let w = 0; w < WEEKS; w++) {
    const weekStart = new Date(firstMonday);
    weekStart.setDate(firstMonday.getDate() + w * 7);
    if (weekStart.getMonth() !== lastMonth) {
      lastMonth = weekStart.getMonth();
      monthLabels.push(
        <text key={`m${w}`} x={left + w * (CELL + GAP)} y={10} className="heatmap-label">
          {MONTHS_SHORT[lastMonth]}
        </text>,
      );
    }
    for (let d = 0; d < 7; d++) {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + d);
      if (date > todayDate) continue; // future stays blank — the grid ends at today
      const day = formatDay(date);
      const value = byDay.get(day) ?? 0;
      // Ember heat: zero is a cold pan; nonzero glows by quarter-of-max.
      const opacity = value === 0 || max === 0 ? 0 : 0.25 + 0.75 * Math.min(1, Math.ceil((value / max) * 4) / 4);
      const label = metric === 'cost' ? formatUsd(value) : `${compactTokens(value)} tokens`;
      cells.push(
        <rect
          key={day}
          x={left + w * (CELL + GAP)}
          y={top + d * (CELL + GAP)}
          width={CELL}
          height={CELL}
          className="heatmap-cell"
          style={value > 0 ? { fill: '#ff7a48', fillOpacity: opacity } : undefined}
        >
          <title>{`${bucketLabel(day, 'day')} — ${label}`}</title>
        </rect>,
      );
    }
  }
  return (
    <svg className="heatmap" width={width} height={height} role="img" aria-label="daily usage heatmap">
      {monthLabels}
      {[['Mon', 0], ['Wed', 2], ['Fri', 4]].map(([name, d]) => (
        <text key={name} x={0} y={16 + (d as number) * (CELL + GAP) + CELL - 3} className="heatmap-label">
          {name}
        </text>
      ))}
      {cells}
    </svg>
  );
}

// ── Stacked bars: one bar per bucket, one segment per series ──────────────────

const BAR_W = 800;
const BAR_H = 240;
const M = { top: 8, right: 8, bottom: 22, left: 52 };

function niceMax(n: number): number {
  if (n <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (n <= step * pow) return step * pow;
  }
  return 10 * pow;
}

function StackedBars({ rows, today }: { rows: UsageDayRow[]; today: string }) {
  const granularity = useStore((s) => s.granularity);
  const metric = useStore((s) => s.usageMetric);
  const folded = rows.map((r) => ({ ...r, model: chartSeries(r) }));
  const buckets = rollup(folded, granularity, metric, today);
  // A daily chart over 120 days is unreadable — show the recent window per granularity.
  const windowed = buckets.slice(-(granularity === 'day' ? 30 : granularity === 'week' ? 16 : 12));
  const present = new Set<string>();
  for (const b of windowed) for (const key of b.segments.keys()) present.add(key);
  const series = orderedSeries(present);
  const top = niceMax(Math.max(...windowed.map((b) => b.total), 0));
  const innerW = BAR_W - M.left - M.right;
  const innerH = BAR_H - M.top - M.bottom;
  const slot = innerW / Math.max(windowed.length, 1);
  const barW = Math.max(3, slot * 0.7);
  const y = (v: number) => M.top + innerH * (1 - v / top);
  const fmt = (v: number) => (metric === 'cost' ? formatUsd(v) : compactTokens(v));
  const labelEvery = Math.ceil(windowed.length / 8);
  // Hover card (UI-transient): index of the hovered bucket. The hit target is the FULL
  // slot column, not just the painted bar — small bars stay easy to inspect.
  const [hover, setHover] = useState<number | null>(null);
  const hovered = hover !== null ? windowed[hover] : null;
  return (
    <>
      <div className="chart-head">
        <div className="chart-title">{metric === 'cost' ? 'Spend' : 'Tokens'} by model</div>
      </div>
      <div className="bars-wrap" onMouseLeave={() => setHover(null)}>
        <svg className="stacked-bars" viewBox={`0 0 ${BAR_W} ${BAR_H}`} role="img" aria-label="usage by model over time">
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={M.left} x2={BAR_W - M.right} y1={y(top * f)} y2={y(top * f)} className="bars-grid" />
              <text x={M.left - 6} y={y(top * f) + 3} className="bars-tick" textAnchor="end">{fmt(top * f)}</text>
            </g>
          ))}
          <line x1={M.left} x2={BAR_W - M.right} y1={y(0)} y2={y(0)} className="bars-axis" />
          {windowed.map((b, i) => (
            <BarStack key={b.key} bucket={b} series={series} x={M.left + i * slot + (slot - barW) / 2} barW={barW} y={y} dimOthers={hover !== null && hover !== i} />
          ))}
          {windowed.map((b, i) =>
            i % labelEvery === 0 ? (
              <text key={b.key} x={M.left + i * slot + slot / 2} y={BAR_H - 6} className="bars-tick" textAnchor="middle">
                {b.label}
              </text>
            ) : null,
          )}
          {/* Invisible full-height hover targets, one per slot. */}
          {windowed.map((b, i) => (
            <rect
              key={`hit-${b.key}`}
              x={M.left + i * slot}
              y={M.top}
              width={slot}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {hovered && hover !== null && (
          <div
            className="bars-card"
            style={
              hover < windowed.length / 2
                ? { left: `${((M.left + (hover + 1) * slot) / BAR_W) * 100}%` }
                : { right: `${((BAR_W - M.left - hover * slot) / BAR_W) * 100}%` }
            }
          >
            <div className="bars-card-head">
              <span>{hovered.label}</span>
              <span className="bars-card-total">{fmt(hovered.total)}</span>
            </div>
            {series
              .map((s) => ({ s, v: hovered.segments.get(s) ?? 0 }))
              .filter(({ v }) => v > 0)
              .sort((a, b) => b.v - a.v)
              .map(({ s, v }) => (
                <div key={s} className="bars-card-row">
                  <span className="series-dot" style={{ background: seriesColor(s) }} />
                  <span className="bars-card-name">{s}</span>
                  <span className="bars-card-value">{fmt(v)}</span>
                </div>
              ))}
            {hovered.total === 0 && <div className="bars-card-row"><span className="bars-card-name">quiet — nothing recorded</span></div>}
          </div>
        )}
      </div>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s} className="legend-item" data-dim={s === EQUIVALENT_SERIES}>
            <span className="series-dot" style={{ background: seriesColor(s) }} />
            {s}
          </span>
        ))}
      </div>
    </>
  );
}

function BarStack({ bucket, series, x, barW, y, dimOthers }: {
  bucket: Bucket;
  series: string[];
  x: number;
  barW: number;
  y: (v: number) => number;
  dimOthers: boolean;
}) {
  let acc = 0;
  const rects: ReactNode[] = [];
  for (const s of series) {
    const v = bucket.segments.get(s) ?? 0;
    if (v <= 0) continue;
    const y1 = y(acc + v);
    const h = Math.max(1, y(acc) - y1 - 1); // the 1px trim is the segment gap
    const base = s === EQUIVALENT_SERIES ? 0.45 : 1;
    rects.push(
      <rect
        key={s}
        x={x}
        y={y1}
        width={barW}
        height={h}
        fill={seriesColor(s)}
        fillOpacity={dimOthers ? base * 0.35 : base}
      />,
    );
    acc += v;
  }
  return <>{rects}</>;
}

// ── Breakdown table: full per-model detail (no chart folding here) ────────────

interface TableRow {
  label: string;
  provider: string;
  chartKey: string;
  billed: boolean;
  estimated: boolean;
  calls: number;
  tokens: { in: number; cached: number; write: number; out: number } | null;
  cost: number;
}

function BreakdownTable({ rows }: { rows: UsageDayRow[] }) {
  const byKey = new Map<string, TableRow>();
  for (const r of rows) {
    const label = r.model ?? `${r.provider} ${r.kind}`;
    const isCredit = CREDIT_PROVIDERS.has(r.provider);
    const entry = byKey.get(label) ?? {
      label,
      provider: r.provider,
      chartKey: chartSeries(r),
      billed: r.billed === 1,
      estimated: false,
      calls: 0,
      tokens: isCredit ? null : { in: 0, cached: 0, write: 0, out: 0 },
      cost: 0,
    };
    entry.calls += r.calls;
    entry.cost += r.cost_usd;
    entry.estimated = entry.estimated || r.estimated === 1;
    if (entry.tokens) {
      entry.tokens.in += r.input_tokens;
      entry.tokens.cached += r.cached_tokens;
      entry.tokens.write += r.cache_write_tokens;
      entry.tokens.out += r.output_tokens;
    }
    byKey.set(label, entry);
  }
  const table = [...byKey.values()].sort((a, b) => b.cost - a.cost);
  const billedTotal = table.filter((r) => r.billed).reduce((s, r) => s + r.cost, 0);
  const equivalentTotal = table.filter((r) => !r.billed).reduce((s, r) => s + r.cost, 0);
  return (
    <div className="chart-card">
      <div className="chart-title">By model</div>
      <table className="usage-table">
        <thead>
          <tr>
            <th>model</th><th>calls</th><th>input</th><th>cached</th><th>cache write</th><th>output</th><th>cost</th>
          </tr>
        </thead>
        <tbody>
          {table.map((r) => (
            <tr key={r.label}>
              <td>
                <span className="series-dot" style={{ background: seriesColor(r.chartKey) }} />
                {r.label}
                {!r.billed && <span className="usage-badge" data-kind="equivalent">equivalent</span>}
                {r.estimated && <span className="usage-badge" data-kind="est">est.</span>}
              </td>
              <td>{r.calls}</td>
              <td>{r.tokens ? compactTokens(r.tokens.in) : '—'}</td>
              <td>{r.tokens ? compactTokens(r.tokens.cached) : '—'}</td>
              <td>{r.tokens ? compactTokens(r.tokens.write) : '—'}</td>
              <td>{r.tokens ? compactTokens(r.tokens.out) : '—'}</td>
              <td>{formatUsd(r.cost)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={6}>billed total</td>
            <td>{formatUsd(billedTotal)}</td>
          </tr>
          <tr data-equivalent>
            <td colSpan={6}>claude equivalent (subscription)</td>
            <td>{formatUsd(equivalentTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

