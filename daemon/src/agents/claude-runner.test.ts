import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { InputQueue } = await import('./claude-runner.ts');

function content(msg: { message: { content: unknown } }): string {
  return typeof msg.message.content === 'string' ? msg.message.content : '';
}

test('InputQueue drains queued messages in order, then completes on close', async () => {
  const q = new InputQueue();
  assert.equal(q.push('a'), true);
  assert.equal(q.push('b'), true);
  q.close();
  assert.equal(q.push('c'), false, 'push after close is rejected (caller resumes instead)');
  const got: string[] = [];
  for await (const msg of q) got.push(content(msg));
  assert.deepEqual(got, ['a', 'b']);
});

test('InputQueue wakes a pending iterator when a message arrives later', async () => {
  const q = new InputQueue();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next(); // queue empty → parks on the wake promise
  q.push('x');
  const { value, done } = await pending;
  assert.equal(done, false);
  assert.equal(content(value as { message: { content: unknown } }), 'x');
  q.close();
});
