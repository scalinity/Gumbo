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
// closures, so stubs are safe here. Tests that exercise an execute path pass real-enough
// stubs through the overrides.
function buildTools(overrides: { store?: unknown; imageContext?: unknown; macBridge?: unknown; confirmMacDo?: unknown } = {}) {
  return createOrchestratorTools(
    {} as never,
    (overrides.store ?? {}) as never,
    {
      scheduler: {} as never,
      announce: async () => {},
      imageContext: (overrides.imageContext ?? { get: () => null }) as never,
      macBridge: (overrides.macBridge ?? {}) as never,
      confirmMacDo: (overrides.confirmMacDo ?? (async () => false)) as never,
    },
  );
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
test('M5 tools registered: generate_image, edit_image + the three reminder tools', () => {
  const names = buildTools().map((t) => (t as { name: string }).name);
  for (const expected of ['generate_image', 'edit_image', 'set_reminder', 'list_reminders', 'cancel_reminder']) {
    assert.ok(names.includes(expected), `${expected} missing from the realtime registry`);
  }
});

// M6: exactly ONE new realtime tool for the whole computer-use domain (mac_do). The
// multi-step lane rides spawn_subagent's task_type, not a second tool — the SPEC caps the
// realtime registry growth at ≤2, and the AX primitives (ax_snapshot/ax_act/run_script)
// belong to the sub-agent only and must never surface to the voice model.
test('M6: mac_do is registered; the sub-agent AX primitives never leak to the realtime registry', () => {
  const names = buildTools().map((t) => (t as { name: string }).name);
  assert.ok(names.includes('mac_do'), 'mac_do missing from the realtime registry');
  for (const banned of ['ax_snapshot', 'ax_act', 'ax_query', 'run_script', 'check_permissions']) {
    assert.ok(!names.includes(banned), `${banned} is a sub-agent-only primitive and must not be a realtime tool`);
  }
});

function toolByName(name: string, overrides: { store?: unknown; imageContext?: unknown } = {}) {
  const t = buildTools(overrides).find((t) => (t as { name: string }).name === name);
  assert.ok(t, `${name} not found`);
  return t as unknown as { invoke: (ctx: unknown, args: string) => Promise<string> };
}

// M5.5: voice edits resolve their target from the shell viewer's armed context.
test('edit_image with no viewer open and no named file refuses with a next step', async () => {
  const result = await toolByName('edit_image').invoke({}, JSON.stringify({ prompt: 'make it purple', file: null }));
  assert.match(result, /No image is open/);
});

test('edit_image rejects an invalid named file without starting anything', async () => {
  const result = await toolByName('edit_image').invoke({}, JSON.stringify({ prompt: 'p', file: '../evil.png' }));
  assert.match(result, /not a valid image filename/);
});

test('edit_image: a NAMED file different from the viewer context must not inherit the brush strokes (review 🟡)', async () => {
  // The strokes belong to the image the user highlighted — applying them to a different
  // image would mask arbitrary pixels. The ack's wording is the observable contract.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  try {
    const tool = toolByName('edit_image', {
      store: { addEvent: () => ({}) },
      imageContext: { get: () => ({ file: 'swamp-1.png', strokes: [{ points: [[0.1, 0.1]], radius: 0.05 }] }) },
    });
    const ack = await tool.invoke({}, JSON.stringify({ prompt: 'brighten it', file: 'other-1.png' }));
    assert.match(ack, /Edit started in the background/);
    assert.doesNotMatch(ack, /highlighted area/, 'stale strokes must not follow a differently-named target');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('edit_image uses the armed context (file + brush strokes) when file is null', async () => {
  // The background edit will hit fetch — stub it to fail fast; the stubs below absorb
  // the failure path (announce + session.error) without touching anything real.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  try {
    const tool = toolByName('edit_image', {
      store: { addEvent: () => ({}) },
      imageContext: { get: () => ({ file: 'swamp-1.png', strokes: [{ points: [[0.1, 0.1]], radius: 0.05 }] }) },
    });
    const ack = await tool.invoke({}, JSON.stringify({ prompt: 'make the sky purple', file: null }));
    assert.match(ack, /Edit started in the background/);
    assert.match(ack, /highlighted area/, 'the ack reflects that the brush selection is being used');
    await new Promise((resolve) => setImmediate(resolve)); // let the stubbed background path settle
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('set_reminder rejects a past fire_at and hands the model a FRESH clock to re-resolve against', async () => {
  // deps.scheduler is an empty stub — a call into it would throw, so a clean refusal
  // string also proves no row was attempted.
  const result = await toolByName('set_reminder').invoke({}, JSON.stringify({ text: 'x', fire_at: '2020-01-01T09:00:00' }));
  assert.match(result, /in the past/);
  assert.match(result, /it is now/, 'the session clock goes stale — the rejection must carry the current time (review 🟡)');
});

test('set_reminder rejects non-local ISO shapes that Date.parse would read as UTC', async () => {
  for (const bad of ['five oclock', '2026-07-17', '2026-07-16T17:00:00Z', '2026-07-16T17:00:00+02:00', '2026-07-16T17:00-0700']) {
    const result = await toolByName('set_reminder').invoke({}, JSON.stringify({ text: 'x', fire_at: bad }));
    assert.match(result, /must be a LOCAL date-time/, `must reject "${bad}"`);
  }
});
