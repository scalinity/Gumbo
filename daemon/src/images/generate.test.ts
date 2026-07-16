import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
process.env.OPENAI_API_KEY ??= 'sk-test-key';
const { generateImage, runImageGeneration } = await import('./generate.ts');
const { config } = await import('../config.ts');
const { Store } = await import('../events/store.ts');
type EventRow = import('../events/store.ts').EventRow;

mkdirSync(config.home.images, { recursive: true }); // index.ts does this on real boots

// A real 1×1 transparent PNG — the decoded file must carry the PNG magic bytes.
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

function harness() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-img-')), 'gumbo.db'));
  const events: EventRow[] = [];
  store.onEvent((e) => events.push(e));
  const announced: Array<{ cold: string; live: string }> = [];
  const announce = async (cold: string, live: string) => {
    announced.push({ cold, live });
  };
  return { store, events, announced, announce };
}

test('request serialization: endpoint, bearer auth, verified model id, shape → size', async () => {
  const calls = capture();
  await generateImage('a swamp at dusk', 'landscape');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${process.env.OPENAI_API_KEY}`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    model: 'gpt-image-2',
    prompt: 'a swamp at dusk',
    size: '1536x1024',
  });
});

test('decodes b64_json and writes a real PNG into the images home', async () => {
  capture();
  const file = await generateImage('a swamp at dusk', 'square');
  assert.match(file, /^[0-9a-f-]{8}\.png$/);
  const bytes = readFileSync(join(config.home.images, file));
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic bytes');
});

test('runImageGeneration emits image.created carrying the FILENAME — never the base64', async () => {
  capture();
  const { store, events, announced, announce } = harness();
  await runImageGeneration({ prompt: 'a swamp at dusk', shape: 'landscape', store, announce });

  const created = events.find((e) => e.type === 'image.created');
  assert.ok(created, 'image.created emitted');
  const payload = created.payload as { file: string; prompt: string };
  assert.match(payload.file, /\.png$/);
  assert.equal(payload.prompt, 'a swamp at dusk');
  assert.ok(
    !JSON.stringify(created.payload).includes(TINY_PNG_B64.slice(0, 24)),
    'base64 must stay off the event stream',
  );

  assert.equal(announced.length, 1);
  assert.match(announced[0].cold, /image is ready/);
  assert.match(announced[0].live, /swamp at dusk/);
});

test('an API failure is spoken, logged, and emits no image.created', async () => {
  capture(500, { error: { message: 'boom' } });
  const { store, events, announced, announce } = harness();
  await runImageGeneration({ prompt: 'p', shape: 'square', store, announce });

  assert.ok(!events.some((e) => e.type === 'image.created'));
  const err = events.find((e) => e.type === 'session.error');
  assert.match(String((err?.payload as { message: string })?.message), /images api 500/);
  assert.equal(announced.length, 1);
  assert.match(announced[0].cold, /failed/);
});

test('a response with no b64_json is a failure, not a zero-byte file', async () => {
  capture(200, { data: [{}] });
  const { store, events, announced, announce } = harness();
  await runImageGeneration({ prompt: 'p', shape: 'square', store, announce });
  assert.ok(!events.some((e) => e.type === 'image.created'));
  assert.match(announced[0].cold, /failed/);
});
