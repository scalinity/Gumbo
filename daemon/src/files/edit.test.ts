import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A dedicated GUMBO_HOME so config.home.root is a temp dir we control (isEditableFile gates
// on it). Set BEFORE importing config.
const HOME = mkdtempSync(join(tmpdir(), 'gumbo-edit-home-'));
process.env.GUMBO_HOME ??= HOME;
const { runFileEdit, stripWrappingFence } = await import('./edit.ts');
const { config } = await import('../config.ts');

// A recording store + present + announce so we can assert the exactly-once invariant and
// the busy-state exits without a live model (editFn is injected).
function harness() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const presented: unknown[] = [];
  return {
    events,
    presented,
    store: { addEvent: (_t: unknown, type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); return {}; } } as never,
    present: (doc: unknown) => { presented.push(doc); return true; },
    announce: async () => {},
    types: () => events.map((e) => e.type),
  };
}

function docUnderHome(name: string, body: string): string {
  const dir = join(config.home.root, 'tasks', 'edit-test');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

test('runFileEdit success: writes, backs up, presents, emits requested+edited exactly once (no failed)', async () => {
  const h = harness();
  const path = docUnderHome('doc.md', '# Original\n\nbody');
  await runFileEdit({ path, prompt: 'tweak it', store: h.store, present: h.present, announce: h.announce, editFn: async () => '# Edited\n\nnew body' });
  assert.equal(readFileSync(path, 'utf8'), '# Edited\n\nnew body', 'the file was rewritten');
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), '# Original\n\nbody', 'the prior content was backed up');
  assert.deepEqual(h.types(), ['file.edit_requested', 'file.edited'], 'exactly one edited, no failure');
  assert.equal(h.presented.length, 1, 'the new version was re-presented once');
});

test('runFileEdit empty output: does NOT overwrite, emits requested+failed', async () => {
  const h = harness();
  const path = docUnderHome('doc2.md', 'keep me');
  await runFileEdit({ path, prompt: 'x', store: h.store, present: h.present, announce: h.announce, editFn: async () => '   ' });
  assert.equal(readFileSync(path, 'utf8'), 'keep me', 'a blank rewrite must not destroy the file');
  assert.ok(!existsSync(`${path}.bak`), 'no backup written when the edit is refused');
  assert.deepEqual(h.types(), ['file.edit_requested', 'file.edit_failed']);
});

test('runFileEdit symlink escape: a link under ~/Gumbo pointing outside is refused, target untouched (🔴)', async () => {
  const h = harness();
  const outside = mkdtempSync(join(tmpdir(), 'gumbo-outside-'));
  const secret = join(outside, 'zshrc');
  writeFileSync(secret, 'ORIGINAL SECRET');
  const dir = join(config.home.root, 'tasks', 'edit-test');
  mkdirSync(dir, { recursive: true });
  const link = join(dir, 'summary.md');
  symlinkSync(secret, link);
  await runFileEdit({ path: link, prompt: 'add a line', store: h.store, present: h.present, announce: h.announce, editFn: async () => 'MALICIOUS' });
  assert.equal(readFileSync(secret, 'utf8'), 'ORIGINAL SECRET', 'the symlink target OUTSIDE ~/Gumbo must not be overwritten');
  assert.ok(h.types().includes('file.edit_failed'), 'the escape is refused');
  assert.ok(!h.types().includes('file.edited'), 'nothing was edited');
});

test('runFileEdit non-editable path (outside ~/Gumbo) refused before any model call', async () => {
  const h = harness();
  const outside = mkdtempSync(join(tmpdir(), 'gumbo-repo-'));
  const path = join(outside, 'code.ts');
  writeFileSync(path, 'export const x = 1;');
  let called = false;
  await runFileEdit({ path, prompt: 'x', store: h.store, present: h.present, announce: h.announce, editFn: async () => { called = true; return 'edited'; } });
  assert.equal(called, false, 'the editFn must not run for a non-workspace file');
  assert.equal(readFileSync(path, 'utf8'), 'export const x = 1;');
  assert.deepEqual(h.types(), ['file.edit_failed']);
});

test('runFileEdit exactly-once when announce throws: file.edited stays, no double file.edit_failed', async () => {
  const h = harness();
  const path = docUnderHome('doc3.md', 'before');
  await runFileEdit({
    path, prompt: 'x', store: h.store, present: h.present,
    announce: async () => { throw new Error('tts down'); },
    editFn: async () => 'after',
  });
  assert.equal(readFileSync(path, 'utf8'), 'after', 'the edit still landed');
  assert.ok(h.types().includes('file.edited'));
  assert.ok(!h.types().includes('file.edit_failed'), 'a throwing announce must NOT re-emit a failure over a success');
  // The announce throw is recorded as a session.error, not a failed edit.
  assert.ok(h.types().includes('session.error'));
});

test('stripWrappingFence: strips a full wrap, keeps a doc that only STARTS with a fence', () => {
  assert.equal(stripWrappingFence('```md\nhello\n```'), 'hello', 'a full wrap is unwrapped');
  assert.equal(stripWrappingFence('```c++\nint main(){}\n```'), 'int main(){}', 'digit/+ language tags handled');
  // A document that genuinely opens with a code block (no closing fence at the very end).
  const doc = '```bash\necho hi\n```\n\n# Real heading\n\nbody';
  assert.equal(stripWrappingFence(doc), doc, 'a leading-but-not-wrapping fence is preserved');
  assert.equal(stripWrappingFence('no fence at all'), 'no fence at all');
});
