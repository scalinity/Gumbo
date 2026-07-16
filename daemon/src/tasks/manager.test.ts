import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set GUMBO_HOME before importing config so task workspaces land in a temp dir.
process.env.GUMBO_HOME = mkdtempSync(join(tmpdir(), 'gumbo-mgr-'));
const { Store } = await import('../events/store.ts');
const { TaskManager } = await import('./manager.ts');
const { config } = await import('../config.ts');
const { mkdirSync } = await import('node:fs');
for (const dir of [config.home.tasks]) mkdirSync(dir, { recursive: true });

// A fake ClaudeSessionRunner: no live query(), returns queued results. Persists a session
// id like the real runner's init handling so the resume path has something to resume.
function fakeFactory(results: Array<{ parked: boolean; report: string }>, persist = false) {
  let i = 0;
  return (opts: { taskId: string; cwd: string; persistBrief: string; store: InstanceType<typeof Store> }) => {
    const result = results[i++] ?? { parked: false, report: '' };
    return {
      abort: new AbortController(),
      send: () => true,
      run: async () => {
        if (persist) opts.store.saveClaudeSession(opts.taskId, { sessionId: `sess-${i}`, cwd: opts.cwd, brief: opts.persistBrief });
        return result;
      },
    };
  };
}

const tick = () => new Promise((r) => setImmediate(r));
function freshManager(results: Array<{ parked: boolean; report: string }>, persist = false) {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'gumbo-mgr-db-')), 'gumbo.db');
  const store = new Store(dbPath);
  const manager = new TaskManager(store, async () => false, fakeFactory(results, persist) as never);
  return { store, manager };
}

test('cancel() on a cap-parked task actually finishes it (regression: 🔴)', async () => {
  const { store, manager } = freshManager([{ parked: true, report: '' }]);
  const task = manager.spawnClaudeSession('Parked task', 'do a thing', null);
  await tick();
  await tick();
  assert.equal(store.getTask(task.id)?.status, 'needs_input', 'task should park at the cap');

  const ok = manager.cancel(task.id);
  assert.equal(ok, true);
  assert.equal(store.getTask(task.id)?.status, 'cancelled', 'cancel must actually cancel, not no-op');
  const finished = store.listEvents({ taskId: task.id }).filter((e) => e.type === 'task.finished');
  assert.equal(finished.length, 1, 'exactly one task.finished must fire');
  assert.equal((finished[0].payload as { status?: string }).status, 'cancelled');
});

test('normal completion writes report.md and finishes done', async () => {
  const { store, manager } = freshManager([{ parked: false, report: '# Report\nall done' }]);
  const task = manager.spawnClaudeSession('Work', 'do work', null);
  await tick();
  await tick();
  assert.equal(store.getTask(task.id)?.status, 'done');
  assert.equal(readFileSync(join(task.workspace, 'report.md'), 'utf8'), '# Report\nall done');
});

test('sendToSession resumes a finished session (un-finishes, runs again)', async () => {
  const { store, manager } = freshManager(
    [
      { parked: false, report: 'first run' },
      { parked: false, report: 'second run' },
    ],
    true,
  );
  const task = manager.spawnClaudeSession('Resumable', 'first brief', null);
  await tick();
  await tick();
  assert.equal(store.getTask(task.id)?.status, 'done');

  const outcome = manager.sendToSession(task.id, 'now do more');
  assert.equal(outcome, 'resumed');
  assert.equal(store.getTask(task.id)?.status, 'running', 'resume un-finishes to running');
  await tick();
  await tick();
  assert.equal(store.getTask(task.id)?.status, 'done', 'resumed run finishes again');
  assert.equal(readFileSync(join(task.workspace, 'report.md'), 'utf8'), 'second run');
});

test('cancel() returns false for an unknown task', () => {
  const { manager } = freshManager([]);
  assert.equal(manager.cancel('nope'), false);
});
