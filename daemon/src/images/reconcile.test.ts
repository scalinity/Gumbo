import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { reapInterruptedImageWork } = await import('./reconcile.ts');
const { Store } = await import('../events/store.ts');
type EventRow = import('../events/store.ts').EventRow;

function harness() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-reap-')), 'gumbo.db'));
  const emitted: EventRow[] = [];
  store.onEvent((e) => emitted.push(e));
  return { store, emitted };
}

test('an orphaned generation is failed loudly; completed and already-failed ones are untouched', () => {
  const { store, emitted } = harness();
  store.addEvent(null, 'image.generating', { gen_id: 'g-done', prompt: 'a lake' });
  store.addEvent(null, 'image.created', { file: 'a.png', prompt: 'a lake', gen_id: 'g-done' });
  store.addEvent(null, 'image.generating', { gen_id: 'g-failed', prompt: 'a cave' });
  store.addEvent(null, 'image.generate_failed', { gen_id: 'g-failed', prompt: 'a cave', error: 'boom' });
  store.addEvent(null, 'image.generating', { gen_id: 'g-orphan', prompt: 'a dragon battle' });
  emitted.length = 0;

  const reaped = reapInterruptedImageWork(store);
  assert.deepEqual(reaped, [{ kind: 'generation', prompt: 'a dragon battle' }]);
  const failure = emitted.find((e) => e.type === 'image.generate_failed');
  assert.equal((failure?.payload as { gen_id: string }).gen_id, 'g-orphan');
  assert.match(String((failure?.payload as { error: string }).error), /interrupted by daemon restart/);
});

test('an orphaned edit is failed by file; a completed edit of the same file consumes its credit', () => {
  const { store, emitted } = harness();
  // First edit of x.png completed (image.created carries edited_from)...
  store.addEvent(null, 'image.edit_requested', { file: 'x.png', prompt: 'add a deer' });
  store.addEvent(null, 'image.created', { file: 'y.png', prompt: 'add a deer', edited_from: 'x.png' });
  // ...second edit of the same file died with the daemon.
  store.addEvent(null, 'image.edit_requested', { file: 'x.png', prompt: 'make it stormy' });
  emitted.length = 0;

  const reaped = reapInterruptedImageWork(store);
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].kind, 'edit');
  const failure = emitted.find((e) => e.type === 'image.edit_failed');
  assert.equal((failure?.payload as { file: string }).file, 'x.png', 'the viewer un-busies off this file');
});

test('a clean history reaps nothing (idempotent across healthy restarts)', () => {
  const { store, emitted } = harness();
  store.addEvent(null, 'image.generating', { gen_id: 'g1', prompt: 'p' });
  store.addEvent(null, 'image.created', { file: 'a.png', gen_id: 'g1' });
  store.addEvent(null, 'image.edit_requested', { file: 'a.png', prompt: 'q' });
  store.addEvent(null, 'image.edit_failed', { file: 'a.png', prompt: 'q', error: 'bad mask' });
  emitted.length = 0;
  assert.deepEqual(reapInterruptedImageWork(store), []);
  assert.equal(emitted.length, 0);
  // And the reap's own failure events satisfy the next boot's scan.
  store.addEvent(null, 'image.generating', { gen_id: 'g2', prompt: 'r' });
  reapInterruptedImageWork(store);
  assert.deepEqual(reapInterruptedImageWork(store), [], 'second boot sees the terminal from the first');
});
