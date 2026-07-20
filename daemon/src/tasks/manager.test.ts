import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set GUMBO_HOME before importing config so task workspaces land in a temp dir.
process.env.GUMBO_HOME = mkdtempSync(join(tmpdir(), 'gumbo-mgr-'));
const { Store } = await import('../events/store.ts');
const { TaskManager, makeStandDown } = await import('./manager.ts');
const { config } = await import('../config.ts');
for (const dir of [config.home.tasks]) mkdirSync(dir, { recursive: true });

type RunResult = { parked: boolean; report: string; parkedReason?: string };
type RunnerOpts = {
  taskId: string;
  cwd: string;
  persistBrief: string;
  store: InstanceType<typeof Store>;
  planFirst?: boolean;
  onPlanReady?: (plan: string) => Promise<boolean>;
};

// A fake ClaudeSessionRunner: no live query(). `behavior` decides what the run resolves to
// (and may call onPlanReady to exercise the plan-approval path). undo() is recorded.
function fakeFactory(behavior: (opts: RunnerOpts, callIndex: number) => Promise<RunResult>, undone: string[] = []) {
  let i = 0;
  return (opts: RunnerOpts) => ({
    abort: new AbortController(),
    send: () => true,
    undo: async () => {
      undone.push(opts.taskId);
      return 'undone';
    },
    run: () => behavior(opts, i++),
  });
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => {
  await tick();
  await tick();
  await tick();
};

function freshManager(
  behavior: (opts: RunnerOpts, callIndex: number) => Promise<RunResult>,
  opts: { approvePlan?: () => Promise<boolean>; undone?: string[] } = {},
) {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'gumbo-mgr-db-')), 'gumbo.db');
  const store = new Store(dbPath);
  const manager = new TaskManager(
    store,
    async () => false,
    opts.approvePlan ?? (async () => false),
    fakeFactory(behavior, opts.undone) as never,
  );
  return { store, manager };
}

test('cancel() on a cap-parked task actually finishes it (regression: 🔴)', async () => {
  const { store, manager } = freshManager(async () => ({ parked: true, report: '', parkedReason: 'cap' }));
  const task = manager.spawnClaudeSession('Parked task', 'do a thing', null);
  await settle();
  assert.equal(store.getTask(task.id)?.status, 'needs_input', 'task should park');

  assert.equal(manager.cancel(task.id), true);
  assert.equal(store.getTask(task.id)?.status, 'cancelled', 'cancel must actually cancel, not no-op');
  const finished = store.listEvents({ taskId: task.id }).filter((e) => e.type === 'task.finished');
  assert.equal(finished.length, 1);
  assert.equal((finished[0].payload as { status?: string }).status, 'cancelled');
});

test('park carries its reason into the needs_input status (maxTurns etc.)', async () => {
  const { store, manager } = freshManager(async () => ({ parked: true, report: '', parkedReason: 'reached the turn limit — needs your go-ahead to continue' }));
  const task = manager.spawnClaudeSession('Big task', 'do lots', null);
  await settle();
  const status = store.listEvents({ taskId: task.id }).filter((e) => e.type === 'task.status').at(-1);
  assert.match(String((status?.payload as { reason?: string })?.reason), /turn limit/);
});

test('normal completion writes report.md and finishes done', async () => {
  const { store, manager } = freshManager(async () => ({ parked: false, report: '# Report\nall done' }));
  const task = manager.spawnClaudeSession('Work', 'do work', null);
  await settle();
  assert.equal(store.getTask(task.id)?.status, 'done');
  assert.equal(readFileSync(join(task.workspace, 'report.md'), 'utf8'), '# Report\nall done');
});

test('sendToSession resumes a finished session (un-finishes, runs again)', async () => {
  const reports = ['first run', 'second run'];
  // Each call persists a session id (so resume has something to resume) and returns the
  // next report — exercising the fresh-run then resumed-run path.
  const { store, manager } = freshManager(async (opts, i) => {
    opts.store.saveClaudeSession(opts.taskId, { sessionId: `sess-${i}`, cwd: opts.cwd, brief: opts.persistBrief });
    return { parked: false, report: reports[i] ?? reports[reports.length - 1] };
  });
  const task = manager.spawnClaudeSession('Resumable', 'first brief', null);
  await settle();
  assert.equal(store.getTask(task.id)?.status, 'done');

  assert.equal(manager.sendToSession(task.id, 'now do more'), 'resumed');
  assert.equal(store.getTask(task.id)?.status, 'running', 'resume un-finishes to running');
  await settle();
  assert.equal(store.getTask(task.id)?.status, 'done');
  assert.equal(readFileSync(join(task.workspace, 'report.md'), 'utf8'), 'second run');
});

test('concurrent session on the same project_dir is refused (#7)', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'gumbo-proj-'));
  // A session that never resolves — stays live, holding the cwd.
  const { manager } = freshManager(() => new Promise<RunResult>(() => {}));
  manager.spawnClaudeSession('First', 'work in the repo', projectDir);
  await settle();
  assert.throws(() => manager.spawnClaudeSession('Second', 'also work there', projectDir), /already working in/);
  // A different dir is fine.
  const other = mkdtempSync(join(tmpdir(), 'gumbo-proj2-'));
  assert.ok(manager.spawnClaudeSession('Third', 'elsewhere', other));
});

test('M6: only one computer-use task may drive the Mac at a time (demo fix)', async () => {
  // A macBridge whose taskStarted throws makes runSubagent reject BEFORE any model/network
  // call — deterministic, and the spawn bookkeeping (aborts map, kind 'computer') is all
  // laid down synchronously before that rejection can settle.
  const dbPath = join(mkdtempSync(join(tmpdir(), 'gumbo-mgr-db-')), 'gumbo.db');
  const store = new Store(dbPath);
  const macBridge = { taskStarted: () => { throw new Error('stub — no live run in tests'); }, taskFinished: () => {} };
  const manager = new TaskManager(store, async () => false, async () => false, fakeFactory(async () => ({ parked: false, report: '' })) as never, macBridge as never);

  const first = manager.spawnSubagent('Change wallpaper', 'do it', 'mac');
  assert.equal(store.getTask(first.id)?.kind, 'computer');
  // Second concurrent mac task: refused synchronously, no task row created.
  assert.throws(() => manager.spawnSubagent('Also wallpaper', 'me too', 'mac'), /already driving the Mac/);
  // Research tasks are NOT blocked by a running computer task (different resource).
  await settle(); // let the stubbed rejection settle the first task to failed
  assert.equal(store.getTask(first.id)?.status, 'failed');
  // …and once the first task is terminal, a new computer task may spawn again.
  const third = manager.spawnSubagent('Retry wallpaper', 'again', 'mac');
  assert.ok(third.id);
});

test('plan approval: approved plan proceeds, denied plan parks (plan-mode)', async () => {
  // Behavior simulates the runner: call onPlanReady; approved → complete, denied → park.
  const behavior = async (opts: RunnerOpts): Promise<RunResult> => {
    const approved = opts.onPlanReady ? await opts.onPlanReady('1. do X\n2. do Y') : false;
    return approved ? { parked: false, report: 'built it' } : { parked: true, report: '', parkedReason: 'plan needs your approval or revision' };
  };

  const approved = freshManager(behavior, { approvePlan: async () => true });
  const t1 = approved.manager.spawnClaudeSession('Planned', 'build a thing', null);
  await settle();
  assert.equal(approved.store.getTask(t1.id)?.status, 'done', 'approved plan executes to completion');

  const denied = freshManager(behavior, { approvePlan: async () => false });
  const t2 = denied.manager.spawnClaudeSession('Planned', 'build a thing', null);
  await settle();
  assert.equal(denied.store.getTask(t2.id)?.status, 'needs_input', 'declined plan parks for revision');
});

test('undoSession rewinds a live session, degrades when none', async () => {
  const undone: string[] = [];
  const { manager } = freshManager(() => new Promise<RunResult>(() => {}), { undone });
  const task = manager.spawnClaudeSession('Live', 'edit stuff', null);
  await settle();
  assert.equal(await manager.undoSession(task.id), 'undone');
  assert.deepEqual(undone, [task.id]);
  assert.match(await manager.undoSession('ghost'), /No Claude session/);
});

test('an auth-marked runner error records a clean, actionable failure (review 🔴/🟡)', async () => {
  const { store, manager } = freshManager(async () => {
    throw new Error('auth: Claude Code needs you to log in again — run `claude`, then `/login`.');
  });
  const task = manager.spawnClaudeSession('Codes', 'do work', null);
  await settle();
  assert.equal(store.getTask(task.id)?.status, 'failed');
  const finished = store.listEvents({ taskId: task.id }).find((e) => e.type === 'task.finished');
  const payload = finished?.payload as { reason?: string; error?: string };
  assert.equal(payload?.reason, 'auth', "the 'auth:' prefix must be detected on err.message");
  assert.ok(!payload?.error?.startsWith('auth:'), 'the prefix is stripped from the recorded error');
  assert.match(String(payload?.error), /log in again/);
});

test('undoSession refuses while the task is paused with a live runner (needs_input)', async () => {
  const undone: string[] = [];
  // Runner asks for plan approval; approvePlan never resolves → the task sits needs_input
  // with a LIVE runner (run() still pending), exactly the pending-confirm state where a
  // reentrant rewindFiles would hang the voice turn.
  const { store, manager } = freshManager(
    async (opts) => {
      await opts.onPlanReady!('1. do X');
      return { parked: false, report: '' };
    },
    { approvePlan: () => new Promise<boolean>(() => {}), undone },
  );
  const task = manager.spawnClaudeSession('Paused', 'edit', null);
  await settle();
  assert.equal(store.getTask(task.id)?.status, 'needs_input');
  const msg = await manager.undoSession(task.id);
  assert.match(msg, /paused waiting on you/);
  assert.deepEqual(undone, [], 'undo() must NOT be called while a confirm is pending');
});

test('cancel() returns false for an unknown task', () => {
  const { manager } = freshManager(async () => ({ parked: false, report: '' }));
  assert.equal(manager.cancel('nope'), false);
});

// ——— M7 voice steering into computer tasks ———

test('sendToSession queues steering for a running computer task; takeSteering drains exactly once', () => {
  const { manager, store } = freshManager(async () => ({ parked: false, report: 'x' }));
  const now = Date.now();
  store.createTask({ id: 'mac1', kind: 'computer', title: 'drive', status: 'running', workspace: '/tmp/x', created_at: now, updated_at: now });
  assert.equal(manager.sendToSession('mac1', 'use the personal account'), 'queued');
  assert.equal(manager.sendToSession('mac1', 'skip that dialog'), 'queued');
  assert.deepEqual(manager.takeSteering('mac1'), ['use the personal account', 'skip that dialog']);
  assert.deepEqual(manager.takeSteering('mac1'), [], 'drained exactly once');
});

test('sendToSession refuses a finished computer task with a clear message', () => {
  const { manager, store } = freshManager(async () => ({ parked: false, report: 'x' }));
  const now = Date.now();
  store.createTask({ id: 'mac2', kind: 'computer', title: 'drive', status: 'done', workspace: '/tmp/x', created_at: now, updated_at: now });
  assert.throws(() => manager.sendToSession('mac2', 'hello'), /already finished/);
});

// ——— kill-switch stand-down around notch confirms (live-demo Catch-22) ———
// Answering ANY notch prompt takes the user's mouse — the tap must read that as the
// answer, not an abort. Pinned after the browser host confirm died to the kill switch
// the moment he moved toward Approve.

test('makeStandDown brackets a confirm with setHandoff true→false and passes the result through', async () => {
  const calls: boolean[] = [];
  const standDown = makeStandDown({ setHandoff: (a: boolean) => calls.push(a) });
  const result = await standDown(async () => {
    assert.deepEqual(calls, [true], 'stood down BEFORE the confirm runs');
    return 'approved';
  });
  assert.equal(result, 'approved');
  assert.deepEqual(calls, [true, false], 're-armed after the confirm resolved');
});

test('makeStandDown keeps the tap down until the LAST overlapping confirm resolves (counter, not boolean)', async () => {
  const calls: boolean[] = [];
  const standDown = makeStandDown({ setHandoff: (a: boolean) => calls.push(a) });
  let releaseA!: () => void;
  let releaseB!: () => void;
  const a = standDown(() => new Promise<void>((r) => { releaseA = r; }));
  const b = standDown(() => new Promise<void>((r) => { releaseB = r; }));
  releaseA();
  await a;
  assert.ok(!calls.includes(false), 'first confirm resolving must NOT re-arm under the second');
  releaseB();
  await b;
  assert.equal(calls.at(-1), false, 're-armed once the last confirm resolved');
  assert.equal(calls.filter((c) => c === false).length, 1, 'exactly one re-arm');
});

test('makeStandDown re-arms even when the confirm throws, and the error propagates', async () => {
  const calls: boolean[] = [];
  const standDown = makeStandDown({ setHandoff: (a: boolean) => calls.push(a) });
  await assert.rejects(
    () => standDown(async () => { throw new Error('hub gone'); }),
    /hub gone/,
  );
  assert.deepEqual(calls, [true, false], 'a throwing confirm must not leave the kill switch soft');
});

test('kill switch labels a computer task cancelled IMMEDIATELY — the runner cannot relabel it later (live demo: farewell report won as done)', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'gumbo-mgr-db-')), 'gumbo.db');
  const store = new Store(dbPath);
  const macBridge = { taskStarted: () => { throw new Error('stub — no live run in tests'); }, taskFinished: () => {}, setHandoff: () => {} };
  const manager = new TaskManager(store, async () => false, async () => false, fakeFactory(async () => ({ parked: false, report: '' })) as never, macBridge as never);
  const task = manager.spawnSubagent('Browse', 'go somewhere', 'mac');
  manager.cancelComputerTasks('human_input'); // same tick — before the runner settles either way
  assert.equal(store.getTask(task.id)?.status, 'cancelled', 'labeled at kill-switch time, not eventually');
  await settle();
  assert.equal(store.getTask(task.id)?.status, 'cancelled', 'the runner settling later must not relabel the task');
});

// ——— M8 watch-me teaching lifecycle ———

// A fake MacBridge for teaching: record_start/record_stop ack ok (overridable), and every
// call is recorded so tests can assert the arm/stop ordering and the mac_teach state.
function teachBridge(overrides: { onRequest?: (action: { kind: string }) => Promise<{ ok: boolean; output: string }> | { ok: boolean; output: string } } = {}) {
  const requests: string[] = [];
  const teachStates: boolean[] = [];
  const bridge = {
    requests,
    teachStates,
    request: async (action: { kind: string }) => {
      requests.push(action.kind);
      return overrides.onRequest ? overrides.onRequest(action) : { ok: true, output: '' };
    },
    setTeaching: (active: boolean) => { teachStates.push(active); },
    setHandoff: () => {},
    taskStarted: () => { throw new Error('stub — no live run in tests'); },
    taskFinished: () => {},
  };
  return bridge;
}

function teachManager(bridge = teachBridge()) {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'gumbo-mgr-db-')), 'gumbo.db');
  const store = new Store(dbPath);
  const manager = new TaskManager(store, async () => false, async () => false, fakeFactory(async () => ({ parked: false, report: '' })) as never, bridge as never);
  return { store, manager, bridge };
}

test('M8 teaching: start arms the recorder, steps land, stop finishes with a report (announce path fires)', async () => {
  const { store, manager, bridge } = teachManager();
  const finished: string[] = [];
  manager.onFinished = (task) => { finished.push(task.status); };

  const task = await manager.startTeaching('file expenses');
  assert.equal(store.getTask(task.id)?.kind, 'computer', 'teaching is a real computer task row');
  assert.equal(store.getTask(task.id)?.status, 'running');
  assert.deepEqual(bridge.requests, ['record_start']);
  assert.deepEqual(bridge.teachStates, [true]);

  manager.teachEvent({ kind: 'click', app: 'Mail', role: 'AXButton', name: 'Compose', value: 'click' });
  manager.teachEvent({ kind: 'type', app: 'Mail', role: 'AXTextField', name: 'Subject', value: 'June expenses' });
  manager.teachEvent('garbage'); // noise never lands
  const done = await manager.stopTeaching();
  assert.equal(done.stepCount, 2);
  assert.equal(done.name, 'file expenses');
  assert.deepEqual(bridge.requests, ['record_start', 'record_stop']);
  assert.deepEqual(bridge.teachStates, [true, false]);
  assert.equal(store.getTask(task.id)?.status, 'done');
  assert.deepEqual(finished, ['done'], 'stop rides the announce path');
  const report = readFileSync(join(task.workspace, 'report.md'), 'utf8');
  assert.match(report, /2 steps recorded/);
  assert.match(report, /typed "June expenses"/);
  const stepEvents = store.listEvents({ taskId: task.id }).filter((e) => e.type === 'teach.step');
  assert.equal(stepEvents.length, 2, 'each sanitized step is evented for the activity feed');
});

test('M8 teaching: steps arriving during the stop ack window still count (the flush ordering)', async () => {
  let releaseStop: (() => void) | null = null;
  const bridge = teachBridge({
    onRequest: (action) => {
      if (action.kind !== 'record_stop') return { ok: true, output: '' };
      return new Promise((resolve) => { releaseStop = () => resolve({ ok: true, output: '' }); });
    },
  });
  const { manager } = teachManager(bridge);
  await manager.startTeaching('late flush');
  manager.teachEvent({ kind: 'click', app: 'Notes', role: 'AXButton', name: 'New Note', value: 'click' });
  const stopping = manager.stopTeaching();
  // The shell's final typing-burst flush arrives BEFORE the record_stop ack (same socket,
  // FIFO) — it must still be part of the recording.
  manager.teachEvent({ kind: 'type', app: 'Notes', role: 'AXTextArea', name: 'Body', value: 'packing list' });
  releaseStop!();
  const done = await stopping;
  assert.equal(done.stepCount, 2, 'the flush-window step must not be dropped');
});

test('M8 teaching: a failed record_start fails the task and throws — never a silent un-recorded recording', async () => {
  const bridge = teachBridge({ onRequest: () => ({ ok: false, output: 'The event tap could not be created.' }) });
  const { store, manager } = teachManager(bridge);
  await assert.rejects(() => manager.startTeaching('doomed'), /recording could not start/);
  const rows = store.listTasks().filter((t) => t.title === 'Teaching: doomed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  // …and nothing is left armed: a new teach can start once the shell is healthy.
  assert.equal(manager.cancelTeaching('cleanup'), false, 'no teaching state may survive a failed start');
});

test('M8 teaching: mutual exclusion both ways with computer tasks', async () => {
  const { manager } = teachManager();
  await manager.startTeaching('demo');
  assert.throws(() => manager.spawnSubagent('Drive', 'do', 'mac'), /already driving the Mac/, 'a task cannot start mid-teach');
  await assert.rejects(() => manager.startTeaching('again'), /already recording/);
  await manager.stopTeaching();

  // …and the inverse: a live computer task blocks teaching.
  const { manager: manager2 } = teachManager();
  manager2.spawnSubagent('Drive', 'do', 'mac');
  await assert.rejects(() => manager2.startTeaching('nope'), /already driving the Mac/);
});

test('M8 teaching: cancel discards — task cancelled, recorder stopped, state cleared', async () => {
  const { store, manager, bridge } = teachManager();
  const task = await manager.startTeaching('changed my mind');
  manager.teachEvent({ kind: 'click', app: 'Mail', name: 'Compose' });
  assert.equal(manager.cancelTeaching('never mind'), true);
  assert.equal(store.getTask(task.id)?.status, 'cancelled');
  assert.deepEqual(bridge.teachStates, [true, false]);
  assert.ok(bridge.requests.includes('record_stop'), 'the shell recorder must be told to stop');
  await assert.rejects(() => manager.stopTeaching(), /no recording is active/);
});

test('M8 teaching: the kill switch reaches a teach session like any computer task', async () => {
  const { store, manager } = teachManager();
  const task = await manager.startTeaching('demo');
  manager.cancelComputerTasks('kill_switch_unavailable');
  assert.equal(store.getTask(task.id)?.status, 'cancelled');
  assert.equal(manager.cancelTeaching('again'), false, 'teaching state must be gone');
});

test('M8 teaching: the step cap stops the recording loudly, keeping what it captured', async () => {
  const { store, manager } = teachManager();
  const original = config.teach.maxSteps;
  (config.teach as { maxSteps: number }).maxSteps = 3;
  try {
    const task = await manager.startTeaching('long demo');
    for (let i = 0; i < 5; i += 1) {
      manager.teachEvent({ kind: 'click', app: 'Notes', name: `Button ${i}` });
    }
    await settle();
    assert.equal(store.getTask(task.id)?.status, 'done', 'cap = loud stop, not silent truncation');
    const report = readFileSync(join(task.workspace, 'report.md'), 'utf8');
    assert.match(report, /step limit reached/);
  } finally {
    (config.teach as { maxSteps: number }).maxSteps = original;
  }
});
