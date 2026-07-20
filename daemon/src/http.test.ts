import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-http-'));
const { createHttpServer } = await import('./http.ts');
const { Store } = await import('./events/store.ts');
const { config } = await import('./config.ts');

// A real loopback server on an ephemeral port — the /api/hosts mutation surface is a
// security boundary (it writes the computer-use exfil allowlist), so it gets HTTP-level
// coverage: the CSRF Origin guard, host validation, and the round-trip.
const store = new Store(join(mkdtempSync(join(tmpdir(), 'gumbo-http-db-')), 'gumbo.db'));
const server = createHttpServer(store);
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function hostsReq(method: string, opts: { origin?: string; body?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.origin) headers.Origin = opts.origin;
  const res = await fetch(`${base}/api/hosts`, { method, headers, body: opts.body });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('GET /api/hosts returns base + remembered', async () => {
  const { status, json } = await hostsReq('GET');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.base) && Array.isArray(json.remembered));
});

test('POST from an ALLOWED dashboard origin persists and round-trips through GET', async () => {
  const origin = config.allowedOrigins[0];
  const post = await hostsReq('POST', { origin, body: JSON.stringify({ host: 'roundtrip.example' }) });
  assert.equal(post.status, 200);
  assert.ok(post.json.remembered.includes('roundtrip.example'));
  const get = await hostsReq('GET');
  assert.ok(get.json.remembered.includes('roundtrip.example'), 'persisted across requests');
  const del = await hostsReq('DELETE', { origin, body: JSON.stringify({ host: 'roundtrip.example' }) });
  assert.ok(!del.json.remembered.includes('roundtrip.example'), 'DELETE removes it');
});

test('POST from a HOSTILE origin is refused 403 and writes nothing (CSRF guard)', async () => {
  const before = (await hostsReq('GET')).json.remembered.length;
  const { status } = await hostsReq('POST', { origin: 'http://evil.example', body: JSON.stringify({ host: 'evil.example' }) });
  assert.equal(status, 403);
  const after = (await hostsReq('GET')).json.remembered;
  assert.equal(after.length, before, 'nothing persisted');
  assert.ok(!after.includes('evil.example'));
});

test('DELETE from a HOSTILE origin is also refused 403 (the guard covers both methods)', async () => {
  // Seed a host natively, then confirm a hostile page can't remove it either.
  await hostsReq('POST', { body: JSON.stringify({ host: 'keep.example' }) });
  const { status } = await hostsReq('DELETE', { origin: 'http://evil.example', body: JSON.stringify({ host: 'keep.example' }) });
  assert.equal(status, 403);
  assert.ok((await hostsReq('GET')).json.remembered.includes('keep.example'), 'still present — hostile DELETE refused');
  await hostsReq('DELETE', { body: JSON.stringify({ host: 'keep.example' }) }); // cleanup (native)
});

test('POST with no Origin (native shell / same-origin proxy) is allowed', async () => {
  const { status, json } = await hostsReq('POST', { body: JSON.stringify({ host: 'native.example' }) });
  assert.equal(status, 200);
  assert.ok(json.remembered.includes('native.example'));
  await hostsReq('DELETE', { body: JSON.stringify({ host: 'native.example' }) });
});

test('a dotless / TLD-wide host is rejected 400 (would allowlist an entire TLD)', async () => {
  for (const host of ['com', '', 'has space', 'http://x.com', 'a/b']) {
    const { status } = await hostsReq('POST', { body: JSON.stringify({ host }) });
    assert.equal(status, 400, `should reject ${JSON.stringify(host)}`);
  }
  assert.ok(!(await hostsReq('GET')).json.remembered.includes('com'));
});

test('malformed JSON body is a clean 400, not a crash', async () => {
  const { status } = await hostsReq('POST', { body: '{not json' });
  assert.equal(status, 400);
});

test('an oversized body is capped at 413', async () => {
  const { status } = await hostsReq('POST', { body: JSON.stringify({ host: 'x'.repeat(5000) }) });
  assert.equal(status, 413);
});
