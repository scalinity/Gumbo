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

test('cancelForTask denies + dismisses every pending confirm of that task, leaves others', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new ConfirmBridge(hub, 1000);
  const p1 = bridge.request('task-a', 'Task A', 'Run: x', 'reason');
  const p2 = bridge.request('task-a', 'Task A', 'Approve plan?', 'summary');
  const p3 = bridge.request('task-b', 'Task B', 'Run: y', 'reason');
  bridge.cancelForTask('task-a');
  assert.equal(await p1, false);
  assert.equal(await p2, false);
  assert.equal(sent.filter((m) => m.type === 'confirm_cancel').length, 2, "both of task-a's panels dismissed");
  // task-b is untouched and still answerable.
  const req3 = sent.filter((m) => m.type === 'confirm_request')[2];
  bridge.handleResponse(req3!.id!, true);
  assert.equal(await p3, true);
});

test('confirm_request carries the long-form body (the full plan) when provided', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new ConfirmBridge(hub, 1000);
  const p = bridge.request('t', 'Task', 'Approve Claude’s plan?', 'peek', undefined, 1000, '# The full plan\n1. step');
  const req = sent.find((m) => m.type === 'confirm_request') as { id?: string; body?: string } | undefined;
  assert.equal(req?.body, '# The full plan\n1. step');
  bridge.handleResponse(req!.id!, false);
  assert.equal(await p, false);
});

test('per-request timeoutMs overrides the default (plan approval gets a longer window)', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new ConfirmBridge(hub, 20); // short default
  // A 40 ms override must NOT auto-deny at the 20 ms default — the request is still pending.
  const p = bridge.request('t', 'Task', 'Approve plan?', 'summary', undefined, 40);
  const req = sent.find((m) => m.type === 'confirm_request') as { id?: string; timeout_ms?: number } | undefined;
  assert.equal(req?.timeout_ms, 40, 'the shell is told the overridden window');
  await new Promise((r) => setTimeout(r, 25)); // past the default, before the override
  bridge.handleResponse(req!.id!, true);
  assert.equal(await p, true, 'answered within the overridden window, not auto-denied at the default');
});

// ——— M7: "Remember <host>" write-through on host confirms ———

test('remember_host rides the request; approve+remember fires onRemember; deny+remember does not', async () => {
  const { hub, sent } = fakeHub(true);
  const bridge = new ConfirmBridge(hub, 1000);
  const remembered: string[] = [];
  bridge.onRemember = (host) => remembered.push(host);

  const p1 = bridge.request('t', 'Task', 'Open this website?', 'x', undefined, undefined, undefined, 'github.com');
  const req1 = sent.at(-1) as { id: string; remember_host?: string };
  assert.equal(req1.remember_host, 'github.com', 'the toggle label rides the wire');
  bridge.handleResponse(req1.id, true, true);
  assert.equal(await p1, true);
  assert.deepEqual(remembered, ['github.com']);

  const p2 = bridge.request('t', 'Task', 'Open this website?', 'x', undefined, undefined, undefined, 'evil.example');
  const req2 = sent.at(-1) as { id: string };
  bridge.handleResponse(req2.id, false, true);
  assert.equal(await p2, false);
  assert.deepEqual(remembered, ['github.com'], 'remember-on-deny is meaningless and ignored');

  // A request WITHOUT remember_host cannot write anything through, even if the shell lies.
  const p3 = bridge.request('t', 'Task', 'Allow this Mac script?', 'sudo x');
  const req3 = sent.at(-1) as { id: string; remember_host?: string };
  assert.equal(req3.remember_host, undefined);
  bridge.handleResponse(req3.id, true, true);
  assert.equal(await p3, true);
  assert.deepEqual(remembered, ['github.com'], 'no rememberHost on the request → no write-through');
});
