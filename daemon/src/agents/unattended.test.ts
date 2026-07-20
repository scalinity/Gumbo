import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { wrapUnattendedApps } = await import('./unattended.ts');

function fakeTool(name: string) {
  const invoked: string[] = [];
  const toolObj = {
    name,
    invoked,
    invoke: async (_ctx: unknown, args: string) => {
      invoked.push(args);
      return 'ran';
    },
  };
  return toolObj;
}

test('in-set and null-app calls pass straight through; out-of-set apps confirm once then admit', async () => {
  const confirms: string[] = [];
  let approve = true;
  const toolObj = wrapUnattendedApps(fakeTool('focus_app'), ['Mail'], async (detail) => {
    confirms.push(detail);
    return approve;
  });
  assert.equal(await toolObj.invoke({}, JSON.stringify({ app: 'Mail' }) as never), 'ran');
  assert.equal(await toolObj.invoke({}, JSON.stringify({ app: 'mail' }) as never), 'ran', 'case-insensitive');
  assert.equal(confirms.length, 0, 'recorded apps never ask');

  assert.equal(await toolObj.invoke({}, JSON.stringify({ app: 'Safari' }) as never), 'ran');
  assert.equal(confirms.length, 1, 'out-of-set app asks');
  assert.match(confirms[0], /Safari.*outside its recorded apps/);
  assert.equal(await toolObj.invoke({}, JSON.stringify({ app: 'Safari' }) as never), 'ran');
  assert.equal(confirms.length, 1, 'approval admits the app for the rest of the run');

  const snapshot = wrapUnattendedApps(fakeTool('ax_snapshot'), ['Mail'], async () => true);
  assert.equal(await snapshot.invoke({}, JSON.stringify({ app: null, max_elements: 100 }) as never), 'ran');
});

test('a denied out-of-set app returns a refusal without invoking the tool', async () => {
  const inner = fakeTool('focus_app');
  const toolObj = wrapUnattendedApps(inner, ['Mail'], async () => false);
  const out = await toolObj.invoke({}, JSON.stringify({ app: 'Messages' }) as never);
  assert.match(String(out), /didn't approve using "Messages"/);
  assert.equal(inner.invoked.length, 0, 'a refused app never reaches the tool');
});

test('non-app-targeting tools are returned unwrapped', async () => {
  const inner = fakeTool('browser_act');
  const confirms: string[] = [];
  const toolObj = wrapUnattendedApps(inner, ['Mail'], async (d) => { confirms.push(d); return false; });
  assert.equal(await toolObj.invoke({}, JSON.stringify({ app: 'Whatever' }) as never), 'ran');
  assert.equal(confirms.length, 0, 'only app-targeting tools carry the boundary');
});
