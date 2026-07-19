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

test('request serialization: endpoint, bearer auth, verified model id, shape → size, quality default HIGH', async () => {
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
    // Highest-quality default (the user, 2026-07-16) — values probed against the live API.
    quality: 'high',
  });
});

test('an explicit quality (quick draft) overrides the high default', async () => {
  const calls = capture();
  await generateImage('a sketch', 'square', 'low');
  assert.equal(JSON.parse(String(calls[0].init.body)).quality, 'low');
});

test('decodes b64_json and writes a real PNG under a prompt-derived word name; collisions suffix, never clobber', async () => {
  capture();
  const file = await generateImage('a swamp at dusk', 'square');
  assert.match(file, /^swamp-dusk(-\d+)?\.png$/, 'name comes from the prompt words (the user: recallable by voice)');
  const bytes = readFileSync(join(config.home.images, file));
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic bytes');
  const second = await generateImage('a swamp at dusk', 'square');
  assert.notEqual(second, file, 'same prompt again gets a suffixed name — wx never overwrites');
  assert.match(second, /^swamp-dusk-\d+\.png$/);
});

test('runImageGeneration lifecycle: image.generating FIRST, then image.created with the same gen_id — never the base64', async () => {
  capture();
  const { store, events, announced, announce } = harness();
  await runImageGeneration({ prompt: 'a swamp at dusk', shape: 'landscape', store, announce });

  const generating = events.find((e) => e.type === 'image.generating');
  assert.ok(generating, 'image.generating emitted (this is what pops the shell orb + feeds the boot reaper)');
  const created = events.find((e) => e.type === 'image.created');
  assert.ok(created, 'image.created emitted');
  assert.ok(generating.seq < created.seq, 'generating precedes created');
  const payload = created.payload as { file: string; prompt: string; gen_id: string };
  assert.match(payload.file, /\.png$/);
  assert.equal(payload.prompt, 'a swamp at dusk');
  assert.equal(payload.gen_id, (generating.payload as { gen_id: string }).gen_id, 'terminal links back to its generating record');
  assert.ok(
    !JSON.stringify(created.payload).includes(TINY_PNG_B64.slice(0, 24)),
    'base64 must stay off the event stream',
  );

  assert.equal(announced.length, 1);
  assert.match(announced[0].cold, /up on your screen/);
  assert.match(announced[0].live, /swamp at dusk/);
  assert.match(announced[0].live, /on his screen/, 'completion presents on screen, not "go check the gallery"');
});

test('an API failure terminates the lifecycle: image.generate_failed with the gen_id, spoken (after one retry)', async () => {
  const calls = capture(500, { error: { message: 'boom' } });
  const { store, events, announced, announce } = harness();
  await runImageGeneration({ prompt: 'p', shape: 'square', store, announce });

  assert.equal(calls.length, 2, '5xx gets exactly one retry (provider convention)');
  assert.ok(!events.some((e) => e.type === 'image.created'));
  const failed = events.find((e) => e.type === 'image.generate_failed');
  assert.ok(failed, 'the shell orb and the boot reaper both key on this terminal');
  const payload = failed.payload as { gen_id: string; error: string };
  assert.equal(payload.gen_id, (events.find((e) => e.type === 'image.generating')?.payload as { gen_id: string }).gen_id);
  assert.match(payload.error, /images api 500/);
  assert.equal(announced.length, 1);
  assert.match(announced[0].cold, /failed/);
});

test('a transient 500 recovers on the retry; 4xx (non-429) never retries', async () => {
  // Sequenced mock: 500 then 200 — the image should land.
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    return call === 1
      ? new Response('{}', { status: 500 })
      : new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }), { status: 200 });
  }) as typeof fetch;
  const file = await generateImage('p', 'square');
  assert.match(file, /\.png$/);
  assert.equal(call, 2);

  // 400 fails immediately — retrying a rejected request just doubles the error.
  const badCalls = capture(400, { error: { message: 'bad prompt' } });
  await assert.rejects(generateImage('p', 'square'), /images api 400/);
  assert.equal(badCalls.length, 1);
});

test('a response with no b64_json is a failure, not a zero-byte file', async () => {
  capture(200, { data: [{}] });
  const { store, events, announced, announce } = harness();
  await runImageGeneration({ prompt: 'p', shape: 'square', store, announce });
  assert.ok(!events.some((e) => e.type === 'image.created'));
  assert.match(announced[0].cold, /failed/);
});
