import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capSnapshot, diffSnapshots, encodeRefs, parseRef, refTable, stripForDiff } from './snapshot.ts';

test('encodeRefs scopes plain and frame refs to a generation; parseRef round-trips', () => {
  const yaml = '- button "Send" [ref=e12]\n- iframe:\n  - textbox "To" [ref=f2e5]';
  const encoded = encodeRefs(yaml, 3);
  assert.match(encoded, /\[ref=g3e12\]/);
  assert.match(encoded, /\[ref=g3f2e5\]/);
  assert.deepEqual(parseRef('g3e12'), { generation: 3, playwrightRef: 'e12' });
  assert.deepEqual(parseRef('g3f2e5'), { generation: 3, playwrightRef: 'f2e5' });
  assert.equal(parseRef('e12'), null, 'an unscoped ref is not accepted');
  assert.equal(parseRef('g3'), null);
});

test('refTable extracts role + accessible name (with escaped quotes) as the model saw them', () => {
  const encoded = encodeRefs(
    [
      '- button "Send" [ref=e1]',
      '- link "Say \\"hi\\" now" [cursor=pointer] [ref=e2]',
      '- textbox [ref=e3]',
      '- paragraph: some text with [ref=e99] mentioned inline but no list dash role',
    ].join('\n'),
    1,
  );
  const table = refTable(encoded);
  assert.deepEqual(table.get('g1e1'), { role: 'button', name: 'Send' });
  assert.deepEqual(table.get('g1e2'), { role: 'link', name: 'Say "hi" now' });
  assert.deepEqual(table.get('g1e3'), { role: 'textbox', name: null });
});

test('stripForDiff drops ref + focus noise but keeps meaningful state', () => {
  const yaml = '- button "Send" [active] [ref=e1]\n- checkbox "Done" [checked] [ref=e2]';
  assert.equal(stripForDiff(yaml), '- button "Send"\n- checkbox "Done" [checked]');
});

test('diffSnapshots is a multiset diff: duplicate-line changes count, reflow does not', () => {
  const before = '- item "a"\n- item "b"\n- item "b"';
  const reordered = '- item "b"\n- item "a"\n- item "b"';
  assert.equal(diffSnapshots(before, reordered, 50).changed, false, 'pure reorder is no change');
  const oneDupGone = '- item "a"\n- item "b"';
  const d = diffSnapshots(before, oneDupGone, 50);
  assert.equal(d.changed, true, 'losing one of two duplicates IS a change');
  assert.match(d.text, /− - item "b"/);
});

test('an oversized diff truncates with an explicit note', () => {
  const before = Array.from({ length: 100 }, (_, i) => `- old ${i}`).join('\n');
  const after = Array.from({ length: 100 }, (_, i) => `- new ${i}`).join('\n');
  const d = diffSnapshots(before, after, 10);
  assert.equal(d.text.split('\n').length, 11, '10 lines + the note');
  assert.match(d.text, /more changed lines/);
  assert.match(d.text, /browser_snapshot/);
});

test('capSnapshot cuts at a line boundary and says so', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const capped = capSnapshot(text, 100);
  assert.ok(capped.length < text.length);
  assert.match(capped, /truncated/);
  assert.ok(!capped.includes('line 49'));
  const lines = capped.split('\n');
  assert.match(lines[lines.length - 2], /^line \d+$/, 'no half-line above the note');
});
