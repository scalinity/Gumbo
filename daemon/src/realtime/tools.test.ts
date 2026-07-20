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
function buildTools(overrides: { store?: unknown; imageContext?: unknown; fileContext?: unknown; presentFile?: unknown; openImage?: unknown; macBridge?: unknown; confirmMacDo?: unknown } = {}) {
  return createOrchestratorTools(
    {} as never,
    (overrides.store ?? {}) as never,
    {
      scheduler: {} as never,
      announce: async () => {},
      imageContext: (overrides.imageContext ?? { get: () => null }) as never,
      fileContext: (overrides.fileContext ?? { get: () => null }) as never,
      presentFile: (overrides.presentFile ?? (() => true)) as never,
      openImage: (overrides.openImage ?? (() => true)) as never,
      macBridge: (overrides.macBridge ?? {}) as never,
      confirmMacDo: (overrides.confirmMacDo ?? (async () => false)) as never,
    },
  );
}

// Grok's hot-path X lookup rides the realtime session as a SIBLING to web_quick_lookup —
// routing (X/live-social vs general facts) is by description, but the tool must be present.
test('x_lookup (Grok live X) is registered alongside web_quick_lookup', () => {
  const names = buildTools().map((t) => (t as { name: string }).name);
  assert.ok(names.includes('x_lookup'), 'x_lookup missing from the realtime registry');
  assert.ok(names.includes('web_quick_lookup'), 'web_quick_lookup must stay for general facts');
});

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

// M7: the browser/vision lanes add ZERO realtime tools — spawn_subagent(task_type "mac")
// + mac_do already cover the routing (SPEC §M7 registry discipline). The browser
// primitives are sub-agent-only, exactly like the AX ones above.
test('M7: the browser/vision-lane primitives never leak to the realtime registry', () => {
  const names = buildTools().map((t) => (t as { name: string }).name);
  for (const banned of ['browser_snapshot', 'browser_act', 'browser_navigate', 'screen_ocr', 'screen_look', 'click_point']) {
    assert.ok(!names.includes(banned), `${banned} is a sub-agent-only primitive and must not be a realtime tool`);
  }
  for (const name of names) {
    assert.doesNotMatch(name, /browser|screen_|ocr/i, `${name} smells like a browser/vision-lane tool`);
  }
});

function toolByName(name: string, overrides: { store?: unknown; imageContext?: unknown; fileContext?: unknown; presentFile?: unknown; openImage?: unknown; macBridge?: unknown; confirmMacDo?: unknown } = {}) {
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

test('edit_image falls back to the LATEST created image when no viewer is open (live gap: "edit the one you just made")', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  try {
    const tool = toolByName('edit_image', {
      store: { addEvent: () => ({}) },
      imageContext: { get: () => null, latest: 'fresh-1.png' },
    });
    const ack = await tool.invoke({}, JSON.stringify({ prompt: 'add a deer on the rock', file: null }));
    assert.match(ack, /Edit started in the background/);
    assert.doesNotMatch(ack, /highlighted area/, 'the latest-fallback never inherits viewer strokes');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// open_image (2026-07-16): gallery recall by word-name — the model must never regenerate
// an image the user already has.
test('open_image: empty gallery refuses; a word query opens the match; null opens the latest', async () => {
  const { mkdirSync: mkd, writeFileSync: wf, utimesSync } = await import('node:fs');
  const { config } = await import('../config.ts');
  const dir = config.home.images;

  // Empty gallery (dir may not exist yet in this test home).
  let opened: string[] = [];
  const tool = () => toolByName('open_image', { openImage: (f: string) => { opened.push(f); return true; } });
  assert.match(await tool().invoke({}, JSON.stringify({ name: 'ember' })), /gallery is empty/i);

  mkd(dir, { recursive: true });
  wf(join(dir, 'green-ember.png'), 'x');
  wf(join(dir, 'dragon-battle.png'), 'x');
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(dir, 'green-ember.png'), past, past); // dragon is newest

  opened = [];
  assert.match(await tool().invoke({}, JSON.stringify({ name: 'ember' })), /Opened green-ember\.png/);
  assert.deepEqual(opened, ['green-ember.png']);

  opened = [];
  assert.match(await tool().invoke({}, JSON.stringify({ name: null })), /Opened dragon-battle\.png/, 'null = most recent');

  assert.match(await tool().invoke({}, JSON.stringify({ name: 'unicorn' })), /No image matches/);

  const offline = await toolByName('open_image', { openImage: () => false }).invoke({}, JSON.stringify({ name: 'ember' }));
  assert.match(offline, /shell is not connected/);
});

test('edit_image last resort: with no context at all, the newest gallery file on DISK is the target (restart-proof)', async () => {
  // The open_image test above seeded the gallery: dragon-battle.png is newest.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  try {
    const tool = toolByName('edit_image', {
      store: { addEvent: () => ({}) },
      imageContext: { get: () => null, latest: null }, // both in-memory rungs dead (daemon restarted)
    });
    const ack = await tool.invoke({}, JSON.stringify({ prompt: 'brighten it', file: null }));
    assert.match(ack, /Edit started in the background/, 'the gallery on disk survives restarts — the edit must proceed');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// present_file (2026-07-16): the deliverable-on-screen path — absolute paths only, secret
// paths refused, content pushed to the shell inline.
test('present_file guards: relative path, protected path, missing file all refuse cleanly', async () => {
  const noStore = { addEvent: () => ({}) };
  const tool = (presented: unknown[] = []) =>
    toolByName('present_file', { store: noStore, presentFile: (p: unknown) => { presented.push(p); return true; } });
  assert.match(await tool().invoke({}, JSON.stringify({ path: 'relative/spec.md', title: null })), /absolute path/);
  assert.match(await tool().invoke({}, JSON.stringify({ path: '~/.claude/projects/x.jsonl', title: null })), /protected path/);
  assert.match(await tool().invoke({}, JSON.stringify({ path: '/nonexistent/definitely/missing.md', title: null })), /Could not read/);
});

test('present_file pushes a real file to the shell with title + content', async () => {
  const { writeFileSync: write } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'gumbo-present-'));
  const path = join(dir, 'spec.md');
  write(path, '# Harness Spec\n\nBody.');
  const presented: Array<{ title: string; file: string; path: string; content: string }> = [];
  const events: string[] = [];
  const result = await toolByName('present_file', {
    store: { addEvent: (_t: unknown, type: string) => events.push(type) },
    presentFile: (p: { title: string; file: string; path: string; content: string }) => { presented.push(p); return true; },
  }).invoke({}, JSON.stringify({ path, title: 'The Spec' }));
  assert.match(result, /on the user's screen/);
  assert.equal(presented.length, 1);
  assert.equal(presented[0].title, 'The Spec');
  assert.equal(presented[0].file, 'spec.md');
  assert.match(presented[0].content, /# Harness Spec/);
  assert.ok(events.includes('file.presented'), 'audited in the event log');
});

test('present_file refuses a file whose content carries a NUL byte (binary)', async () => {
  const { writeFileSync: write } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'gumbo-present-'));
  const path = join(dir, 'blob.md');
  write(path, Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69])); // "hi\0hi" — text-shaped name, binary body
  const result = await toolByName('present_file', {
    store: { addEvent: () => ({}) },
    presentFile: () => true,
  }).invoke({}, JSON.stringify({ path, title: null }));
  assert.match(result, /binary file/);
});

test('present_file refuses an oversize file via the stat cap, before reading it', async () => {
  const { writeFileSync: write } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'gumbo-present-'));
  const path = join(dir, 'huge.md');
  write(path, 'x'.repeat(300_000 * 4 + 1)); // one byte over PRESENT_FILE_MAX_CHARS * 4
  const result = await toolByName('present_file', {
    store: { addEvent: () => ({}) },
    presentFile: () => true,
  }).invoke({}, JSON.stringify({ path, title: null }));
  assert.match(result, /too large/);
});

test('present_file with no shell connected tells the model to fall back to reading aloud', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gumbo-present-'));
  const path = join(dir, 'a.md');
  const { writeFileSync: write } = await import('node:fs');
  write(path, 'x');
  const result = await toolByName('present_file', {
    store: { addEvent: () => ({}) },
    presentFile: () => false,
  }).invoke({}, JSON.stringify({ path, title: null }));
  assert.match(result, /No shell is connected/);
});

// edit_file (2026-07-16): the file viewer is editable. The tool resolves "the document
// the user is viewing" from the shell's file_context — with none open it must refuse cleanly
// (and NOT fire a background edit / model call).
test('edit_file refuses with a next step when no document is open in the viewer', async () => {
  const result = await toolByName('edit_file', { fileContext: { get: () => null } })
    .invoke({}, JSON.stringify({ prompt: 'fix fact five' }));
  assert.match(result, /No document is open/);
});

test('edit_file (+ present_file) are registered in the realtime session config', () => {
  const names = buildTools().map((t) => (t as { name: string }).name);
  assert.ok(names.includes('present_file'), 'present_file must stay registered');
  assert.ok(names.includes('edit_file'), 'edit_file missing from the realtime registry');
});

// Observability (2026-07-16): the old 5-events digest left the voice model unable to say
// what a paused/cancelled task was doing — brief, pause reason, and the pending plan are
// the contract now.
test('get_task_status surfaces the brief, the pause reason, and the pending plan', async () => {
  const store = {
    getTask: () => ({ id: 't1', kind: 'claude', title: 'Spec', status: 'needs_input', workspace: '', created_at: 0, updated_at: 0 }),
    getClaudeSession: () => ({ session_id: 's', cwd: '/x', brief: 'Write the harness spec file' }),
    getTaskBrief: () => 'Write the harness spec file',
    // get_task_status now reads the pending plan via direct SQL (getLatestEventPayload),
    // not the 200-event window — a chatty task can push the plan out of the slice.
    getLatestEventPayload: (_id: string, type: string) =>
      type === 'claude.plan' ? { plan: '# Plan\n1. investigate\n2. write the file' } : null,
    listEvents: () => [
      { seq: 1, ts: 1, task_id: 't1', type: 'task.created', payload: { title: 'Spec', brief: 'Write the harness spec file' } },
      { seq: 2, ts: 2, task_id: 't1', type: 'claude.plan', payload: { plan: '# Plan\n1. investigate\n2. write the file' } },
      { seq: 3, ts: 3, task_id: 't1', type: 'task.status', payload: { status: 'needs_input', reason: 'awaiting plan approval' } },
    ],
  };
  const result = await toolByName('get_task_status', { store }).invoke({}, JSON.stringify({ task_id: 't1' }));
  assert.match(result, /Spec — needs_input \(coding session\)/);
  assert.match(result, /Original brief: Write the harness spec file/);
  assert.match(result, /Paused because: awaiting plan approval/);
  assert.match(result, /# Plan/, 'the plan text itself is readable to the voice model');
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
