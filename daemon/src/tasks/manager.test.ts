import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set GUMBO_HOME before importing config so task workspaces land in a temp dir.
process.env.GUMBO_HOME = mkdtempSync(join(tmpdir(), 'gumbo-mgr-'));
const { Store } = await import('../events/store.ts');
const { TaskManager } = await import('./manager.ts');
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
