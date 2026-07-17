import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { readForPresentation, isEditableFile, PRESENT_FILE_MAX_CHARS } = await import('./present.ts');
const { config, secretFilePaths } = await import('../config.ts');
// isEditableFile expects a realpath'd path (the write boundary realpaths its target);
// canonicalize the root here so the assertions match on macOS where the temp home sits
// under the /var → /private/var symlink.
const HOME_REAL = realpathSync(config.home.root);

test('readForPresentation: relative path refused', () => {
  const r = readForPresentation('relative/x.md');
  assert.ok('error' in r && /absolute path/.test(r.error));
});

test('readForPresentation: a protected path that does not exist still refuses as protected (string check first)', () => {
  const r = readForPresentation(join(secretFilePaths[1], 'projects/does-not-exist.jsonl'));
  assert.ok('error' in r && /protected path/.test(r.error), 'must not fall into could-not-read');
});

test('readForPresentation: missing file → could-not-read', () => {
  const r = readForPresentation('/nonexistent/definitely/missing.md');
  assert.ok('error' in r && /Could not read/.test(r.error));
});

test('readForPresentation: reads a real file with derived title + capped content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gumbo-pres-'));
  const path = join(dir, 'spec.md');
  writeFileSync(path, '# Title\n\nbody');
  const r = readForPresentation(path);
  assert.ok(!('error' in r));
  if (!('error' in r)) {
    assert.equal(r.file, 'spec.md');
    assert.equal(r.title, 'spec.md');
    assert.equal(r.path, path);
    assert.match(r.content, /# Title/);
  }
});

test('readForPresentation: honors an explicit title, else the basename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gumbo-pres-'));
  const path = join(dir, 'notes.md');
  writeFileSync(path, 'x');
  const r = readForPresentation(path, 'My Notes');
  assert.ok(!('error' in r) && r.title === 'My Notes');
});

test('readForPresentation: NUL-carrying content is treated as binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gumbo-pres-'));
  const path = join(dir, 'blob.md');
  writeFileSync(path, Buffer.from([0x68, 0x00, 0x69]));
  const r = readForPresentation(path);
  assert.ok('error' in r && /binary file/.test(r.error));
});

test('readForPresentation: oversize refused before content is returned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gumbo-pres-'));
  const path = join(dir, 'huge.md');
  writeFileSync(path, 'x'.repeat(PRESENT_FILE_MAX_CHARS * 4 + 1));
  const r = readForPresentation(path);
  assert.ok('error' in r && /too large/.test(r.error));
});

test('isEditableFile: only paths under ~/Gumbo are editable', () => {
  assert.equal(isEditableFile(join(HOME_REAL, 'tasks/abc/spec.md')), true);
  assert.equal(isEditableFile(HOME_REAL), true);
  assert.equal(isEditableFile('/etc/hosts'), false);
  assert.equal(isEditableFile('/Users/dev/Documents/Apps/Gumbo/daemon/src/index.ts'), false, 'repo code is not editable this way');
  // A sibling dir sharing the prefix must not slip through (boundary check).
  assert.equal(isEditableFile(`${HOME_REAL}-evil/x.md`), false);
});
