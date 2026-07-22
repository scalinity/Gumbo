import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { Hub } = await import('./hub.ts');

/** Boot a Hub on an ephemeral loopback port; returns the port + a teardown. */
async function bootHub(opts: { shellToken?: string } = {}): Promise<{ hub: InstanceType<typeof Hub>; port: number; server: Server }> {
  const server = createServer();
  const hub = new Hub(server, opts);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { hub, port, server };
}

function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 50));

// HIGH_BUG (2026-07-22): a JSON scalar/null frame threw a TypeError out of the message
// handler and, with no uncaughtException net, took the whole daemon down.
test('a null/scalar/array JSON frame is ignored, not fatal; normal messages still flow', async () => {
  const { hub, port, server } = await bootHub();
  const received: unknown[] = [];
  hub.onMessage((msg) => received.push(msg));
  let helloed = false;
  hub.onHello(() => { helloed = true; });

  const ws = await connect(port);
  ws.send('null');
  ws.send('42');
  ws.send('"a string"');
  ws.send('[1,2,3]');
  ws.send(JSON.stringify({ type: 'hello', role: 'dashboard' }));
  await settle();
  assert.equal(helloed, true, 'the daemon survived the malformed frames and processed the hello');

  ws.send(JSON.stringify({ type: 'debug_text', text: 'hi' }));
  await settle();
  assert.equal(received.length, 1, 'a well-formed post-hello message is delivered');
  assert.equal((received[0] as { type: string }).type, 'debug_text');

  ws.close();
  server.close();
});

// HIGH (2026-07-22): a native no-Origin process could claim the privileged shell role.
test('shell role requires the token; a wrong/missing token is rejected, dashboard is token-free', async () => {
  const TOKEN = 'a'.repeat(64);
  const { hub, port, server } = await bootHub({ shellToken: TOKEN });
  const roles: string[] = [];
  hub.onHello((role) => roles.push(role));

  // Wrong token → the socket is closed, no shell role granted.
  const bad = await connect(port);
  const badClosed = new Promise<number>((resolve) => bad.once('close', (code) => resolve(code)));
  bad.send(JSON.stringify({ type: 'hello', role: 'shell', token: 'nope' }));
  assert.equal(await badClosed, 4001, 'unauthorized shell hello is closed with 4001');

  // Missing token → likewise rejected.
  const none = await connect(port);
  const noneClosed = new Promise<number>((resolve) => none.once('close', (code) => resolve(code)));
  none.send(JSON.stringify({ type: 'hello', role: 'shell' }));
  assert.equal(await noneClosed, 4001, 'a shell hello with no token is closed');

  // Correct token → admitted as shell.
  const good = await connect(port);
  good.send(JSON.stringify({ type: 'hello', role: 'shell', token: TOKEN }));
  await settle();
  assert.ok(roles.includes('shell'), 'the right token admits the shell role');
  assert.ok(hub.hasRole('shell'), 'shell is connected');

  // Dashboard needs no token (it is Origin-gated at the handshake instead).
  const dash = await connect(port);
  dash.send(JSON.stringify({ type: 'hello', role: 'dashboard' }));
  await settle();
  assert.ok(roles.includes('dashboard'), 'dashboard admitted without a token');

  good.close();
  dash.close();
  server.close();
});
