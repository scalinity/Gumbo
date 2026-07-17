import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
process.env.OPENAI_API_KEY ??= 'sk-test-key';
const { Orchestrator } = await import('./session.ts');
const { Store } = await import('../events/store.ts');
type EventRow = import('../events/store.ts').EventRow;
type TaskRow = import('../events/store.ts').TaskRow;

// The proactive-speech seam every reminder and image completion rides (review 🟡):
// with no live session, speakProactively must go COLD — one-shot TTS to a connected
// shell, or nothing at all when nobody would hear it. The live-inject branch needs a
// real RealtimeSession and stays covered by the smokes.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function harness(shellConnected: boolean) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-sess-')), 'gumbo.db'));
  const events: EventRow[] = [];
  store.onEvent((e) => events.push(e));
  const frames: Buffer[] = [];
  const hub = {
    broadcast: () => {},
    hasRole: (role: string) => role === 'shell' && shellConnected,
    sendBinary: (frame: Uint8Array) => frames.push(Buffer.from(frame)),
  };
  const orchestrator = new Orchestrator(store, hub as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { store, events, frames, orchestrator };
}

test('speakProactively with no shell connected spends nothing — no TTS call, no frames', async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response('should not be called', { status: 500 });
  }) as typeof fetch;
  const { frames, orchestrator } = harness(false);
  await orchestrator.speakProactively('the user, reminder: test.', 'live instructions');
  assert.equal(fetchCalls, 0, 'no synthesis when nobody would hear it');
  assert.equal(frames.length, 0);
});

test('speakProactively with a shell and no session goes cold: 0x02-headed TTS frames', async () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6]); // three pcm16 samples
  globalThis.fetch = (async () => new Response(pcm)) as typeof fetch;
  const { frames, orchestrator } = harness(true);
  await orchestrator.speakProactively('the user, reminder: test.', 'live instructions');
  assert.ok(frames.length >= 1, 'TTS audio reached the shell');
  assert.equal(frames[0][0], 0x02, 'cold speech uses the one-shot TTS header');
  assert.deepEqual([...Buffer.concat(frames.map((f) => f.subarray(1)))], [...pcm], 'payload is the synthesized pcm, sample-aligned');
});

test('a TTS failure surfaces as session.error, never a rejection', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  const { events, orchestrator } = harness(true);
  await orchestrator.speakProactively('cold', 'live'); // must resolve
  const err = events.find((e) => e.type === 'session.error');
  assert.match(String((err?.payload as { message: string })?.message), /announce tts/);
});

test('announceTaskFinished cold path: announce.pending persists even with no shell to hear it', async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response('x', { status: 500 });
  }) as typeof fetch;
  const { events, orchestrator } = harness(false);
  const task: TaskRow = {
    id: 't1', kind: 'subagent', title: 'research', status: 'done',
    workspace: '/tmp/none', created_at: 0, updated_at: 0,
  };
  await orchestrator.announceTaskFinished(task);
  const pending = events.find((e) => e.type === 'announce.pending');
  assert.ok(pending, 'the dashboard record survives a shell-less completion');
  assert.equal(pending.task_id, 't1');
  assert.equal(fetchCalls, 0);
});
