import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { createMacTools } = await import('./mac-tools.ts');
import type { MacActionResult } from '../ws/protocol.ts';

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

function tools(bridge: unknown) {
  return createMacTools('t1', bridge as never, new AbortController().signal) as unknown as ToolLike[];
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

test('check_permissions reports the health state', async () => {
  const list = tools(fakeBridge(() => ({ ok: false, output: 'stale cache — relaunch', error_kind: 'ax_unavailable', health: 'stale_cache' })));
  const out = await byName(list, 'check_permissions').invoke({}, JSON.stringify({}));
  assert.match(out, /health=stale_cache/);
});
