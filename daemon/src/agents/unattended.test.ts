import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { createUnattendedWrapper } = await import('./unattended.ts');

function fakeTool(name: string, result = 'ran') {
  const invoked: string[] = [];
  const toolObj = {
    name,
    invoked,
    invoke: async (_ctx: unknown, args: string) => {
      invoked.push(args);
      return result;
    },
  };
  return toolObj;
}

function boundary(apps: string[], answer: () => boolean, confirms: string[] = []) {
  return createUnattendedWrapper(apps, async (detail) => {
    confirms.push(detail);
    return answer();
  });
}

test('in-set apps pass; out-of-set apps confirm once then admit for the run', async () => {
  const confirms: string[] = [];
  const wrap = boundary(['Mail'], () => true, confirms);
  const toolObj = wrap(fakeTool('focus_app'));
  assert.equal(await toolObj.invoke({}, JSON.stringify({ app: 'Mail' }) as never), 'ran');
  assert.equal(await toolObj.invoke({}, JSON.stringify({ app: 'mail' }) as never), 'ran', 'case-insensitive');
  assert.equal(confirms.length, 0, 'recorded apps never ask');

  assert.equal(await toolObj.invoke({}, JSON.stringify({ app: 'Safari' }) as never), 'ran');
  assert.equal(confirms.length, 1, 'out-of-set app asks');
  assert.match(confirms[0], /Safari.*outside its recorded apps/);
  assert.equal(await toolObj.invoke({}, JSON.stringify({ app: 'Safari' }) as never), 'ran');
  assert.equal(confirms.length, 1, 'approval admits the app for the rest of the run');
});

test('a denied out-of-set app returns a refusal without invoking the tool', async () => {
  const wrap = boundary(['Mail'], () => false);
  const inner = fakeTool('focus_app');
  const out = await wrap(inner).invoke({}, JSON.stringify({ app: 'Messages' }) as never);
  assert.match(String(out), /didn't approve using "Messages"/);
  assert.equal(inner.invoked.length, 0, 'a refused app never reaches the tool');
});

// Scan HIGH (2026-07-22): app:null was a free pass to read whatever is frontmost.
test('app:null refuses until the run has focused an in-set app, then rides that attestation', async () => {
  const wrap = boundary(['Notes'], () => true);
  const snapshot = wrap(fakeTool('ax_snapshot'));
  const focus = wrap(fakeTool('focus_app'));

  const before = await snapshot.invoke({}, JSON.stringify({ app: null, max_elements: 100 }) as never);
  assert.match(String(before), /name the app explicitly/i, 'no attested frontmost yet → instructive refusal');

  await focus.invoke({}, JSON.stringify({ app: 'Notes' }) as never);
  assert.equal(await snapshot.invoke({}, JSON.stringify({ app: null, max_elements: 100 }) as never), 'ran', 'the run surfaced Notes itself — frontmost reads flow');
});

test('a FAILED focus does not attest the frontmost', async () => {
  const wrap = boundary(['Notes'], () => true);
  const failedFocus = wrap(fakeTool('focus_app', 'Error (app_not_found): no such app'));
  const snapshot = wrap(fakeTool('screen_look'));
  await failedFocus.invoke({}, JSON.stringify({ app: 'Notes' }) as never);
  assert.match(String(await snapshot.invoke({}, JSON.stringify({ app: null, question: 'x' }) as never)), /name the app explicitly/i);
});

test('read_document is inside the boundary (scan HIGH: it was unwrapped)', async () => {
  const confirms: string[] = [];
  const wrap = boundary(['Mail'], () => false, confirms);
  const inner = fakeTool('read_document');
  const out = await wrap(inner).invoke({}, JSON.stringify({ app: 'Notes' }) as never);
  assert.match(String(out), /didn't approve using "Notes"/);
  assert.equal(inner.invoked.length, 0);
});

test('region captures confirm even for an in-set app (the region is a global rect)', async () => {
  const confirms: string[] = [];
  const wrap = boundary(['Notes'], () => false, confirms);
  const ocr = wrap(fakeTool('screen_ocr'));
  const out = await ocr.invoke({}, JSON.stringify({ app: 'Notes', region: { x: 0, y: 0, w: 800, h: 600 } }) as never);
  assert.match(String(out), /didn't approve a raw region capture/);
  assert.match(confirms[0], /global rectangle/);
  // Without a region the same in-set capture flows.
  assert.equal(await ocr.invoke({}, JSON.stringify({ app: 'Notes' }) as never), 'ran');
});

test('click_point confirms per use — a global click has no app to check', async () => {
  const confirms: string[] = [];
  const wrap = boundary(['Notes'], () => false, confirms);
  const inner = fakeTool('click_point');
  const out = await wrap(inner).invoke({}, JSON.stringify({ x: 100, y: 200 }) as never);
  assert.match(String(out), /didn't approve a raw screen click/);
  assert.match(confirms[0], /\(100, 200\)/);
  assert.equal(inner.invoked.length, 0);
});

test('run_script gates literal app targets and confirms non-literal ones', async () => {
  const confirms: string[] = [];
  let approve = false;
  const wrap = createUnattendedWrapper(['Notes'], async (d) => {
    confirms.push(d);
    return approve;
  });
  const script = wrap(fakeTool('run_script'));

  assert.equal(
    await script.invoke({}, JSON.stringify({ interpreter: 'osascript', script: 'tell application "Notes" to activate' }) as never),
    'ran',
    'in-set tell flows',
  );
  assert.equal(confirms.length, 0);

  const out = await script.invoke({}, JSON.stringify({ interpreter: 'osascript', script: 'tell application "Mail" to send theMessage' }) as never);
  assert.match(String(out), /didn't approve using "Mail"/);

  const variable = await script.invoke({}, JSON.stringify({ interpreter: 'osascript', script: 'set a to "Mail"\ntell application a to activate' }) as never);
  assert.match(String(variable), /didn't approve that script/, 'a non-literal tell target is unresolvable');

  const bash = await script.invoke({}, JSON.stringify({ interpreter: 'bash', script: 'open -a Safari https://x.test' }) as never);
  assert.match(String(bash), /didn't approve using "Safari"/, 'bash open -a is an app target too');

  assert.equal(await script.invoke({}, JSON.stringify({ interpreter: 'bash', script: 'date' }) as never), 'ran', 'app-less bash rides the ordinary script gate');
});

test('an in-set activate via run_script attests the frontmost for later null-app reads', async () => {
  const wrap = boundary(['Notes'], () => true);
  const script = wrap(fakeTool('run_script'));
  const snapshot = wrap(fakeTool('ax_snapshot'));
  await script.invoke({}, JSON.stringify({ interpreter: 'osascript', script: 'tell application "Notes" to activate' }) as never);
  assert.equal(await snapshot.invoke({}, JSON.stringify({ app: null }) as never), 'ran');
});

test('tools outside the boundary are returned unwrapped', async () => {
  const confirms: string[] = [];
  const wrap = boundary(['Mail'], () => false, confirms);
  const inner = fakeTool('browser_act');
  assert.equal(await wrap(inner).invoke({}, JSON.stringify({ app: 'Whatever' }) as never), 'ran');
  assert.equal(confirms.length, 0, 'ref-bound and browser tools carry their own gates');
});
