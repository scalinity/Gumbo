import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.GUMBO_HOME = mkdtempSync(join(tmpdir(), 'gumbo-lifecycle-'));
const { Orchestrator } = await import('./session.ts');
const { LiveSession } = await import('./live.ts');
const { Store } = await import('../events/store.ts');

function harness() {
  const store = new Store(':memory:');
  const messages: Array<{ type: string; state?: string }> = [];
  const hub = { broadcast: (m: typeof messages[number]) => messages.push(m), hasRole: () => true, sendBinary: () => {} };
  const orchestrator = new Orchestrator(store, hub as never, { hasActiveTasks: () => false } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never);
  return { store, messages, orchestrator };
}

test('shell loss cancels an armed turn, queued mic, playback and pending announcements', () => {
  const { orchestrator, messages } = harness();
  let closed = 0;
  Object.assign(orchestrator, {
    armed: true, responding: true, shellDraining: true, state: 'speaking',
    pendingMic: [Buffer.alloc(960)], pendingRelease: 960, pendingAnnounce: 'old',
    session: { close: () => closed++ },
  });
  orchestrator.handleShellDisconnected();
  orchestrator.handleShellDisconnected();
  const state = orchestrator as any;
  assert.equal(closed, 1);
  assert.equal(state.armed, false);
  assert.equal(state.responding, false);
  assert.equal(state.shellDraining, false);
  assert.equal(state.pendingMic.length, 0);
  assert.equal(state.pendingRelease, null);
  assert.equal(state.pendingAnnounce, null);
  assert.equal(messages.at(-1)?.state, 'idle');
});

test('native audio failure records the failing stage and cancels the voice turn', () => {
  const { orchestrator, store, messages } = harness();
  orchestrator.handleAudioError('No usable output device.');
  assert.ok(messages.some(m => m.type === 'playback_flush'));
  assert.equal((store.listEvents({ limit: 10 }).find(e => e.type === 'session.error')?.payload as any)?.stage, 'native_audio');
  orchestrator.shutdown();
});

test('a connection completing after shell loss cannot reopen or emit old audio', async () => {
  const connect = LiveSession.prototype.connect;
  const close = LiveSession.prototype.close;
  let finish!: () => void;
  LiveSession.prototype.connect = async () => new Promise<void>(resolve => { finish = resolve; });
  LiveSession.prototype.close = () => {};
  const { orchestrator, store, messages } = harness();
  try {
    orchestrator.handlePttPress();
    const oldSession = (orchestrator as any).openingSession;
    assert.ok(oldSession);
    orchestrator.handleShellDisconnected();
    finish();
    await new Promise(resolve => setImmediate(resolve));
    oldSession.emit('event', { type: 'session.output_transcript.delta', delta: 'stale' });
    oldSession.emit('audio', Buffer.alloc(2));
    assert.equal((orchestrator as any).session, null);
    assert.equal((orchestrator as any).state, 'idle');
    assert.equal(messages.at(-1)?.state, 'idle');
    assert.ok(!store.listEvents({ limit: 20 }).some(e => e.type === 'session.opened'));
  } finally {
    orchestrator.shutdown();
    LiveSession.prototype.connect = connect;
    LiveSession.prototype.close = close;
  }
});
