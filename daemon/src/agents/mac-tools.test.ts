import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { createMacTools } = await import('./mac-tools.ts');
const { config } = await import('../config.ts');
import type { MacActionResult } from '../ws/protocol.ts';

const auditPath = join(config.home.logs, 'mac-audit.jsonl');
function lastAudit(): Record<string, unknown> | null {
  if (!existsSync(auditPath)) return null;
  const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

type ToolLike = { name: string; invoke: (ctx: unknown, args: string) => Promise<string> };

function fakeBridge(reply: (action: Record<string, unknown>) => MacActionResult) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    request: async (action: Record<string, unknown>) => {
      calls.push(action);
      return reply(action);
    },
  };
}

function tools(bridge: unknown, confirmScript: (detail: string) => Promise<boolean> = async () => false) {
  return createMacTools('t1', bridge as never, new AbortController().signal, confirmScript) as unknown as ToolLike[];
}
function byName(list: ToolLike[], name: string) {
  const t = list.find((t) => t.name === name);
  assert.ok(t, `${name} missing`);
  return t!;
}

test('the AX toolset exposes exactly the sub-agent primitives', () => {
  const names = tools(fakeBridge(() => ({ ok: true, output: '' }))).map((t) => t.name);
  assert.deepEqual(names.sort(), ['ax_act', 'ax_query', 'ax_snapshot', 'check_permissions', 'run_script'].sort());
});

test('a failing act surfaces the typed error_kind, with the stale_ref re-snapshot hint', async () => {
  const list = tools(fakeBridge(() => ({ ok: false, output: 'ref e3 gone', error_kind: 'stale_ref' })));
  const out = await byName(list, 'ax_act').invoke({}, JSON.stringify({ verb: 'press', ref: 'e3', value: null, role: null, name: null, timeout_ms: 5000 }));
  assert.match(out, /Error \(stale_ref\)/);
  assert.match(out, /re-run ax_snapshot/);
});

test('the repetition detector short-circuits the 3rd identical act without hitting the shell', async () => {
  const bridge = fakeBridge(() => ({ ok: true, output: '(no observable change)' }));
  const act = byName(tools(bridge), 'ax_act');
  const args = JSON.stringify({ verb: 'press', ref: 'e5', value: null, role: null, name: null, timeout_ms: 5000 });
  const r1 = await act.invoke({}, args);
  const r2 = await act.invoke({}, args);
  const r3 = await act.invoke({}, args);
  assert.equal(bridge.calls.length, 2, 'the 3rd identical act never reaches the shell');
  assert.doesNotMatch(r1, /repeated/i);
  assert.doesNotMatch(r2, /repeated/i);
  assert.match(r3, /repeated .* 3 times/i);
});

test('a DIFFERENT act resets the repetition counter', async () => {
  const bridge = fakeBridge(() => ({ ok: true, output: 'ok' }));
  const act = byName(tools(bridge), 'ax_act');
  const a = JSON.stringify({ verb: 'press', ref: 'e5', value: null, role: null, name: null, timeout_ms: 5000 });
  const b = JSON.stringify({ verb: 'press', ref: 'e6', value: null, role: null, name: null, timeout_ms: 5000 });
  await act.invoke({}, a);
  await act.invoke({}, a);
  await act.invoke({}, b); // breaks the streak
  await act.invoke({}, a); // counter for `a` was reset by `b`
  assert.equal(bridge.calls.length, 4, 'nothing short-circuited once the streak broke');
});

test('run_script gates a risky osascript through the notch; a declined script never reaches the shell (review 🟡)', async () => {
  const bridge = fakeBridge(() => ({ ok: true, output: 'ran' }));
  // confirm → deny: a `do shell script "rm …"` is risky per the policy table.
  const denied = tools(bridge, async () => false);
  const out = await byName(denied, 'run_script').invoke({}, JSON.stringify({ interpreter: 'osascript', script: 'do shell script "rm -rf ~/Documents"' }));
  assert.match(out, /didn't approve/i);
  assert.equal(bridge.calls.length, 0, 'a declined risky script must not run');

  // A reversible osascript auto-runs without consulting confirm.
  let confirmConsulted = false;
  const auto = tools(fakeBridge(() => ({ ok: true, output: 'processes' })), async () => { confirmConsulted = true; return false; });
  const ran = await byName(auto, 'run_script').invoke({}, JSON.stringify({ interpreter: 'osascript', script: 'tell application "System Events" to get name of every process' }));
  assert.doesNotMatch(ran, /didn't approve/i);
  assert.equal(confirmConsulted, false, 'a reversible script must not consult the notch');
});

test('the stall detector fires on 3 consecutive no-change acts even when the actions VARY (demo fix)', async () => {
  // no_change is the STRUCTURED flag — the detector must key on it, not on output text.
  const bridge = fakeBridge(() => ({ ok: true, output: '(no observable change — the action may not have taken effect)', no_change: true }));
  const act = byName(tools(bridge), 'ax_act');
  // Three DIFFERENT targets — dodges the exact-match repetition guard, which is the point.
  const argsFor = (ref: string) => JSON.stringify({ verb: 'press', ref, value: null, role: null, name: null, timeout_ms: 5000 });
  const r1 = await act.invoke({}, argsFor('g1e1'));
  const r2 = await act.invoke({}, argsFor('g1e2'));
  const r3 = await act.invoke({}, argsFor('g1e3'));
  assert.doesNotMatch(r1, /not making progress/i);
  assert.doesNotMatch(r2, /not making progress/i);
  assert.match(r3, /not making progress/i, 'third consecutive empty diff must warn');
  assert.equal(bridge.calls.length, 3, 'the warning rides the result — no act is blocked');
});

test('a real diff resets the stall streak', async () => {
  let empty = true;
  const bridge = fakeBridge(() => (empty ? { ok: true, output: '(no observable change — x)', no_change: true } : { ok: true, output: '+ Button "OK"' }));
  const act = byName(tools(bridge), 'ax_act');
  const argsFor = (ref: string) => JSON.stringify({ verb: 'press', ref, value: null, role: null, name: null, timeout_ms: 5000 });
  await act.invoke({}, argsFor('g1e1'));
  await act.invoke({}, argsFor('g1e2'));
  empty = false;
  await act.invoke({}, argsFor('g1e3')); // real diff — resets
  empty = true;
  const r4 = await act.invoke({}, argsFor('g1e4'));
  assert.doesNotMatch(r4, /not making progress/i, 'streak restarted after the real diff');
});

test('run_script unwraps a double-wrapped `osascript -e` body (demo fix)', async () => {
  const bridge = fakeBridge(() => ({ ok: true, output: 'ok' }));
  const list = tools(bridge, async () => false);
  await byName(list, 'run_script').invoke(
    {},
    JSON.stringify({ interpreter: 'osascript', script: `osascript -e 'tell application "Google Chrome" to activate'` }),
  );
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].script, 'tell application "Google Chrome" to activate', 'the -e body, not the CLI wrapper, reaches the shell');
});

test('output TEXT saying "no observable change" cannot spoof the stall detector (structured flag only)', async () => {
  // A web page's on-screen text could echo the phrase into a diff line — without the
  // structured no_change flag, that must NOT count toward the stall streak.
  const bridge = fakeBridge(() => ({ ok: true, output: '+ StaticText "no observable change here folks"' }));
  const act = byName(tools(bridge), 'ax_act');
  const argsFor = (ref: string) => JSON.stringify({ verb: 'press', ref, value: null, role: null, name: null, timeout_ms: 5000 });
  const r3 = [await act.invoke({}, argsFor('a')), await act.invoke({}, argsFor('b')), await act.invoke({}, argsFor('c'))].at(-1)!;
  assert.doesNotMatch(r3, /not making progress/i, 'text alone must never trip the detector');
});

test('run_script APPROVED path executes and audits gate=confirmed; declined audits gate=declined', async () => {
  const bridge = fakeBridge(() => ({ ok: true, output: 'done' }));
  const approved = tools(bridge, async () => true);
  await byName(approved, 'run_script').invoke({}, JSON.stringify({ interpreter: 'osascript', script: 'do shell script "rm -rf ~/Documents"' }));
  assert.equal(bridge.calls.length, 1, 'approved risky script reaches the shell');
  assert.equal(lastAudit()?.gate, 'confirmed');

  const denied = tools(fakeBridge(() => ({ ok: true, output: 'x' })), async () => false);
  await byName(denied, 'run_script').invoke({}, JSON.stringify({ interpreter: 'osascript', script: 'do shell script "rm -rf ~/Documents"' }));
  assert.equal(lastAudit()?.gate, 'declined', 'the refusal itself is audited');
});

test('a Shortcut confirms in the sub-agent lane (opaque action off untrusted screen text)', async () => {
  const bridge = fakeBridge(() => ({ ok: true, output: 'ran' }));
  const denied = tools(bridge, async () => false);
  const out = await byName(denied, 'run_script').invoke({}, JSON.stringify({ interpreter: 'shortcuts', script: 'Wipe Scratch Folder' }));
  assert.match(out, /didn't approve/i);
  assert.equal(bridge.calls.length, 0, 'a declined shortcut never runs');
  const allowed = tools(bridge, async () => true);
  await byName(allowed, 'run_script').invoke({}, JSON.stringify({ interpreter: 'shortcuts', script: 'Wipe Scratch Folder' }));
  assert.equal(bridge.calls.length, 1, 'an approved shortcut runs');
});

test('check_permissions reports the health state', async () => {
  const list = tools(fakeBridge(() => ({ ok: false, output: 'stale cache — relaunch', error_kind: 'ax_unavailable', health: 'stale_cache' })));
  const out = await byName(list, 'check_permissions').invoke({}, JSON.stringify({}));
  assert.match(out, /health=stale_cache/);
});
