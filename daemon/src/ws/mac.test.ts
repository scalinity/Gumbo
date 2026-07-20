import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { MacBridge } = await import('./mac.ts');
import type { Hub } from './hub.ts';
import type { MacAction } from './protocol.ts';

// Minimal Hub stand-in: MacBridge only uses hasRole + broadcast (same as ConfirmBridge tests).
function fakeHub(hasShell: boolean) {
  const sent: Array<{ type: string; id?: string; action?: MacAction; active?: boolean }> = [];
  const hub = {
    hasRole: (r: string) => hasShell && r === 'shell',
    broadcast: (msg: { type: string; id?: string }) => sent.push(msg as (typeof sent)[number]),
  } as unknown as Hub;
  return { hub, sent };
}

const SNAPSHOT: MacAction = { kind: 'snapshot', app: null, max_elements: 400 };

test('no shell connected → typed ax_unavailable, nothing broadcast (fail safe)', async () => {
  const { hub, sent } = fakeHub(false);
  const bridge = new MacBridge(hub, 50);
  const result = await bridge.request(SNAPSHOT);
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, 'ax_unavailable');
  assert.equal(sent.length, 0, 'no mac_action when nobody can execute it');
});

test('shell result resolves the pending request', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new MacBridge(hub, 1000);
  const p = bridge.request(SNAPSHOT);
  const req = sent.find((m) => m.type === 'mac_action');
  assert.ok(req?.id);
  assert.deepEqual(req!.action, SNAPSHOT, 'the action rides the wire verbatim');
  bridge.handleResult(req!.id!, { ok: true, output: 'win "Notes"\n[e1] button "New Note"' });
  const result = await p;
  assert.equal(result.ok, true);
  assert.match(result.output, /New Note/);
});

test('timeout → typed timeout error (a hung shell must never wedge the loop)', async () => {
  const { hub } = fakeHub(true);
  const bridge = new MacBridge(hub, 30);
  const result = await bridge.request(SNAPSHOT);
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, 'timeout');
});

test('per-request timeoutMs overrides the default (scripts carry their own budget)', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new MacBridge(hub, 20); // short default
  const p = bridge.request(SNAPSHOT, { timeoutMs: 60 });
  const req = sent.find((m) => m.type === 'mac_action');
  await new Promise((r) => setTimeout(r, 30)); // past the default, before the override
  bridge.handleResult(req!.id!, { ok: true, output: 'still here' });
  const result = await p;
  assert.equal(result.ok, true, 'answered within the overridden window, not timed out at the default');
});

test('abort resolves aborted; a late shell result is a no-op', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new MacBridge(hub, 1000);
  const ac = new AbortController();
  const p = bridge.request(SNAPSHOT, { signal: ac.signal });
  ac.abort();
  const result = await p;
  assert.equal(result.error_kind, 'aborted');
  const req = sent.find((m) => m.type === 'mac_action');
  bridge.handleResult(req!.id!, { ok: true, output: 'too late' }); // must not throw or resolve twice
});

test('a pre-aborted signal never reaches the wire', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new MacBridge(hub, 1000);
  const ac = new AbortController();
  ac.abort();
  const result = await bridge.request(SNAPSHOT, { signal: ac.signal });
  assert.equal(result.error_kind, 'aborted');
  assert.ok(!sent.some((m) => m.type === 'mac_action'), 'no action for an already-cancelled task');
});

test('malformed and hostile shell payloads are coerced to the typed contract', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new MacBridge(hub, 1000);

  const p1 = bridge.request(SNAPSHOT);
  bridge.handleResult(sent.at(-1)!.id!, 'not an object');
  const r1 = await p1;
  assert.equal(r1.ok, false);
  assert.equal(r1.error_kind, 'ax_unavailable');

  const p2 = bridge.request(SNAPSHOT);
  bridge.handleResult(sent.at(-1)!.id!, { ok: false, output: 42, error_kind: 'made_up_kind' });
  const r2 = await p2;
  assert.equal(r2.output, '', 'non-string output dropped');
  assert.equal(r2.error_kind, 'ax_unavailable', 'unknown kind coerced — a failure always carries a branchable kind');

  const p3 = bridge.request(SNAPSHOT);
  bridge.handleResult(sent.at(-1)!.id!, { ok: true, output: 'fine', health: 'stale_cache' });
  const r3 = await p3;
  assert.equal(r3.health, 'stale_cache', 'known health states pass through');
});

test('task lifecycle broadcasts are edge-triggered and refcounted', () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new MacBridge(hub, 1000);
  bridge.taskStarted(); // 0→1: arm
  bridge.taskStarted(); // 1→2: quiet
  bridge.taskFinished(); // 2→1: quiet
  bridge.taskFinished(); // 1→0: disarm
  bridge.taskFinished(); // underflow guard: quiet
  const states = sent.filter((m) => m.type === 'mac_task').map((m) => m.active);
  assert.deepEqual(states, [true, false]);
  bridge.resync(); // hello mid-idle re-broadcasts current (false) state
  assert.deepEqual(
    sent.filter((m) => m.type === 'mac_task').map((m) => m.active),
    [true, false, false],
  );
});

test('M7: capture_denied round-trips sanitize as a branchable kind', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new MacBridge(hub, 1000);
  const p = bridge.request({ kind: 'ocr', app: null, region: null });
  const req = sent.find((m) => m.type === 'mac_action');
  assert.ok(req?.id);
  bridge.handleResult(req!.id!, { ok: false, output: 'Screen Recording is not granted.', error_kind: 'capture_denied' });
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, 'capture_denied');
});
