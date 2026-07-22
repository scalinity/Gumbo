import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { replayProcedure, fallbackBrief, diffOutcome } = await import('./procedure-runner.ts');
const { createMacTools } = await import('./mac-tools.ts');
const { createBrowserTools } = await import('./browser-tools.ts');
const { rememberHost } = await import('../mac/hosts.ts');
const { Store } = await import('../events/store.ts');
const { config } = await import('../config.ts');
import type { ToolObservation } from './mac-tools.ts';
import type { BrowserSurface } from './browser-tools.ts';
import type { Procedure } from './procedures.ts';
import type { MacActionResult } from '../ws/protocol.ts';

rememberHost('replay.test'); // the browser fake's host — host-gate specifics are M7's tests

// The engine is tested THROUGH the real tool invokes (the M6 "test through the tool"
// lesson): a scripted MacBridge answers per action kind, and the observation side-channel
// is wired exactly as openai-runner wires it.
function harness(opts: {
  bridge?: (action: Record<string, unknown>) => MacActionResult;
  surface?: Partial<BrowserSurface>;
  confirm?: (detail: string, title?: string) => Promise<boolean>;
  requestHandoff?: (reason: string) => Promise<boolean>;
  complete?: (instructions: string, input: string) => Promise<string>;
  notes?: string | null;
  steeringPending?: () => boolean;
} = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const bridge = {
    request: async (action: Record<string, unknown>) => {
      calls.push(action);
      return (opts.bridge ?? (() => ({ ok: true, output: 'ok' })))(action);
    },
  };
  const browserActs: Array<Record<string, unknown>> = [];
  const surface = {
    snapshot: async () => ({ ok: true, output: 'url: https://replay.test/\ntitle: Replay\n---\n- button "Send" [ref=g1e1]' }),
    act: async (input: Record<string, unknown>) => { browserActs.push(input); return { ok: true, output: '+ changed' }; },
    navigate: async (url: string) => ({ ok: true, output: `url: ${url}` }),
    back: async () => ({ ok: true, output: '' }),
    listTabs: async () => ({ ok: true, output: '' }),
    switchTab: async () => ({ ok: true, output: '' }),
    refInfo: () => ({ role: 'button', name: 'Send' }),
    findRef: () => 'g1e1',
    formMethod: async () => null,
    currentUrl: () => 'https://replay.test/page',
    screenPointForRef: async () => null,
    ...opts.surface,
  } as unknown as BrowserSurface;

  let last: ToolObservation | null = null;
  const observe = (o: ToolObservation) => { last = o; };
  const confirm = opts.confirm ?? (async () => true);
  const signal = new AbortController().signal;
  const tools = [
    ...createMacTools('rp1', bridge as never, signal, confirm, {
      visionQuery: async () => 'unused',
      requestHandoff: opts.requestHandoff,
      observe,
    }),
    ...createBrowserTools('rp1', surface, signal, confirm, undefined, observe),
  ];
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-rp-')), 'gumbo.db'));
  return {
    calls,
    browserActs,
    store,
    run: (procedure: Procedure) =>
      replayProcedure({
        taskId: 'rp1',
        procedure,
        notes: opts.notes ?? null,
        store,
        signal,
        macBridge: bridge as never,
        browser: surface,
        tools: tools as never,
        takeObservation: () => { const o = last; last = null; return o; },
        steeringPending: opts.steeringPending ?? (() => false),
        complete: opts.complete ?? (async () => 'YES'),
      }),
  };
}

const AX_PROC: Procedure = {
  name: 'file note',
  goal: 'file a note in Notes',
  preconditions: [],
  apps: ['Notes'],
  steps: [
    { lane: 'ax', desc: 'Click New Note', target: { app: 'Notes', role: 'AXButton', name: 'New Note' }, verb: 'click', verify: 'an empty note is open' },
    { lane: 'ax', desc: 'Type the body', target: { app: 'Notes', role: 'AXTextArea', name: 'Body' }, verb: 'type', value: 'packing list', verify: 'the text is present' },
  ],
};

test('happy-path AX replay: focus → snapshot → resolve → act per step, zero model calls without checkpoints', async () => {
  let completes = 0;
  const h = harness({
    bridge: (a) => (a.kind === 'resolve' ? { ok: true, output: 'g1e7' } : { ok: true, output: '+ changed' }),
    complete: async () => { completes += 1; return 'YES'; },
  });
  const result = await h.run(AX_PROC);
  assert.equal(result.outcome, 'completed');
  assert.match((result as { report: string }).report, /2 steps completed/);
  const kinds = h.calls.map((c) => c.kind);
  assert.deepEqual(kinds[0], 'activate', 'the target app is focused first');
  assert.ok(kinds.filter((k) => k === 'resolve').length === 2, 'one resolve per step');
  const act = h.calls.find((c) => c.kind === 'act' && c.verb === 'type');
  assert.equal(act?.ref, 'g1e7', 'acts by the RESOLVED ref');
  assert.equal(act?.value, 'packing list');
  assert.equal(completes, 0, 'no LLM supervision without checkpoints — the whole point');
});

test('adaptive retry: a first resolve miss re-snapshots once, then succeeds', async () => {
  let resolves = 0;
  const h = harness({
    bridge: (a) => {
      if (a.kind === 'resolve') {
        resolves += 1;
        return resolves === 1
          ? { ok: false, output: 'no match', error_kind: 'element_not_found' }
          : { ok: true, output: 'g2e1' };
      }
      return { ok: true, output: '+ changed' };
    },
  });
  const result = await h.run({ ...AX_PROC, steps: [AX_PROC.steps[0]] });
  assert.equal(result.outcome, 'completed');
  assert.equal(resolves, 2);
  assert.equal(h.calls.filter((c) => c.kind === 'snapshot').length, 2, 'retry takes a FRESH snapshot');
});

test('cold-launch slack: a snapshot that lands before the app is AX-visible retries instead of drifting at step 0', async () => {
  let snapshots = 0;
  const h = harness({
    bridge: (a) => {
      if (a.kind === 'snapshot') {
        snapshots += 1;
        return snapshots === 1
          ? { ok: false, output: 'No running app matches "Notes".', error_kind: 'element_not_found' }
          : { ok: true, output: '[g1e1] Button "New Note"' };
      }
      if (a.kind === 'resolve') return { ok: true, output: 'g1e1' };
      return { ok: true, output: '+ changed' };
    },
  });
  const result = await h.run({ ...AX_PROC, steps: [AX_PROC.steps[0]] });
  assert.equal(result.outcome, 'completed');
  assert.ok(snapshots >= 2, 'the failed snapshot was retried within the launch budget');
});

test('an "activate" step is satisfied by ensureApp alone — app-only targets never reach resolve', async () => {
  const h = harness({
    bridge: (a) => (a.kind === 'resolve' ? { ok: true, output: 'g1e7' } : { ok: true, output: '+ changed' }),
  });
  const result = await h.run({
    ...AX_PROC,
    steps: [
      { lane: 'ax', desc: 'Open Notes', target: { app: 'Notes' }, verb: 'activate', verify: 'Notes is open' },
      ...AX_PROC.steps,
    ],
  });
  assert.equal(result.outcome, 'completed');
  assert.match((result as { report: string }).report, /3 steps completed/);
  assert.equal(h.calls.filter((c) => c.kind === 'resolve').length, 2, 'only the two element steps resolve');
});

test('menu_path: an element-targeted step resolves then acts; a targetless step drives the menu bar without resolve', async () => {
  const h = harness({
    bridge: (a) => (a.kind === 'resolve' ? { ok: true, output: 'g1e9' } : { ok: true, output: 'Chose "Font > Highlight > Pink" from the context menu.' }),
  });
  const result = await h.run({
    name: 'colorize', goal: 'highlight a word', preconditions: [], apps: ['Notes'],
    steps: [
      { lane: 'ax', desc: 'Select the word', target: { app: 'Notes', role: 'AXTextArea' }, verb: 'select_text', value: 'CODE', occurrence: 0 },
      { lane: 'ax', desc: 'Apply pink highlight', target: { app: 'Notes', role: 'AXTextArea' }, verb: 'menu_path', value: 'Font > Highlight > Pink' },
      { lane: 'ax', desc: 'Toggle highlight from the menu bar', target: { app: 'Notes' }, verb: 'menu_path', value: 'Format > Font > Highlight' },
    ],
  });
  assert.equal(result.outcome, 'completed');
  const acts = h.calls.filter((c) => c.kind === 'act' && c.verb === 'menu_path');
  assert.equal(acts.length, 2);
  assert.equal(acts[0].ref, 'g1e9', 'the element form acts by the RESOLVED ref');
  assert.equal(acts[1].ref, null, 'the menu-bar form sends no ref');
  assert.equal(acts[1].value, 'Format > Font > Highlight');
  assert.equal(h.calls.filter((c) => c.kind === 'resolve').length, 2, 'the menu-bar form never resolves');
});

test('ensure-visible: a target the app hid (closed popover/menu) is recovered by re-executing the preceding Button click', async () => {
  let fmtPresses = 0;
  const h = harness({
    bridge: (a) => {
      if (a.kind === 'resolve') {
        if (a.name === 'Format') return { ok: true, output: 'fmt' };
        // The swatch only exists while the popover is open — visible again only after the
        // revealer press re-opens it (the first press was step 1's own click; the app then
        // "closed" it before step 2 resolved).
        return fmtPresses >= 2
          ? { ok: true, output: 'pinkref' }
          : { ok: false, output: 'no element matches the recorded target in the current snapshot.', error_kind: 'element_not_found' };
      }
      if (a.kind === 'act' && a.ref === 'fmt') fmtPresses += 1;
      return { ok: true, output: '+ changed' };
    },
  });
  const result = await h.run({
    name: 'colorize', goal: 'apply a highlight color', preconditions: [], apps: ['Notes'],
    steps: [
      { lane: 'ax', desc: 'Open formatting controls', target: { app: 'Notes', role: 'Button', name: 'Format' }, verb: 'click' },
      { lane: 'ax', desc: 'Pick pink', target: { app: 'Notes', role: 'MenuItem', name: 'Pink' }, verb: 'click' },
    ],
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(fmtPresses, 2, 'the revealer Button was pressed again to re-establish the target');
  assert.ok(h.calls.some((c) => c.kind === 'act' && c.ref === 'pinkref'), 'the recovered target was acted on');
});

test('diffOutcome: identical captures pass; lost structure, missed styles, and case flips become named deltas', () => {
  const cap = (text: string, runs: string[]) =>
    `=== final document (app "Notes") ===\n${text}\n=== styled ranges (character offsets into the text above) ===\n${runs.join('\n')}`;
  const taught = cap('List\nGumbo\ntest', [
    '[0-4] "List": Title, Contains paragraphs, Expanded',
    '[5-10] "Gumbo": Body, dashed list item',
    '[11-15] "test": Body',
  ]);
  assert.deepEqual(diffOutcome(taught, taught), [], 'window-state noise never diffs');

  // An auto-capitalized word is a TEXT delta (styles wait until the text matches).
  const caseFlip = cap('List\nGumbo\nTest', ['[0-4] "List": Title', '[5-10] "Gumbo": Body, dashed list item', '[11-15] "Test": Body']);
  assert.ok(diffOutcome(taught, caseFlip).some((d) => d.includes('line 3')));

  // Same text, list structure silently lost — a named style delta.
  const flat = cap('List\nGumbo\ntest', ['[0-4] "List": Title', '[5-10] "Gumbo": Body', '[11-15] "test": Body']);
  assert.ok(diffOutcome(taught, flat).some((d) => d.includes('dashed list item')));

  // Identical styling that merely FRAGMENTS into different runs never false-positives.
  const fragmented = cap('List\nGumbo\ntest', [
    '[0-2] "Li": Title',
    '[2-4] "st": Title',
    '[5-10] "Gumbo": Body, dashed list item',
    '[11-15] "test": Body',
  ]);
  assert.deepEqual(diffOutcome(taught, fragmented), []);
});

const CAP = (text: string, runs: string[]) =>
  `=== final document (app "Notes") ===\n${text}\n=== styled ranges (character offsets into the text above) ===\n${runs.join('\n')}`;

test('acceptance verify: matching re-capture completes; divergence falls back with labeled deltas; a failed re-read is honest', async () => {
  const expectCap = CAP('Hello', ['[0-5] "Hello": Title']);
  const proc: Procedure = {
    name: 'note', goal: 'write hello', preconditions: [], apps: ['Notes'],
    steps: [{ lane: 'ax', desc: 'Type hello', target: { app: 'Notes', role: 'AXTextArea', name: 'Body' }, verb: 'type', value: 'Hello' }],
    expect: expectCap,
  };
  const mk = (doc: () => { ok: boolean; output: string; error_kind?: string }) =>
    harness({
      bridge: (a) => (a.kind === 'resolve' ? { ok: true, output: 'g1e1' }
        : a.kind === 'document_state' ? (doc() as never)
        : { ok: true, output: '+ changed' }),
    });

  let r = await mk(() => ({ ok: true, output: expectCap })).run(proc);
  assert.equal(r.outcome, 'completed');
  assert.match((r as { report: string }).report, /document verified/);

  const h2 = mk(() => ({ ok: true, output: CAP('Hallo', ['[0-5] "Hallo": Title']) }));
  r = await h2.run(proc);
  assert.equal(r.outcome, 'fallback');
  const fb = r as { atStep: number; progress: string };
  assert.equal(fb.atStep, 1, 'verification failure lands past the last step');
  assert.match(fb.progress, /DOCUMENT DIVERGENCES/);
  assert.match(fb.progress, /untrusted document TEXT/, 'quoted screen text carries the untrusted label');
  const docCall = h2.calls.find((c) => c.kind === 'document_state');
  assert.equal(docCall?.app, 'Notes', 'the re-read app comes from the capture header');

  r = await mk(() => ({ ok: false, output: 'no text document', error_kind: 'element_not_found' })).run(proc);
  assert.equal(r.outcome, 'fallback');
  assert.match((r as { reason: string }).reason, /could not be verified/);
  assert.doesNotMatch((r as { progress: string }).progress, /DIVERGENCES/, 'an unobserved divergence is never framed as one');
});

test('ensure-visible: with no preceding Button click to re-execute, an unresolvable target drifts', async () => {
  const h = harness({
    bridge: (a) => (a.kind === 'resolve'
      ? { ok: false, output: 'no element matches', error_kind: 'element_not_found' }
      : { ok: true, output: '+ changed' }),
  });
  const r = await h.run({
    name: 'x', goal: 'g', preconditions: [], apps: ['Notes'],
    steps: [{ lane: 'ax', desc: 'Pick pink', target: { app: 'Notes', role: 'MenuItem', name: 'Pink' }, verb: 'click' }],
  });
  assert.equal(r.outcome, 'fallback');
  assert.match((r as { reason: string }).reason, /target not found/);
});

test('a selectorless act step drifts instead of logging a false success', async () => {
  const h = harness({
    bridge: (a) => (a.kind === 'resolve' ? { ok: true, output: 'g1e1' } : { ok: true, output: '+ changed' }),
  });
  const r = await h.run({
    name: 'x', goal: 'g', preconditions: [], apps: ['Notes'],
    steps: [{ lane: 'ax', desc: 'Click something unrecorded', target: { app: 'Notes' }, verb: 'click' }],
  });
  assert.equal(r.outcome, 'fallback');
  assert.match((r as { reason: string }).reason, /no target selector/);
});

test('drift after the retry bails to fallback with step + reason + verified progress', async () => {
  const h = harness({
    bridge: (a) => (a.kind === 'resolve'
      ? { ok: false, output: 'ambiguous: 3 partial matches.', error_kind: 'element_not_found' }
      : { ok: true, output: '+ changed' }),
  });
  const result = await h.run(AX_PROC);
  assert.equal(result.outcome, 'fallback');
  const fb = result as { atStep: number; reason: string };
  assert.equal(fb.atStep, 0);
  assert.match(fb.reason, /target not found/);
});

test('a DECLINED gate stops the replay cleanly — never a fallback (the loop would hit the same denial)', async () => {
  // run_script with an admin-privileges script → gateScript confirm → deny.
  const h = harness({ confirm: async () => false });
  const result = await h.run({
    name: 'risky', goal: 'do a gated thing', preconditions: [], apps: [],
    steps: [{ lane: 'script', desc: 'Run the admin script', verb: 'osascript', value: 'do shell script "rm -rf ~/x" with administrator privileges' }],
  });
  assert.equal(result.outcome, 'stopped');
  assert.match((result as { report: string }).report, /stopped at step 1/);
});

test('gates RE-FIRE on replay: a submit-class browser step confirms again even though it was "fine when taught"', async () => {
  const confirms: string[] = [];
  const h = harness({
    surface: { refInfo: () => ({ role: 'button', name: 'Send message' }) },
    confirm: async (detail) => { confirms.push(detail); return true; },
  });
  const result = await h.run({
    name: 'send it', goal: 'send the message', preconditions: [], apps: [],
    steps: [{ lane: 'browser', desc: 'Click Send', target: { role: 'button', name: 'Send' }, verb: 'click' }],
  });
  assert.equal(result.outcome, 'completed');
  assert.ok(confirms.some((c) => /send/i.test(c)), 'the submit gate must confirm during replay');
  assert.equal(h.browserActs.length, 1, 'approved → the act proceeds');
});

test('checkpoint verification: NO from the verifier means fallback; YES continues', async () => {
  const proc: Procedure = {
    ...AX_PROC,
    steps: [{ ...AX_PROC.steps[0], checkpoint: true }],
  };
  const yes = harness({
    bridge: (a) => (a.kind === 'resolve' ? { ok: true, output: 'g1e1' } : { ok: true, output: '+ changed' }),
    complete: async () => 'YES',
  });
  assert.equal((await yes.run(proc)).outcome, 'completed');

  const no = harness({
    bridge: (a) => (a.kind === 'resolve' ? { ok: true, output: 'g1e1' } : { ok: true, output: '+ changed' }),
    complete: async () => 'NO — the note did not open',
  });
  const failed = await no.run(proc);
  assert.equal(failed.outcome, 'fallback');
  assert.match((failed as { reason: string }).reason, /checkpoint failed/);
});

test('parameterized steps resolve ONCE up front and substitute into the act', async () => {
  const completes: string[] = [];
  const h = harness({
    bridge: (a) => (a.kind === 'resolve' ? { ok: true, output: 'g1e1' } : { ok: true, output: '+ changed' }),
    complete: async (_i, input) => { completes.push(input); return JSON.stringify({ values: { '0': 'Expenses July' } }); },
    notes: 'this month is July',
  });
  const result = await h.run({
    name: 'monthly', goal: 'file the month', preconditions: [], apps: ['Notes'],
    steps: [{ lane: 'ax', desc: 'Type the subject (substitute the month)', target: { app: 'Notes', role: 'AXTextField', name: 'Subject' }, verb: 'type', value: 'Expenses June', param: true }],
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(completes.length, 1, 'exactly one parameter-resolution call');
  assert.match(completes[0], /this month is July/);
  const act = h.calls.find((c) => c.kind === 'act');
  assert.equal(act?.value, 'Expenses July', 'the resolved value replaces the recorded one');
});

test('queued steering bails to the full loop BEFORE acting (only wrapped tools may consume it)', async () => {
  const h = harness({ steeringPending: () => true });
  const result = await h.run(AX_PROC);
  assert.equal(result.outcome, 'fallback');
  assert.match((result as { reason: string }).reason, /steered/);
  assert.equal(h.calls.length, 0, 'nothing executes once steering is pending');
});

test('handoff steps ride the M7 machinery: done continues, declined stops', async () => {
  const done = harness({
    requestHandoff: async () => true,
    bridge: (a) => (a.kind === 'resolve' ? { ok: true, output: 'g1e1' } : { ok: true, output: '+ changed' }),
  });
  const proc: Procedure = {
    name: 'login flow', goal: 'authenticated action', preconditions: [], apps: ['Notes'],
    steps: [
      { lane: 'handoff', desc: 'the user signs in' },
      { lane: 'ax', desc: 'Click New Note', target: { app: 'Notes', role: 'AXButton', name: 'New Note' }, verb: 'click' },
    ],
  };
  assert.equal((await done.run(proc)).outcome, 'completed');

  const declined = harness({ requestHandoff: async () => false });
  const stopped = await declined.run(proc);
  assert.equal(stopped.outcome, 'stopped');
  assert.match((stopped as { report: string }).report, /handoff/i);
});

test('fallbackBrief carries the skeleton, the drift point, and the do-not-redo rule', () => {
  const brief = fallbackBrief('original brief', AX_PROC, { atStep: 1, reason: 'target not found', progress: '✓ 1. Click New Note' });
  assert.match(brief, /original brief/);
  assert.match(brief, /DRIFTED at step 2 \(target not found\)/);
  assert.match(brief, /✓ 1\. Click New Note/);
  assert.match(brief, /1\. \[ax\] Click New Note/);
  assert.match(brief, /do NOT redo the completed steps/);
});

test('replayed steps land in the tool.call/tool.result trace (self-heal must see the replayed prefix)', async () => {
  const h = harness({
    bridge: (a) => (a.kind === 'resolve' ? { ok: true, output: 'g1e7' } : { ok: true, output: '+ changed' }),
  });
  const result = await h.run(AX_PROC);
  assert.equal(result.outcome, 'completed');
  const calls = h.store.listEvents({ taskId: 'rp1' }).filter((e) => e.type === 'tool.call');
  const results = h.store.listEvents({ taskId: 'rp1' }).filter((e) => e.type === 'tool.result');
  assert.ok(calls.some((e) => (e.payload as { name?: string }).name === 'ax_act'), 'engine acts appear in the trace');
  assert.ok(calls.some((e) => (e.payload as { name?: string }).name === 'focus_app'), 'engine focus appears in the trace');
  assert.equal(calls.length, results.length, 'every call has its result');
});

test('app-launch resilience: a CLOSED target app is launched from the procedure apps and the replay stays deterministic (no fallback)', async () => {
  const original = config.procedures.appLaunchWaitMs;
  (config.procedures as { appLaunchWaitMs: number }).appLaunchWaitMs = 10; // keep the readiness poll fast
  try {
    let notesRunning = false;
    const launches: string[] = [];
    const h = harness({
      bridge: (a) => {
        if (a.kind === 'activate') {
          return notesRunning
            ? { ok: true, output: 'fronted Notes' }
            : { ok: false, output: '"Notes" is not running', error_kind: 'element_not_found' };
        }
        if (a.kind === 'script') { launches.push(String(a.script)); notesRunning = true; return { ok: true, output: 'launched' }; }
        if (a.kind === 'resolve') return { ok: true, output: 'g1e7' };
        return { ok: true, output: '+ changed' };
      },
    });
    const result = await h.run(AX_PROC); // AX_PROC.apps = ['Notes']
    assert.equal(result.outcome, 'completed', 'a closed app must self-repair, not drift a faithful replay');
    assert.ok(launches.some((s) => /tell application "Notes" to activate/.test(s)), 'the engine launched the app itself');
    // The launch is recorded in the trace (so a later self-heal keeps the precondition step).
    const scriptCalls = h.store.listEvents({ taskId: 'rp1' }).filter((e) => e.type === 'tool.call' && (e.payload as { name?: string }).name === 'run_script');
    assert.equal(scriptCalls.length, 1);
  } finally {
    (config.procedures as { appLaunchWaitMs: number }).appLaunchWaitMs = original;
  }
});

test('app-launch resilience: an app NOT in the procedure is never launched — it drifts to the intelligent loop', async () => {
  const launches: string[] = [];
  const h = harness({
    bridge: (a) => {
      if (a.kind === 'activate') return { ok: false, output: 'not running', error_kind: 'element_not_found' };
      if (a.kind === 'script') { launches.push(String(a.script)); return { ok: true, output: 'launched' }; }
      return { ok: true, output: 'x' };
    },
  });
  const proc: Procedure = {
    name: 'wrong app', goal: 'g', preconditions: [], apps: ['Mail'],
    steps: [{ lane: 'ax', desc: 'click New', target: { app: 'Notes', role: 'AXButton', name: 'New Note' }, verb: 'click' }],
  };
  const result = await h.run(proc);
  assert.equal(result.outcome, 'fallback', 'an unknown closed app degrades to the loop, never a hard failure');
  assert.match((result as { reason: string }).reason, /not one of this procedure's apps/);
  assert.equal(launches.length, 0, 'never launch an app outside the procedure set');
});

test('fallbackBrief carries the LITERAL typed values + a verbatim-reproduction instruction (no improvising)', () => {
  const proc: Procedure = {
    name: 'packing list', goal: 'a checklist-style packing list', preconditions: [], apps: ['Notes'],
    steps: [
      { lane: 'ax', desc: 'Type the first item', target: { app: 'Notes', role: 'AXTextArea', name: 'Body' }, verb: 'type', value: '- Towels' },
      { lane: 'key', desc: 'Next line', verb: 'key', value: 'return' },
      { lane: 'handoff', desc: 'the user signs in' }, // no value — redacted; must not print "undefined"
    ],
  };
  const brief = fallbackBrief('do the packing list', proc, { atStep: 0, reason: 'snapshot failed', progress: '' });
  assert.match(brief, /"- Towels"/, 'the literal item + dash format reaches the fallback loop');
  assert.match(brief, /press return/, 'a key step renders as its keypress');
  assert.match(brief, /verbatim/i, 'instructed to reproduce verbatim');
  assert.match(brief, /checklist|checkbox/i, 'warned off the app-native checklist widget');
  assert.doesNotMatch(brief, /undefined/, 'a valueless (handoff) step never prints "undefined"');
});
