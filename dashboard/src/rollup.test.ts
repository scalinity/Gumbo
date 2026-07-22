import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketKey,
  compactTokens,
  computeTiles,
  formatUsd,
  heatmapDays,
  mondayOf,
  parseDay,
  rollup,
  type UsageDayRow,
} from './rollup.ts';

function row(over: Partial<UsageDayRow>): UsageDayRow {
  return {
    day: '2026-07-20', provider: 'openai', model: 'gpt-realtime-2.1', kind: 'realtime_turn',
    billed: 1, estimated: 0, calls: 1, input_tokens: 0, output_tokens: 0, cached_tokens: 0,
    cache_write_tokens: 0, units: 0, cost_usd: 0, ...over,
  };
}

test('week buckets key to their Monday, across a month boundary', () => {
  // 2026-08-01 is a Saturday; its week's Monday is 2026-07-27.
  assert.equal(bucketKey('2026-08-01', 'week'), '2026-07-27');
  assert.equal(bucketKey('2026-07-27', 'week'), '2026-07-27'); // Monday keys to itself
  assert.equal(mondayOf(parseDay('2026-07-26')).getDay(), 1);
  assert.equal(bucketKey('2026-07-20', 'month'), '2026-07');
});

test('rollup zero-fills quiet buckets so the time axis stays honest', () => {
  const buckets = rollup(
    [row({ day: '2026-07-01', cost_usd: 1 }), row({ day: '2026-07-04', cost_usd: 2 })],
    'day',
    'cost',
    '2026-07-06',
  );
  assert.deepEqual(buckets.map((b) => b.key), [
    '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06',
  ]);
  assert.equal(buckets[1].total, 0);
  assert.equal(buckets[3].total, 2);
});

test('tokens metric excludes credit providers; cost metric includes them', () => {
  const rows = [
    row({ day: '2026-07-20', input_tokens: 1000, cost_usd: 0.01 }),
    row({ day: '2026-07-20', provider: 'tavily', model: null, kind: 'search', units: 1, cost_usd: 0.008, estimated: 1 }),
  ];
  const tokens = rollup(rows, 'day', 'tokens', '2026-07-20');
  assert.deepEqual([...tokens[0].segments.keys()], ['gpt-realtime-2.1']);
  const cost = rollup(rows, 'day', 'cost', '2026-07-20');
  assert.deepEqual([...cost[0].segments.keys()].sort(), ['gpt-realtime-2.1', 'tavily']);
  assert.ok(Math.abs(cost[0].total - 0.018) < 1e-9);
});

test('token volume counts uncached + cached + cache-write + output', () => {
  const buckets = rollup(
    [row({ day: '2026-07-20', input_tokens: 100, cached_tokens: 50, cache_write_tokens: 25, output_tokens: 10 })],
    'day', 'tokens', '2026-07-20',
  );
  assert.equal(buckets[0].total, 185);
});

test('tiles separate billed from equivalent and only count the current month for both', () => {
  const tiles = computeTiles(
    [
      row({ day: '2026-07-05', cost_usd: 1 }),
      row({ day: '2026-07-06', provider: 'anthropic', model: 'claude-opus-4-8', kind: 'claude_result', billed: 0, cost_usd: 5 }),
      row({ day: '2026-06-30', cost_usd: 100 }), // prior month — out of both month tiles
    ],
    '2026-07-21',
  );
  assert.equal(tiles.billedMonth, 1);
  assert.equal(tiles.equivalentMonth, 5);
  assert.equal(tiles.topSeries, 'gpt-realtime-2.1'); // 101 of 106 range cost
  assert.ok(tiles.topShare > 0.9);
  assert.deepEqual(tiles.biggestDay, { day: '2026-06-30', cost: 100 });
});

test('heatmap sums a day across rows and respects the tokens filter', () => {
  const days = heatmapDays(
    [
      row({ day: '2026-07-20', cost_usd: 0.01 }),
      row({ day: '2026-07-20', provider: 'grok', model: 'grok-4.5', kind: 'x_search', cost_usd: 0.02 }),
      row({ day: '2026-07-20', provider: 'exa', model: null, kind: 'search', cost_usd: 0.007, estimated: 1 }),
    ],
    'cost',
  );
  assert.ok(Math.abs((days.get('2026-07-20') ?? 0) - 0.037) < 1e-9);
});

test('compactTokens renders axis-friendly labels', () => {
  assert.equal(compactTokens(87), '87');
  assert.equal(compactTokens(3_120), '3.1k');
  assert.equal(compactTokens(12_400_000), '12M');
});

test('formatUsd scales precision with magnitude', () => {
  assert.equal(formatUsd(123.4), '$123');
  assert.equal(formatUsd(1.845), '$1.84');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.0076728), '$0.0077');
});
