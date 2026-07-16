import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
process.env.OPENAI_API_KEY ??= 'sk-test-key';
const { editImage, runImageEdit, safeImageFile } = await import('./edit.ts');
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

test('multipart contract: endpoint, model, prompt, source image, and a dimension-matched mask', async () => {
  const calls = capture();
  await editImage(SOURCE_FILE, 'make the sky purple', STROKES);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/edits');
  const form = calls[0].init.body as FormData;
  assert.ok(form instanceof FormData, 'edits are multipart, not JSON');
  assert.equal(form.get('model'), 'gpt-image-2');
  assert.equal(form.get('prompt'), 'make the sky purple');
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

test('the edit lands as a NEW file — never overwrites the source', async () => {
  capture();
  const out = await editImage(SOURCE_FILE, 'p', STROKES);
  assert.notEqual(out, SOURCE_FILE);
  assert.match(out, /^[0-9a-f-]{8}\.png$/);
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

test('safeImageFile confines wire filenames to bare generated names', () => {
  assert.equal(safeImageFile('abc-123.png'), 'abc-123.png');
  assert.equal(safeImageFile('a_b.png'), 'a_b.png');
  for (const bad of ['../escape.png', 'a/b.png', 'x.jpg', 'x.png ', '.png', 'x.PNG.sh', 'db/gumbo.db']) {
    assert.throws(() => safeImageFile(bad), /invalid image filename/, `must reject ${bad}`);
  }
});
