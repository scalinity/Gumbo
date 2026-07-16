import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { createOrchestratorTools } = await import('./tools.ts');

// Firecrawl is background-only content acquisition. If any scrape/crawl/map/extract tool
// ever leaks into the realtime session config, the voice model gains a way to hit many
// pages on someone else's infrastructure straight from the hot path — this asserts on the
// actual registry, not on source text.
// Tool definitions are built eagerly; manager/store/deps are only touched inside execute
// closures, so stubs are safe here.
function buildTools() {
  return createOrchestratorTools({} as never, {} as never, { scheduler: {} as never, announce: async () => {} });
}

test('no Firecrawl tool is registered in the realtime session config', () => {
  const tools = buildTools();
  const names = tools.map((t) => (t as { name: string }).name);
  assert.ok(names.includes('web_quick_lookup'), 'sanity: the real registry loaded');
  assert.ok(names.includes('spawn_subagent'), 'sanity: the real registry loaded');
  for (const banned of ['scrape_page', 'map_site', 'crawl_site', 'extract_structured']) {
    assert.ok(!names.includes(banned), `${banned} must not be a realtime tool`);
  }
  for (const name of names) {
    assert.doesNotMatch(name, /firecrawl|scrape|crawl|extract/i, `${name} smells like a content-acquisition tool`);
  }
});

// M5: the reminder tools are registered and set_reminder guards its time contract —
// the orchestrator resolves natural phrasing, but the daemon owns "must be future".
test('M5 tools registered: generate_image + the three reminder tools', () => {
  const names = buildTools().map((t) => (t as { name: string }).name);
  for (const expected of ['generate_image', 'set_reminder', 'list_reminders', 'cancel_reminder']) {
    assert.ok(names.includes(expected), `${expected} missing from the realtime registry`);
  }
});

function toolByName(name: string) {
  const t = buildTools().find((t) => (t as { name: string }).name === name);
  assert.ok(t, `${name} not found`);
  return t as unknown as { invoke: (ctx: unknown, args: string) => Promise<string> };
}

test('set_reminder rejects a past fire_at without touching the scheduler', async () => {
  // deps.scheduler is an empty stub — a call into it would throw, so a clean refusal
  // string also proves no row was attempted.
  const result = await toolByName('set_reminder').invoke({}, JSON.stringify({ text: 'x', fire_at: '2020-01-01T09:00:00' }));
  assert.match(result, /in the past/);
});

test('set_reminder rejects unparseable date-times', async () => {
  const result = await toolByName('set_reminder').invoke({}, JSON.stringify({ text: 'x', fire_at: 'five oclock' }));
  assert.match(result, /Could not parse/);
});
