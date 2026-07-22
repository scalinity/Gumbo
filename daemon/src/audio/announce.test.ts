import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { needsInputAnnounce } = await import('./announce.ts');

// The needs_input pause announcement (review 🟡): the branch lived inline in index.ts and
// was untested — the reason must reach both delivery halves, and no task id may leak
// (the voice model relays these nearly verbatim).

test('needsInputAnnounce interpolates title and reason into both halves', () => {
  const { cold, live } = needsInputAnnounce('Harness spec', 'the plan needs your approval');
  assert.equal(cold, 'The user, the Harness spec task is paused — the plan needs your approval.');
  assert.match(live, /"Harness spec" just paused and needs the user: the plan needs your approval\./);
  assert.match(live, /Never mention task ids\./);
  for (const s of [cold, live]) assert.ok(!/task[_ ]?id\s*[:=]|\bt-[a-z0-9]/i.test(s), 'no id-shaped content');
});

test('needsInputAnnounce defangs the live echo but leaves cold TTS verbatim', () => {
  const { cold, live } = needsInputAnnounce('T', 'blocked on "quotes" <and> `ticks`');
  assert.ok(cold.includes('"quotes" <and> `ticks`'), 'cold is spoken, never interpreted');
  assert.ok(!live.includes('<and>'), 'instruction-shaped characters are stripped from the live echo');
});
