import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
process.env.OPENAI_API_KEY ??= 'sk-test-key';
const { Orchestrator, frameRms } = await import('./session.ts');
const { Store } = await import('../events/store.ts');
const { config } = await import('../config.ts');
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
  // Args: manager, scheduler, imageContext, fileContext, macBridge, confirms — all stubs.
  const orchestrator = new Orchestrator(store, hub as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
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

// Local VAD barge-in (2026-07-16): the SDK clears its interrupt tracking the moment audio
// GENERATION completes, so during the shell's buffered drain — most of a long readback —
// server-VAD barge-in silently no-ops (talking over Gumbo, live). The daemon's own energy
// gate on the armed mic stream flushes playback immediately instead.

/** A 24 kHz mono pcm16 frame: a ±amplitude square wave, so RMS == amplitude exactly. */
function pcmFrame(amplitude: number, ms = 20): Buffer {
  const samples = ms * 24;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? -amplitude : amplitude, i * 2);
  return buf;
}

/** Orchestrator with its privates opened for the PTT/VAD seams + a captured hub. */
function vadHarness(over: { responding?: boolean; shellDraining?: boolean }) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-vad-')), 'gumbo.db'));
  const sent: Array<{ type: string }> = [];
  const hub = { broadcast: (m: { type: string }) => sent.push(m), hasRole: () => true, sendBinary: () => {} };
  // manager stub carries hasActiveTasks — the idle-timer callback (resetIdleTimer) calls it, so a
  // future fake-timer test would TypeError on a bare {} (DB1 review 🔵).
  const orchestrator = new Orchestrator(store, hub as never, { hasActiveTasks: () => false } as never, {} as never, {} as never, {} as never);
  let interrupts = 0;
  Object.assign(orchestrator, {
    armed: true,
    responding: over.responding ?? false,
    shellDraining: over.shellDraining ?? false,
    session: { sendAudio: () => {}, interrupt: () => { interrupts += 1; }, close: () => {} },
  });
  const opened = orchestrator as unknown as {
    handleMicFrame(f: Buffer): void;
    shutdown(): void;
    localHadSpeech: boolean;
  };
  return { opened, sent, interrupts: () => interrupts };
}

test('frameRms measures pcm16 energy (square wave RMS == amplitude, silence == 0)', () => {
  assert.equal(Math.round(frameRms(pcmFrame(8000))), 8000);
  assert.equal(frameRms(Buffer.alloc(960)), 0);
  assert.equal(frameRms(Buffer.alloc(0)), 0);
});

test('local barge-in: sustained speech while the shell drains flushes playback ONCE, immediately', () => {
  // shellDraining with no in-flight response — exactly the post-generation window where
  // the SDK's speech_started → interrupt() is a silent no-op.
  const { opened, sent, interrupts } = vadHarness({ shellDraining: true });
  for (let i = 0; i < 6; i++) opened.handleMicFrame(pcmFrame(8000)); // 120 ms hot ≥ minSpeechMs
  assert.equal(sent.filter((m) => m.type === 'playback_flush').length, 1, 'shell flushed');
  assert.equal(interrupts(), 1, 'SDK interrupt still attempted for server-side truncation');
  for (let i = 0; i < 6; i++) opened.handleMicFrame(pcmFrame(8000)); // keep talking
  assert.equal(sent.filter((m) => m.type === 'playback_flush').length, 1, 'one barge-in per armed window');
  assert.equal(opened.localHadSpeech, true);
  opened.shutdown();
});

test('local VAD: sub-threshold noise and non-consecutive blips never trigger or count as speech', () => {
  const { opened, sent, interrupts } = vadHarness({ shellDraining: true });
  for (let i = 0; i < 20; i++) opened.handleMicFrame(pcmFrame(300)); // below rmsThreshold
  // Hot blips separated by cold frames: consecutive counter resets, never reaches 90 ms.
  for (let i = 0; i < 4; i++) {
    opened.handleMicFrame(pcmFrame(8000, 20));
    opened.handleMicFrame(pcmFrame(100, 20));
  }
  assert.equal(sent.filter((m) => m.type === 'playback_flush').length, 0);
  assert.equal(interrupts(), 0);
  assert.equal(opened.localHadSpeech, false, 'a silent window must not count as speech (commit gate)');
  opened.shutdown();
});

test('local VAD: speech while Gumbo is NOT talking sets the commit gate but never interrupts', () => {
  const { opened, sent, interrupts } = vadHarness({});
  for (let i = 0; i < 6; i++) opened.handleMicFrame(pcmFrame(8000));
  assert.equal(opened.localHadSpeech, true, 'speech recognized for the commit path');
  assert.equal(sent.filter((m) => m.type === 'playback_flush').length, 0, 'nothing to barge in on');
  assert.equal(interrupts(), 0);
  opened.shutdown();
});

// Commit gates (review 🟡): finishTurn decides whether a released window is worth a
// commit + response. localHadSpeech latches at 90 ms (minSpeechMs) but the API rejects
// commits under ~100 ms (minPttAudioBytes) — the local-only path must respect the byte
// floor, same as the pendingRelease fork already does.

/** Orchestrator opened at the finishTurn seam: a fake session whose transport records
 *  every commit/clear/response so the gates are assertable. */
function commitHarness(over: { hadSpeech?: boolean; localHadSpeech?: boolean; armedBytes?: number }) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-commit-')), 'gumbo.db'));
  const hub = { broadcast: () => {}, hasRole: () => true, sendBinary: () => {} };
  // manager stub carries hasActiveTasks — the idle-timer callback (resetIdleTimer) calls it, so a
  // future fake-timer test would TypeError on a bare {} (DB1 review 🔵).
  const orchestrator = new Orchestrator(store, hub as never, { hasActiveTasks: () => false } as never, {} as never, {} as never, {} as never);
  const events: string[] = [];
  let responses = 0;
  const transport = {
    sendEvent: (e: { type: string }) => events.push(e.type),
    updateSessionConfig: () => {},
    requestResponse: () => { responses += 1; },
  };
  Object.assign(orchestrator, {
    armed: true,
    hadSpeech: over.hadSpeech ?? false,
    localHadSpeech: over.localHadSpeech ?? false,
    armedBytes: over.armedBytes ?? 0,
    session: { transport, sendAudio: () => {}, interrupt: () => {}, close: () => {} },
  });
  const opened = orchestrator as unknown as { handlePttRelease(): void; shutdown(): void };
  return { opened, events, responses: () => responses };
}

test('finishTurn: server-VAD speech commits and requests a response', () => {
  const { opened, events, responses } = commitHarness({ hadSpeech: true });
  opened.handlePttRelease();
  assert.deepEqual(events, ['input_audio_buffer.commit', 'input_audio_buffer.clear']);
  assert.equal(responses(), 1);
  opened.shutdown();
});

test('finishTurn: local-only speech with enough audio commits too', () => {
  const { opened, events, responses } = commitHarness({ localHadSpeech: true, armedBytes: config.minPttAudioBytes });
  opened.handlePttRelease();
  assert.deepEqual(events, ['input_audio_buffer.commit', 'input_audio_buffer.clear']);
  assert.equal(responses(), 1);
  opened.shutdown();
});

test('finishTurn: local-only speech under the byte floor is cleared, never answered', () => {
  // localHadSpeech latches at 90 ms but a commit needs ~100 ms — a sub-floor window used
  // to commit anyway and the API rejected it (or the model answered near-silence).
  const { opened, events, responses } = commitHarness({ localHadSpeech: true, armedBytes: config.minPttAudioBytes - 1 });
  opened.handlePttRelease();
  assert.deepEqual(events, ['input_audio_buffer.clear'], 'no commit on a sub-floor buffer');
  assert.equal(responses(), 0, 'a silence-floor window must not request a response');
  opened.shutdown();
});

test('finishTurn: a window with no speech at all clears and stays silent', () => {
  const { opened, events, responses } = commitHarness({});
  opened.handlePttRelease();
  assert.deepEqual(events, ['input_audio_buffer.clear']);
  assert.equal(responses(), 0);
  opened.shutdown();
});

test('a release that beats the connect stashes the window bytes for the deferred commit', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-commit-')), 'gumbo.db'));
  const hub = { broadcast: () => {}, hasRole: () => true, sendBinary: () => {} };
  // manager stub carries hasActiveTasks — the idle-timer callback (resetIdleTimer) calls it, so a
  // future fake-timer test would TypeError on a bare {} (DB1 review 🔵).
  const orchestrator = new Orchestrator(store, hub as never, { hasActiveTasks: () => false } as never, {} as never, {} as never, {} as never);
  // Mid-connect: no session yet, ensureSession's promise pending — the shape the
  // pendingRelease fork keys on. The commit decision itself runs after connect resolves
  // (needs a real RealtimeSession) and stays covered by the smokes.
  Object.assign(orchestrator, { armed: true, armedBytes: 9600, connecting: Promise.resolve(null), session: null });
  const opened = orchestrator as unknown as { handlePttRelease(): void; shutdown(): void; pendingRelease: number | null; armedBytes: number };
  opened.handlePttRelease();
  assert.equal(opened.pendingRelease, 9600, 'the window byte count survives the release');
  assert.equal(opened.armedBytes, 0, 'zeroed only after the stash');
  opened.shutdown();
});

// Continuity (2026-07-16): sessions are short-lived (idle close, tsx-watch restarts) but
// the CONVERSATION must not reset — new sessions carry recent dialogue + active tasks.
test('continuityContext stitches VAD fragments into dialogue and lists in-flight tasks', () => {
  const { store, orchestrator } = harness(false);
  // VAD chops one sentence across several transcript events — same role, consecutive.
  store.addEvent(null, 'transcript.user', { text: 'Cancel the current' });
  store.addEvent(null, 'transcript.user', { text: 'sub-agent while I fix things.' });
  store.addEvent(null, 'transcript.assistant', { text: 'Okay the user, cancelling it now.' });
  store.createTask({ id: 'tt1', kind: 'claude', title: 'Harness spec', status: 'needs_input', workspace: '/tmp/x', created_at: Date.now(), updated_at: Date.now() });
  const context = (orchestrator as unknown as { continuityContext(): string }).continuityContext();
  assert.match(context, /the user: Cancel the current sub-agent while I fix things\./, 'fragments stitched into one line');
  assert.match(context, /You: Okay the user, cancelling it now\./);
  assert.match(context, /"Harness spec" — paused, needs the user \(coding session\)/);
  assert.match(context, /do not re-greet the user/i, 'the anti-amnesia instruction rides along');
});

test('continuityContext is empty with nothing to carry, and never throws on a broken store', () => {
  const { orchestrator } = harness(false);
  assert.equal((orchestrator as unknown as { continuityContext(): string }).continuityContext(), '');
  const broken = new Orchestrator(
    { recentTranscripts: () => { throw new Error('db locked'); }, listTasks: () => [] } as never,
    { broadcast: () => {}, hasRole: () => false, sendBinary: () => {} } as never,
    {} as never, {} as never, {} as never, {} as never,
  );
  assert.equal((broken as unknown as { continuityContext(): string }).continuityContext(), '', 'continuity is best-effort, never a blocker');
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
