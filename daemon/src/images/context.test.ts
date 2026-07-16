import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { ImageEditContext, applyImageContext } = await import('./context.ts');

function harness() {
  const context = new ImageEditContext();
  const errors: string[] = [];
  const apply = (msg: { file?: unknown; strokes?: unknown }) =>
    applyImageContext(context, msg, (detail) => errors.push(detail));
  return { context, errors, apply };
}

test('a valid message arms the context with sanitized strokes', () => {
  const { context, errors, apply } = harness();
  apply({ file: 'swamp-1.png', strokes: [{ points: [[0.2, 0.3]], radius: 0.05 }] });
  const armed = context.get();
  assert.equal(armed?.file, 'swamp-1.png');
  assert.equal(armed?.strokes.length, 1);
  assert.equal(errors.length, 0);
});

test('file null (viewer closed) clears the context and drops the strokes', () => {
  const { context, apply } = harness();
  apply({ file: 'swamp-1.png', strokes: [{ points: [[0.2, 0.3]], radius: 0.05 }] });
  apply({ file: null });
  assert.equal(context.get(), null);
});

test('a bad payload fails toward NO TARGET — cleared context, error surfaced (review 🟡)', () => {
  const { context, errors, apply } = harness();
  apply({ file: 'swamp-1.png' }); // armed
  apply({ file: 'swamp-1.png', strokes: 'garbage' }); // malformed strokes
  assert.equal(context.get(), null, 'a stale image must not stay armed for voice edits');
  assert.equal(errors.length, 1);

  apply({ file: '../evil.png' }); // traversal filename
  assert.equal(context.get(), null);
  assert.equal(errors.length, 2);
});
