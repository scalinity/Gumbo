import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.GUMBO_HOME = mkdtempSync(join(tmpdir(), 'gumbo-delegation-'));
const { Orchestrator } = await import('./session.ts');
const { Store } = await import('../events/store.ts');

function reply(text: string): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

test('typed input uses Claude with microphone off, retains history and never opens Live', async () => {
  const store = new Store(':memory:'); const requests: any[] = [];
  const hub = { hasRole: () => false, broadcast() {}, sendBinary() { assert.fail('No voice connection'); } };
  const o = new Orchestrator(store, hub as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const original = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    assert.equal(new URL(String(url)).hostname, 'api.anthropic.com');
    requests.push(JSON.parse(String(init?.body)));
    return reply('Four.');
  }) as typeof fetch;
  try {
    await o.handleDebugText('What is two plus two?');
    await o.handleDebugText('What did I just ask?');
    assert.equal((o as any).session, null);
    assert.equal(requests[0].model, 'claude-opus-5-5');
    assert.ok(requests[0].tools.some((t: any) => t.name === 'mac_do'));
    assert.ok(requests[0].tools.some((t: any) => t.name === 'spawn_claude_session'));
    assert.equal(requests[0].system, requests[1].system, 'thinking context remains append-only');
    assert.match(JSON.stringify(requests[1].messages), /two plus two/);
    assert.equal(store.recentTranscripts(0).length, 4);
  } finally { globalThis.fetch = original; o.shutdown(); }
});

test('client delegation uses the accumulated request, deduplicates IDs and ignores old connections', async () => {
  const o = new Orchestrator(new Store(':memory:'), { hasRole: () => false, broadcast() {} } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const state = o as any; const calls: unknown[][] = [];
  const session = { close() {} }; state.session = session;
  state.runBackend = async (...args: unknown[]) => calls.push(args);
  const delta = (text: string) => state.handleLiveEvent(session, { type: 'session.input_transcript.delta', delta: text });
  delta('Find the ');
  const event = { type: 'session.delegation.created', delegation: { id: 'delegation_test', target: 'client' } };
  state.handleLiveEvent(session, event); state.handleLiveEvent(session, event);
  delta('active task.');
  await new Promise(r => setTimeout(r, 450));
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'Find the active task.'); assert.equal(calls[0][1], 'delegation_test');
  state.handleLiveEvent(session, { ...event, delegation: { id: 'late', target: 'client' } });
  o.handleShellDisconnected();
  await new Promise(r => setTimeout(r, 450));
  assert.equal(calls.length, 1);
});

test('a transcribed turn without a Live reply falls back once and adopts a late delegation ID', { timeout: 2000 }, async () => {
  const store = new Store(':memory:');
  const o = new Orchestrator(store, { hasRole: () => false, broadcast() {} } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const state = o as any; const commentary: unknown[][] = [];
  const session = { close() {}, append: async (...args: unknown[]) => { commentary.push(args); } };
  state.session = session; state.responding = true; state.inputGeneration = 1;
  let deliver!: (response: Response) => void; let arrived!: () => void;
  const requestArrived = new Promise<void>(resolve => { arrived = resolve; });
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = (() => { requests++; arrived(); return new Promise<Response>(resolve => { deliver = resolve; }); }) as typeof fetch;
  try {
    for (const delta of ['Tell me ', 'a five sentence ', 'story.']) {
      state.handleLiveEvent(session, { type: 'session.input_transcript.delta', delta });
    }
    assert.equal(store.recentTranscripts(0).length, 0, 'word deltas must not become separate feed rows');
    state.lastInputAt = Date.now() - 1000;
    state.scheduleMissingResponse(1);
    await requestArrived;
    assert.equal(store.recentTranscripts(0)[0].text, 'Tell me a five sentence story.');
    state.handleLiveEvent(session, { type: 'session.delegation.created', delegation: { id: 'late_id', target: 'client' } });
    deliver(reply('A short story.'));
    while (state.backendAbort) await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1);
    assert.deepEqual(commentary, [['commentary', 'A short story.', 'late_id']]);
    assert.equal(store.listEvents({ limit: 20 }).filter(e => e.type === 'voice.backend_fallback').length, 1);
  } finally { globalThis.fetch = original; o.shutdown(); }
});

test('a Live answer or newer input prevents a stale missing-response fallback', async () => {
  const o = new Orchestrator(new Store(':memory:'), { hasRole: () => false, broadcast() {} } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const state = o as any; const session = { close() {} }; state.session = session;
  state.responding = true; state.inputText = 'Hello'; state.lastInputAt = 0;
  state.runBackend = async () => assert.fail('A completed or superseded turn must not run again');
  state.scheduleMissingResponse(1);
  state.handleLiveEvent(session, { type: 'session.output_transcript.delta', delta: 'Hello.' });
  await new Promise(resolve => setTimeout(resolve,5));
  state.responding = true; state.scheduleMissingResponse(1); state.inputGeneration++;
  await new Promise(resolve => setTimeout(resolve,5));
  o.shutdown();
});

test('an acknowledgment alone does not disable missing-response recovery', async () => {
  const store = new Store(':memory:');
  const o = new Orchestrator(store, { hasRole: () => false, broadcast() {} } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const state = o as any; const session = { close() {} }; state.session = session;
  state.responding = true; state.inputText = 'Tell me a story'; state.lastInputAt = 0;
  let requests = 0; state.runBackend = async () => { requests++; };
  state.scheduleMissingResponse(1);
  state.handleLiveEvent(session, { type: 'session.output_transcript.delta', delta: 'Sure...' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(requests, 1);
  o.shutdown();
});
