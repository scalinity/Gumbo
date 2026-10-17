import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME = mkdtempSync(join(tmpdir(), 'gumbo-live-test-'));
const { LiveSession, liveContext } = await import('./live.ts');
const { Store } = await import('../events/store.ts');
const { initUsageRecorder } = await import('../usage/recorder.ts');

function harness() {
  const live = new LiveSession('test');
  const sent: any[] = [];
  const state = live as any;
  state.started = true; state.startedAt = Date.now();
  state.socket = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)), close() {}, terminate() {} };
  live.on('fault', () => {});
  return { live, state, sent, ack: () => state.receive({ type: 'session.input_audio.unmuted', client_event_id: sent.at(-1).event_id }) };
}

test('Live queues first words until unmute is acknowledged and streams silence while muted', async () => {
  const { live, state, sent, ack } = harness();
  live.setInput(true); live.sendAudio(Buffer.alloc(960, 1));
  await Promise.resolve();
  assert.equal(sent.at(-1).type, 'session.input_audio.unmute');
  const command = sent.at(-1);
  state.pump();
  assert.ok(Buffer.from(sent.at(-1).audio, 'base64').every(b => b === 0));
  state.receive({ type: 'session.input_audio.unmuted', client_event_id: command.event_id });
  await new Promise(resolve => setImmediate(resolve));
  state.pump();
  assert.ok(Buffer.from(sent.at(-1).audio, 'base64').every(b => b === 1));
  state.finish(true);
});

test('Live input release waits for queued audio and a silence tail before mute', async () => {
  const { live, state, sent } = harness();
  state.muted = false;
  live.sendAudio(Buffer.alloc(1920, 1)); live.setInput(false);
  state.releaseAt = 1; state.pump();
  assert.equal(sent.at(-1).type, 'session.input_audio.append');
  assert.equal(state.mic.length, 960);
  state.pump(); state.releaseAt = 1; state.pump();
  await Promise.resolve();
  assert.equal(sent.at(-1).type, 'session.input_audio.mute');
  state.receive({ type: 'session.input_audio.muted', client_event_id: sent.at(-1).event_id });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.muted, true);
  state.finish(true);
});

test('Live never treats an instruction acknowledgment as drained playback', async () => {
  const { live, state, sent } = harness();
  const audio: Buffer[] = []; live.on('audio', b => audio.push(b));
  const transcripts: string[] = []; live.on('event', e => { if (e.type === 'session.output_transcript.delta') transcripts.push(e.delta); });
  const speech = Buffer.alloc(960); for (let i = 0; i < 480; i++) speech.writeInt16LE(2000, i * 2);
  live.interrupt();
  state.receive({ type: 'session.instructions.appended', client_event_id: sent.at(-1).event_id });
  state.output(speech);
  state.receive({ type: 'session.output_transcript.delta', delta: 'Old reply' });
  assert.equal(audio.length, 0);
  assert.equal(transcripts.length, 0);
  for (let i = 0; i < 12; i++) state.output(Buffer.alloc(960));
  state.output(speech);
  state.receive({ type: 'session.output_transcript.delta', delta: 'New reply' });
  assert.equal(audio.length, 1);
  assert.deepEqual(transcripts, ['New reply']);
  state.finish(true);
});

test('Live silence never holds the native queue open, and UTF-8 context stays bounded', () => {
  const { live, state } = harness(); let count = 0;
  live.on('audio', () => count++);
  for (let i = 0; i < 100; i++) state.output(Buffer.alloc(960));
  assert.equal(count, 0);
  assert.ok(Buffer.byteLength(liveContext('😀'.repeat(1000))) <= 480);
  state.finish(true);
});

test('Live sends a complete short story as one commentary update', async () => {
  const { live, state, sent } = harness();
  state.socket.send = (json: string) => {
    const event = JSON.parse(json); sent.push(event);
    queueMicrotask(() => state.receive({ type: 'session.commentary.appended', client_event_id: event.event_id }));
  };
  const answer = Array.from({ length: 5 }, (_, i) => `Sentence ${i + 1}: a tiny robot repaired the clock, found the lost gear, greeted the watchmaker and returned to its shelf.`).join(' ');
  await live.append('commentary', answer, 'story_delegation');
  assert.equal(sent.length, 1);
  assert.equal(sent.map(e => e.content).join(' '), answer);
  assert.ok(sent.every(e => e.delegation_id === 'story_delegation'));
  state.finish(true);
});

test('Live cumulative usage is finalized once, and transport loss is marked estimated', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-live-usage-')), 'gumbo.db'));
  initUsageRecorder(store);
  const { state } = harness();
  state.receive({ type: 'session.usage.updated', usage: { seconds: 12 } });
  state.receive({ type: 'session.usage.updated', usage: { seconds: 15 } });
  state.receive({ type: 'session.closed', usage: { seconds: 16 } });
  state.finish(false);
  const db = (store as any).db;
  const rows = db.prepare('select units, estimated, cost_usd from usage').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].units, 16); assert.equal(rows[0].estimated, 0);
  assert.equal(rows[0].cost_usd, 16 * 0.05 / 60);
  const lost = harness(); lost.state.seconds = 7; lost.state.finish(false);
  assert.equal(db.prepare('select estimated from usage order by rowid desc limit 1').get().estimated, 1);
});

 test('Live stages a long answer before triggering speech so later chunks cannot replace earlier speech', async () => {
  const { live, state, sent } = harness();
  state.socket.send = (json: string) => {
    const event = JSON.parse(json); sent.push(event);
    queueMicrotask(() => state.receive({ type: event.type + 'ed', client_event_id: event.event_id }));
  };
  const answer = Array.from({ length: 80 }, (_, i) => `Sentence ${i + 1}: The robot put the gear into the clock.`).join(' ');
  await live.append('commentary', answer, 'long_answer');
  assert.equal(sent.at(-1).type, 'session.commentary.append');
  assert.ok(sent.slice(0, -1).every(e => e.type === 'session.thinking.append'));
  assert.equal(sent.slice(0, -1).map(e => e.content.replace(/^Backend answer, part \d+\/\d+: /, '')).join(' '), answer);
  assert.ok(sent.every(e => e.delegation_id === 'long_answer'));
  state.finish(true);
});
