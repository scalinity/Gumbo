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
  for (const banned of ['browser_snapshot', 'browser_act', 'browser_navigate', 'screen_ocr', 'screen_look', 'click_point', 'request_handoff', 'focus_app']) {
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

// M8: teaching rides ONE new realtime tool (start/stop/cancel are actions, not tools) and
// the raw teach/record primitives stay off the registry like the AX/browser ones.
test('M8: teach_procedure is registered; record primitives never leak to the realtime registry', () => {
  const names = buildTools().map((t) => (t as { name: string }).name);
  assert.ok(names.includes('teach_procedure'), 'teach_procedure missing from the realtime registry');
  for (const banned of ['record_start', 'record_stop', 'teach_event']) {
    assert.ok(!names.includes(banned), `${banned} is wire/subagent machinery, never a realtime tool`);
  }
});

test('M8: teach_procedure start requires a name; lifecycle calls route to the manager', async () => {
  const calls: string[] = [];
  const manager = {
    startTeaching: async (name: string) => { calls.push(`start:${name}`); return { id: 't1' }; },
    stopTeaching: async () => { calls.push('stop'); return { name: 'demo', stepCount: 3 }; },
    cancelTeaching: () => { calls.push('cancel'); return true; },
  };
  const tools = createOrchestratorTools(
    manager as never,
    {} as never,
    {
      scheduler: {} as never,
      announce: async () => {},
      imageContext: { get: () => null } as never,
      fileContext: { get: () => null } as never,
      presentFile: (() => true) as never,
      openImage: (() => true) as never,
      macBridge: {} as never,
      confirmMacDo: (async () => false) as never,
    },
  );
  const teach = tools.find((t) => (t as { name: string }).name === 'teach_procedure') as unknown as {
    invoke: (ctx: unknown, args: string) => Promise<string>;
  };

  const noName = await teach.invoke({}, JSON.stringify({ action: 'start', name: null }));
  assert.match(noName, /name is needed/i);
  assert.deepEqual(calls, [], 'no manager call without a name');

  const started = await teach.invoke({}, JSON.stringify({ action: 'start', name: 'file expenses' }));
  assert.match(started, /watching the user/i);
  const stopped = await teach.invoke({}, JSON.stringify({ action: 'stop', name: null }));
  assert.match(stopped, /3 steps/);
  const cancelled = await teach.invoke({}, JSON.stringify({ action: 'cancel', name: null }));
  assert.match(cancelled, /discarded/i);
  assert.deepEqual(calls, ['start:file expenses', 'stop', 'cancel']);
});

test('M8: teach_procedure surfaces manager refusals as spoken text (busy Mac, no recording)', async () => {
  const manager = {
    startTeaching: async () => { throw new Error('a computer-use task ("Browse") is already driving the Mac; wait for it to finish or cancel it first'); },
    stopTeaching: async () => { throw new Error('no recording is active'); },
    cancelTeaching: () => false,
  };
  const tools = createOrchestratorTools(
    manager as never,
    {} as never,
    {
      scheduler: {} as never,
      announce: async () => {},
      imageContext: { get: () => null } as never,
      fileContext: { get: () => null } as never,
      presentFile: (() => true) as never,
      openImage: (() => true) as never,
      macBridge: {} as never,
      confirmMacDo: (async () => false) as never,
    },
  );
  const teach = tools.find((t) => (t as { name: string }).name === 'teach_procedure') as unknown as {
    invoke: (ctx: unknown, args: string) => Promise<string>;
  };
  assert.match(await teach.invoke({}, JSON.stringify({ action: 'start', name: 'x' })), /already driving the Mac/);
  assert.match(await teach.invoke({}, JSON.stringify({ action: 'stop', name: null })), /no recording is active/);
  assert.match(await teach.invoke({}, JSON.stringify({ action: 'cancel', name: null })), /No recording is active/);
});

test('M8: save_last_run distills the newest finished computer task (never a teaching session)', async () => {
  const saved: Array<{ taskId: string; name: string }> = [];
  const manager = { startTeaching: async () => ({}), stopTeaching: async () => ({ name: '', stepCount: 0 }), cancelTeaching: () => false };
  const store = {
    listTasks: () => [
      { id: 'teachrow', kind: 'computer', status: 'done', title: 'Teaching: file expenses' },
      { id: 'run9', kind: 'computer', status: 'done', title: 'Check invoices' },
      { id: 'old', kind: 'computer', status: 'done', title: 'Older run' },
    ],
    getLatestEventPayload: () => null, // none of these are replay runs
  };
  const tools = createOrchestratorTools(
    manager as never,
    store as never,
    {
      scheduler: {} as never,
      announce: async () => {},
      imageContext: { get: () => null } as never,
      fileContext: { get: () => null } as never,
      presentFile: (() => true) as never,
      openImage: (() => true) as never,
      macBridge: {} as never,
      confirmMacDo: (async () => false) as never,
      procedures: {
        saveFromTask: async (taskId: string, name: string) => {
          saved.push({ taskId, name });
          return { name, version: 1, stepCount: 4 };
        },
      } as never,
    },
  );
  const teach = tools.find((t) => (t as { name: string }).name === 'teach_procedure') as unknown as {
    invoke: (ctx: unknown, args: string) => Promise<string>;
  };
  const result = await teach.invoke({}, JSON.stringify({ action: 'save_last_run', name: 'check invoices' }));
  assert.match(result, /Saved "check invoices" \(version 1, 4 steps\)/);
  assert.deepEqual(saved, [{ taskId: 'run9', name: 'check invoices' }], 'teaching rows are skipped; newest real run wins');
});

test('M8: run_procedure is registered and routes matches/misses correctly', async () => {
  const names = buildTools().map((t) => (t as { name: string }).name);
  assert.ok(names.includes('run_procedure'), 'run_procedure missing from the realtime registry');

  const spawned: Array<{ title: string; replay: unknown }> = [];
  const body = JSON.stringify({ name: 'file expenses', goal: 'file the report', preconditions: [], apps: ['Mail'], steps: [{ lane: 'ax', desc: 'x' }] });
  const manager = {
    spawnSubagent: (title: string, _brief: string, _type: string, replay: unknown) => {
      spawned.push({ title, replay });
      return { id: 'r1' };
    },
  };
  const store = {
    getProcedure: (name: string) => (name === 'file expenses' ? { name: 'file expenses', version: 2, title: 'file expenses — file the report', body } : undefined),
    searchProcedures: () => [],
    listProcedures: () => [{ name: 'file expenses' }],
  };
  const tools = createOrchestratorTools(manager as never, store as never, {
    scheduler: {} as never,
    announce: async () => {},
    imageContext: { get: () => null } as never,
    fileContext: { get: () => null } as never,
    presentFile: (() => true) as never,
    openImage: (() => true) as never,
    macBridge: {} as never,
    confirmMacDo: (async () => false) as never,
  });
  const runProc = tools.find((t) => (t as { name: string }).name === 'run_procedure') as unknown as {
    invoke: (ctx: unknown, args: string) => Promise<string>;
  };
  const hit = await runProc.invoke({}, JSON.stringify({ procedure: 'file expenses', notes: 'July', adapt: null }));
  assert.match(hit, /Running the saved procedure "file expenses"/);
  assert.equal(spawned.length, 1);
  assert.equal((spawned[0].replay as { notes: string }).notes, 'July');

  const miss = await runProc.invoke({}, JSON.stringify({ procedure: 'water the lawn', notes: null, adapt: null }));
  assert.match(miss, /No saved procedure matches/);
  assert.match(miss, /"file expenses"/, 'the miss lists what IS saved');
  assert.equal(spawned.length, 1, 'a miss never spawns');
});

test('M8: run_procedure `adapt` routes a VARIATION to template-mode, keeps faithful runs deterministic (all edges)', async () => {
  const spawned: Array<{ title: string; brief: string; type: string; replay: unknown }> = [];
  const goodBody = JSON.stringify({
    name: 'packing list', goal: 'draft a packing list in Notes', preconditions: ['Notes is open'], apps: ['Notes'],
    steps: [{ lane: 'ax', desc: 'Click New Note' }, { lane: 'ax', desc: 'Type the items' }],
  });
  const manager = {
    spawnSubagent: (title: string, brief: string, type: string, replay: unknown) => {
      spawned.push({ title, brief, type, replay });
      return { id: 'r9' };
    },
  };
  const store = {
    getProcedure: (name: string) => {
      if (name === 'packing list') return { name: 'packing list', version: 1, title: 'packing list — draft', body: goodBody };
      if (name === 'broken') return { name: 'broken', version: 1, title: 'broken', body: '{ not valid json' };
      return undefined;
    },
    searchProcedures: () => [],
    listProcedures: () => [{ name: 'packing list' }],
  };
  const tools = createOrchestratorTools(manager as never, store as never, {
    scheduler: {} as never,
    announce: async () => {},
    imageContext: { get: () => null } as never,
    fileContext: { get: () => null } as never,
    presentFile: (() => true) as never,
    openImage: (() => true) as never,
    macBridge: {} as never,
    confirmMacDo: (async () => false) as never,
  });
  const runProc = tools.find((t) => (t as { name: string }).name === 'run_procedure') as unknown as {
    invoke: (ctx: unknown, args: string) => Promise<string>;
  };

  // (1) adapt present → TEMPLATE mode: NO replay opt, "(adapted)" title, brief carries the change + the demonstrated skeleton.
  const adapted = await runProc.invoke({}, JSON.stringify({ procedure: 'packing list', notes: null, adapt: 'but for a picnic instead' }));
  assert.match(adapted, /Adapting "packing list"/);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].title, 'packing list (adapted)');
  assert.equal(spawned[0].replay, undefined, 'a template run must NOT carry the deterministic-replay opt');
  assert.match(spawned[0].brief, /for a picnic/, 'the adaptation drives WHAT');
  assert.match(spawned[0].brief, /Click New Note/, 'the demonstrated skeleton guides HOW');

  // (2) adapt whitespace-only → treated as a FAITHFUL run (deterministic replay opt present).
  const faithful = await runProc.invoke({}, JSON.stringify({ procedure: 'packing list', notes: null, adapt: '   ' }));
  assert.match(faithful, /Running the saved procedure "packing list"/);
  assert.equal(spawned.length, 2);
  assert.ok((spawned[1].replay as { procedure?: unknown })?.procedure, 'a faithful run carries the replay opt');

  // (3) adapt + notes together → the template brief folds in both.
  await runProc.invoke({}, JSON.stringify({ procedure: 'packing list', notes: 'label it Trip', adapt: 'for a picnic' }));
  assert.match(spawned[2].brief, /for a picnic/);
  assert.match(spawned[2].brief, /label it Trip/);

  // (4) corrupt body + adapt → refusal, NO spawn (validation is before the adapt branch).
  const corrupt = await runProc.invoke({}, JSON.stringify({ procedure: 'broken', notes: null, adapt: 'for a picnic' }));
  assert.match(corrupt, /corrupt or from an incompatible version/);
  assert.equal(spawned.length, 3, 'a corrupt procedure never spawns, adapted or not');

  // (5) not found + adapt → refusal, NO spawn.
  const miss = await runProc.invoke({}, JSON.stringify({ procedure: 'nope', notes: null, adapt: 'for a picnic' }));
  assert.match(miss, /No saved procedure matches/);
  assert.equal(spawned.length, 3);
});

test('M8: schedule_routine is registered; known procedures schedule, unknown ones refuse with the saved list', async () => {
  const names = buildTools().map((t) => (t as { name: string }).name);
  assert.ok(names.includes('schedule_routine'), 'schedule_routine missing from the realtime registry');

  const scheduled: Array<{ name: string; fireAt: number; rec: unknown }> = [];
  const scheduler = {
    scheduleRoutine: (name: string, fireAt: number, rec: unknown) => {
      scheduled.push({ name, fireAt, rec });
      return { id: 's1', fire_at: fireAt };
    },
  };
  const store = {
    getProcedure: (name: string) => (name === 'file expenses' ? { name: 'file expenses', version: 1, body: '{}' } : undefined),
    searchProcedures: () => [],
    listProcedures: () => [{ name: 'file expenses' }],
  };
  const tools = createOrchestratorTools({} as never, store as never, {
    scheduler: scheduler as never,
    announce: async () => {},
    imageContext: { get: () => null } as never,
    fileContext: { get: () => null } as never,
    presentFile: (() => true) as never,
    openImage: (() => true) as never,
    macBridge: {} as never,
    confirmMacDo: (async () => false) as never,
  });
  const sched = tools.find((t) => (t as { name: string }).name === 'schedule_routine') as unknown as {
    invoke: (ctx: unknown, args: string) => Promise<string>;
  };

  // Recurring: "the first Monday at 9" — fire_at computed, not passed.
  const rec = await sched.invoke({}, JSON.stringify({
    procedure: 'file expenses', fire_at: null,
    recurrence: { freq: 'monthly', hour: 9, minute: 0, weekday: 1, nth: 1, day: null },
  }));
  assert.match(rec, /Scheduled "file expenses" to run the first Monday of each month at 9:00/);
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].fireAt > Date.now());

  // Unknown procedure: refuse and list what exists — never schedule a guess.
  const miss = await sched.invoke({}, JSON.stringify({ procedure: 'mystery', fire_at: null, recurrence: { freq: 'daily', hour: 9, minute: 0, weekday: null, nth: null, day: null } }));
  assert.match(miss, /No saved procedure matches/);
  assert.equal(scheduled.length, 1);

  // Incomplete recurrence: told to fix, nothing scheduled.
  const bad = await sched.invoke({}, JSON.stringify({ procedure: 'file expenses', fire_at: null, recurrence: { freq: 'weekly', hour: 9, minute: 0, weekday: null, nth: null, day: null } }));
  assert.match(bad, /incomplete/);
  assert.equal(scheduled.length, 1);
});

test('M8 fix: run_procedure refuses a corrupt/schema-drifted body instead of feeding the engine raw JSON', async () => {
  const manager = { spawnSubagent: () => { throw new Error('must not spawn'); } };
  const store = {
    getProcedure: () => ({ name: 'broken', version: 1, title: 'broken — x', body: '{"goal":"x","steps":[{"lane":"teleport","desc":"zap"}]}' }),
    searchProcedures: () => [],
    listProcedures: () => [],
  };
  const tools = createOrchestratorTools(manager as never, store as never, {
    scheduler: {} as never,
    announce: async () => {},
    imageContext: { get: () => null } as never,
    fileContext: { get: () => null } as never,
    presentFile: (() => true) as never,
    openImage: (() => true) as never,
    macBridge: {} as never,
    confirmMacDo: (async () => false) as never,
  });
  const runProc = tools.find((t) => (t as { name: string }).name === 'run_procedure') as unknown as {
    invoke: (ctx: unknown, args: string) => Promise<string>;
  };
  const out = await runProc.invoke({}, JSON.stringify({ procedure: 'broken', notes: null, adapt: null }));
  assert.match(out, /corrupt or from an incompatible version/);
});

test('M8 fix: save_last_run skips replay/routine runs — "save that" means the ORIGINAL run', async () => {
  const saved: string[] = [];
  const manager = { startTeaching: async () => ({}), stopTeaching: async () => ({ name: '', stepCount: 0 }), cancelTeaching: () => false };
  const store = {
    listTasks: () => [
      { id: 'replay1', kind: 'computer', status: 'done', title: 'Check invoices' }, // newest — but a replay
      { id: 'orig1', kind: 'computer', status: 'done', title: 'Check invoices' },
    ],
    getLatestEventPayload: (taskId: string, type: string) =>
      taskId === 'replay1' && type === 'procedure.replay' ? { outcome: 'completed' } : null,
  };
  const tools = createOrchestratorTools(manager as never, store as never, {
    scheduler: {} as never,
    announce: async () => {},
    imageContext: { get: () => null } as never,
    fileContext: { get: () => null } as never,
    presentFile: (() => true) as never,
    openImage: (() => true) as never,
    macBridge: {} as never,
    confirmMacDo: (async () => false) as never,
    procedures: {
      saveFromTask: async (taskId: string, name: string) => { saved.push(taskId); return { name, version: 1, stepCount: 2 }; },
    } as never,
  });
  const teach = tools.find((t) => (t as { name: string }).name === 'teach_procedure') as unknown as {
    invoke: (ctx: unknown, args: string) => Promise<string>;
  };
  await teach.invoke({}, JSON.stringify({ action: 'save_last_run', name: 'check invoices' }));
  assert.deepEqual(saved, ['orig1'], 'the replay run must be skipped in favor of the original');
});
