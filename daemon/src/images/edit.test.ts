import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
process.env.OPENAI_API_KEY ??= 'sk-test-key';
const { acceptImageEditRequest, editImage, runImageEdit } = await import('./edit.ts');
const { safeImageFile } = await import('./files.ts');
const { strokeMaskPng, pngDimensions } = await import('./mask.ts');
const { config } = await import('../config.ts');
const { Store } = await import('../events/store.ts');
type EventRow = import('../events/store.ts').EventRow;
type Stroke = import('./mask.ts').Stroke;

mkdirSync(config.home.images, { recursive: true });
// A real 64×48 PNG (an all-opaque mask doubles as a perfectly valid source image).
const SOURCE_FILE = 'source-1.png';
writeFileSync(join(config.home.images, SOURCE_FILE), strokeMaskPng(64, 48, []));

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function capture(status = 200, body: unknown = { data: [{ b64_json: TINY_PNG_B64 }] }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

const STROKES: Stroke[] = [{ points: [[0.1, 0.1], [0.9, 0.2]], radius: 0.05 }];

function harness() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-edit-')), 'gumbo.db'));
  const events: EventRow[] = [];
  store.onEvent((e) => events.push(e));
  const announce = async () => {};
  return { store, events, announce };
}

test('multipart contract: endpoint, model, prompt, source image, and a dimension-matched mask', async () => {
  const calls = capture();
  await editImage(SOURCE_FILE, 'make the sky purple', STROKES);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/edits');
  const form = calls[0].init.body as FormData;
  assert.ok(form instanceof FormData, 'edits are multipart, not JSON');
  assert.equal(form.get('model'), 'gpt-image-2');
  assert.equal(form.get('prompt'), 'make the sky purple');
  assert.equal(form.get('quality'), 'high');
  // gpt-image-2 400s on gpt-image-1's input_fidelity (live failure 2026-07-16) — it
  // must never creep back into the form.
  assert.equal(form.get('input_fidelity'), null);
  const image = form.get('image') as Blob;
  assert.ok(image instanceof Blob && image.size > 0, 'source image attached');
  const mask = form.get('mask') as Blob;
  assert.ok(mask instanceof Blob, 'mask attached when strokes are given');
  // The mask must match the SOURCE image's pixel size or the API rejects it.
  assert.deepEqual(pngDimensions(Buffer.from(await mask.arrayBuffer())), { width: 64, height: 48 });
});

test('no strokes → no mask part (whole-image edit)', async () => {
  const calls = capture();
  await editImage(SOURCE_FILE, 'brighten it up');
  const form = calls[0].init.body as FormData;
  assert.equal(form.get('mask'), null);
});

test('the edit lands as a NEW word-named file — never overwrites the source', async () => {
  capture();
  const out = await editImage(SOURCE_FILE, 'purple stormy sky over the water', STROKES);
  assert.notEqual(out, SOURCE_FILE);
  assert.match(out, /^purple-stormy-sky(-\d+)?\.png$/, 'edit names come from the edit prompt');
});

test('runImageEdit emits image.created with lineage (edited_from) and never the base64', async () => {
  capture();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-edit-')), 'gumbo.db'));
  const events: EventRow[] = [];
  store.onEvent((e) => events.push(e));
  const announced: string[] = [];
  await runImageEdit({
    file: SOURCE_FILE,
    prompt: 'make the sky purple',
    strokes: STROKES,
    store,
    announce: async (cold) => {
      announced.push(cold);
    },
  });
  const created = events.find((e) => e.type === 'image.created');
  assert.ok(created, 'image.created emitted');
  const payload = created.payload as { file: string; edited_from: string; selection?: boolean };
  assert.equal(payload.edited_from, SOURCE_FILE);
  assert.equal(payload.selection, true);
  assert.match(payload.file, /\.png$/);
  assert.ok(!JSON.stringify(payload).includes(TINY_PNG_B64.slice(0, 24)), 'base64 stays off the event stream');
  assert.equal(announced.length, 1);
  assert.match(announced[0], /edit is done/);
});

test('an API failure emits image.edit_failed (viewer un-busies on it) and is spoken', async () => {
  capture(400, { error: { message: 'bad mask' } });
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-edit-')), 'gumbo.db'));
  const events: EventRow[] = [];
  store.onEvent((e) => events.push(e));
  const announced: string[] = [];
  await runImageEdit({ file: SOURCE_FILE, prompt: 'p', store, announce: async (cold) => { announced.push(cold); } });
  assert.ok(!events.some((e) => e.type === 'image.created'));
  const failed = events.find((e) => e.type === 'image.edit_failed');
  assert.ok(failed, 'image.edit_failed emitted');
  const payload = failed.payload as { file: string; error: string };
  assert.equal(payload.file, SOURCE_FILE);
  assert.match(payload.error, /images api 400/);
  assert.match(announced[0], /failed/);
});

// The invariant the viewer's busy state rides on (review 🔴 + 🟡): every well-formed
// image_edit_request terminates in EXACTLY one of image.created | image.edit_failed.
test('acceptImageEditRequest: success path → edit_requested then image.created', async () => {
  capture();
  const { store, events, announce } = harness();
  acceptImageEditRequest({ file: SOURCE_FILE, prompt: 'p', strokes: STROKES }, store, announce);
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the background half settle
  assert.ok(events.some((e) => e.type === 'image.edit_requested'));
  assert.equal(events.filter((e) => ['image.created', 'image.edit_failed'].includes(e.type)).length, 1);
  assert.ok(events.some((e) => e.type === 'image.created'));
});

test('acceptImageEditRequest: API failure → edit_requested then image.edit_failed', async () => {
  capture(400, {}); // 4xx: fails without the 500 ms retry pause (retry behavior is covered in generate.test)
  const { store, events, announce } = harness();
  acceptImageEditRequest({ file: SOURCE_FILE, prompt: 'p' }, store, announce);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((e) => ['image.created', 'image.edit_failed'].includes(e.type)).length, 1);
  assert.ok(events.some((e) => e.type === 'image.edit_failed'));
});

test('acceptImageEditRequest: PRE-FLIGHT failures still emit image.edit_failed (the viewer has no other busy exit)', async () => {
  capture();
  const { store, events, announce } = harness();
  // Bad filename — traversal attempt.
  acceptImageEditRequest({ file: '../evil.png', prompt: 'p' }, store, announce);
  // Malformed strokes — garbage shape (over-limit sizes are clamped, not rejected).
  acceptImageEditRequest({ file: SOURCE_FILE, prompt: 'p', strokes: 'garbage' }, store, announce);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failed = events.filter((e) => e.type === 'image.edit_failed');
  assert.equal(failed.length, 2);
  assert.equal((failed[0].payload as { file: string }).file, '../evil.png', 'failure event carries the file the viewer is waiting on');
  assert.ok(!events.some((e) => e.type === 'image.created'));
});

test('acceptImageEditRequest: ignores requests no viewer could be waiting on (empty prompt/file)', () => {
  capture();
  const { store, events, announce } = harness();
  acceptImageEditRequest({ file: SOURCE_FILE, prompt: '   ' }, store, announce);
  acceptImageEditRequest({ prompt: 'p' }, store, announce);
  assert.equal(events.length, 0);
});

test('safeImageFile confines wire filenames to bare generated names', () => {
  assert.equal(safeImageFile('abc-123.png'), 'abc-123.png');
  assert.equal(safeImageFile('a_b.png'), 'a_b.png');
  for (const bad of ['../escape.png', 'a/b.png', 'x.jpg', 'x.png ', '.png', 'x.PNG.sh', 'db/gumbo.db']) {
    assert.throws(() => safeImageFile(bad), /invalid image filename/, `must reject ${bad}`);
  }
});
