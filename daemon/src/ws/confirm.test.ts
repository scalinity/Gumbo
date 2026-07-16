import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { ConfirmBridge } = await import('./confirm.ts');
import type { Hub } from './hub.ts';

// Minimal Hub stand-in: ConfirmBridge only uses hasRole + broadcast.
function fakeHub(hasShell: boolean) {
  const sent: Array<{ type: string; id?: string }> = [];
  const hub = {
    hasRole: (r: string) => hasShell && r === 'shell',
    broadcast: (msg: { type: string; id?: string }) => sent.push(msg),
  } as unknown as Hub;
  return { hub, sent };
}

test('deny immediately when no shell is connected (fail safe)', async () => {
  const { hub, sent } = fakeHub(false);
  const bridge = new ConfirmBridge(hub, 50);
  assert.equal(await bridge.request('t', 'Task', 'Run: x', 'reason'), false);
  assert.equal(sent.length, 0, 'no confirm_request when nobody can answer');
});

test('resolve true on the user approval', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new ConfirmBridge(hub, 1000);
  const p = bridge.request('t', 'Task', 'Run: x', 'reason');
  const req = sent.find((m) => m.type === 'confirm_request');
  assert.ok(req?.id);
  bridge.handleResponse(req!.id!, true);
  assert.equal(await p, true);
});

test('deny on timeout', async () => {
  const { hub } = fakeHub(true);
  const bridge = new ConfirmBridge(hub, 30);
  assert.equal(await bridge.request('t', 'Task', 'Run: x', 'reason'), false);
});

test('unknown and duplicate response ids are no-ops', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new ConfirmBridge(hub, 1000);
  const p = bridge.request('t', 'Task', 'Run: x', 'reason');
  const req = sent.find((m) => m.type === 'confirm_request');
  bridge.handleResponse('bogus', true); // no matching pending
  bridge.handleResponse(req!.id!, false); // the real answer
  bridge.handleResponse(req!.id!, true); // duplicate after settle
  assert.equal(await p, false);
});

test('abort dismisses the panel and denies', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new ConfirmBridge(hub, 1000);
  const ac = new AbortController();
  const p = bridge.request('t', 'Task', 'Run: x', 'reason', ac.signal);
  ac.abort();
  assert.equal(await p, false);
  assert.ok(sent.some((m) => m.type === 'confirm_cancel'), 'shell told to dismiss the panel');
});

test('a pre-aborted signal denies without prompting', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new ConfirmBridge(hub, 1000);
  const ac = new AbortController();
  ac.abort();
  assert.equal(await bridge.request('t', 'Task', 'Run: x', 'reason', ac.signal), false);
  assert.ok(!sent.some((m) => m.type === 'confirm_request'), 'no prompt for an already-cancelled task');
});
