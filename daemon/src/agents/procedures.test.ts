import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { validateProcedure, createProcedureService, procedureSummary } = await import('./procedures.ts');
const { Store } = await import('../events/store.ts');

const GOOD = {
  goal: 'File the monthly expense report in Mail',
  preconditions: ['Mail is set up with the work account'],
  apps: ['Mail'],
  steps: [
    { lane: 'ax', desc: 'Open a new message', target: { app: 'Mail', role: 'AXButton', name: 'Compose' }, verb: 'press', verify: 'a compose window is open' },
    { lane: 'ax', desc: 'Type the subject', target: { app: 'Mail', role: 'AXTextField', name: 'Subject' }, verb: 'type', value: 'Expenses June', param: true, verify: 'subject shows the month' },
    { lane: 'key', desc: 'Send it', value: 'cmd+shift+d', verify: 'the compose window closed', checkpoint: true },
  ],
};

test('validateProcedure accepts a well-formed procedure and forces the given name', () => {
  const p = validateProcedure({ ...GOOD, name: 'model-invented name' }, 'file expenses');
  assert.ok(p);
  assert.equal(p.name, 'file expenses', 'the caller names procedures, never the model');
  assert.equal(p.steps.length, 3);
  assert.equal(p.steps[1].param, true);
  assert.equal(p.steps[2].checkpoint, true);
});

test('validateProcedure rejects structural garbage', () => {
  assert.equal(validateProcedure(null, 'x'), null);
  assert.equal(validateProcedure({ goal: 'g', steps: [] }, 'x'), null);
  assert.equal(validateProcedure({ steps: GOOD.steps }, 'x'), null); // no goal
  assert.equal(validateProcedure({ goal: 'g', steps: [{ lane: 'teleport', desc: 'zap' }] }, 'x'), null);
  assert.equal(validateProcedure({ goal: 'g', steps: [{ lane: 'ax' }] }, 'x'), null); // step without desc
  assert.equal(
    validateProcedure({ goal: 'g', steps: Array.from({ length: 201 }, () => ({ lane: 'ax', desc: 'd' })) }, 'x'),
    null,
    'a 201-step "procedure" is a runaway, not a skill',
  );
});

test('validateProcedure redaction: credential-labeled typing becomes a content-free handoff, whatever the model wrote', () => {
  const p = validateProcedure({
    goal: 'log in and check the balance',
    steps: [
      { lane: 'browser', desc: 'Enter the username', target: { role: 'textbox', name: 'Username' }, verb: 'fill', value: 'the user@example.test' },
      { lane: 'browser', desc: 'Enter the password', target: { role: 'textbox', name: 'Password' }, verb: 'fill', value: 'hunter2' },
      { lane: 'handoff', desc: 'the user signs in', value: 'should-not-survive' },
    ],
  }, 'check balance');
  assert.ok(p);
  assert.equal(p.steps[0].lane, 'browser', 'ordinary fields keep their value');
  assert.equal(p.steps[1].lane, 'handoff', 'credential-labeled step must become a handoff');
  assert.equal(p.steps[1].value, undefined, 'credential content must be dropped');
  assert.equal(p.steps[2].value, undefined, 'a handoff never carries content');
});

function seededStore() {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'gumbo-proc-')), 'gumbo.db');
  return new Store(dbPath);
}

test('distillTeaching compiles, saves v1, and events procedure.learned', async () => {
  const store = seededStore();
  const prompts: string[] = [];
  const service = createProcedureService(store, async (_instructions, input) => {
    prompts.push(input);
    return JSON.stringify(GOOD);
  });
  const summary = await service.distillTeaching('file expenses', [
    { kind: 'click', app: 'Mail', role: 'AXButton', name: 'Compose', value: 'click', ts: 1 },
    { kind: 'type', app: 'Mail', role: 'AXTextField', name: 'Subject', value: 'Expenses June', ts: 2 },
  ], 'task1');
  assert.match(summary, /Saved procedure "file expenses" v1 \(taught\) — 3 steps/);
  assert.match(prompts[0], /demonstration the user performed himself/);
  assert.match(prompts[0], /click on Button "Compose"/);
  const row = store.getProcedure('file expenses');
  assert.ok(row);
  assert.equal(row.version, 1);
  assert.equal(row.provider, 'taught');
  assert.equal((JSON.parse(row.body) as { steps: unknown[] }).steps.length, 3);
});

test('compile retries once on invalid output, then fails loudly', async () => {
  const store = seededStore();
  let calls = 0;
  const flaky = createProcedureService(store, async () => {
    calls += 1;
    return calls === 1 ? 'not json at all' : '```json\n' + JSON.stringify(GOOD) + '\n```';
  });
  const summary = await flaky.distillTeaching('retry proc', [{ kind: 'click', app: 'Mail', ts: 1 }], 't');
  assert.equal(calls, 2, 'one retry after invalid output');
  assert.match(summary, /Saved procedure "retry proc" v1/);

  let broken = 0;
  const dead = createProcedureService(store, async () => { broken += 1; return 'still not json'; });
  await assert.rejects(() => dead.distillTeaching('doomed', [{ kind: 'click', app: 'Mail', ts: 1 }], 't'), /did not produce a valid procedure/);
  assert.equal(broken, 2, 'exactly two attempts, never an unbounded loop');
});

test('saveFromTask distills a finished computer task trace; refuses non-successful tasks', async () => {
  const store = seededStore();
  const now = Date.now();
  store.createTask({ id: 'run1', kind: 'computer', title: 'Check invoices', status: 'done', workspace: '/tmp/x', created_at: now, updated_at: now });
  store.addEvent('run1', 'task.created', { title: 'Check invoices', brief: 'open the billing portal and list the unpaid invoices', kind: 'computer' });
  store.addEvent('run1', 'tool.call', { name: 'browser_navigate', args: '{"action":"goto","url":"https://billing.test"}' });
  store.addEvent('run1', 'tool.result', { output: 'Landed on billing.test — invoice table visible' });

  const inputs: string[] = [];
  const service = createProcedureService(store, async (_i, input) => {
    inputs.push(input);
    return JSON.stringify(GOOD);
  });
  const saved = await service.saveFromTask('run1', 'check invoices');
  assert.equal(saved.version, 1);
  assert.equal(saved.stepCount, 3);
  assert.match(inputs[0], /billing portal/, 'the brief anchors the goal');
  assert.match(inputs[0], /→ browser_navigate .*billing\.test/, 'the trace carries the calls');
  assert.equal(store.getProcedure('check invoices')?.provider, 'saved');

  store.createTask({ id: 'run2', kind: 'computer', title: 'Died', status: 'failed', workspace: '/tmp/y', created_at: now, updated_at: now });
  await assert.rejects(() => service.saveFromTask('run2', 'nope'), /only a successful run/);
  store.createTask({ id: 'run3', kind: 'subagent', title: 'Research', status: 'done', workspace: '/tmp/z', created_at: now, updated_at: now });
  await assert.rejects(() => service.saveFromTask('run3', 'nope'), /only a finished computer task/);
});

test('procedureSummary reads as a spoken-ready digest', () => {
  const p = validateProcedure(GOOD, 'file expenses');
  assert.ok(p);
  const s = procedureSummary(p, 2, 'healed');
  assert.match(s, /"file expenses" v2 \(healed\) — 3 steps \(apps: Mail\)/);
  assert.match(s, /3\. \[key\] Send it ✓checkpoint/);
});
