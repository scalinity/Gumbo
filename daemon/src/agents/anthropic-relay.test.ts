import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAnthropicRelay } from './anthropic-relay.ts';
import { config } from '../config.ts';

test('coding relay authenticates, restricts routes/models and keeps the upstream key private', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const relay = createAnthropicRelay((async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response('data: streamed\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch);
  const server = createServer(relay.handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, token = relay.token, model = config.models.worker) => fetch(url + path, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [], max_tokens: 1 }),
  });
  try {
    assert.equal((await request('/anthropic/v1/messages', 'wrong')).status, 401);
    assert.equal((await request('/anthropic/v1/batches')).status, 404);
    assert.equal((await request('/anthropic/v1/messages', relay.token, 'other')).status, 400);
    assert.equal(await (await request('/anthropic/v1/messages')).text(), 'data: streamed\n\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, undefined);
    assert.notEqual((calls[0].init.headers as Record<string, string>)['x-api-key'], relay.token);
    relay.close();
    assert.equal((await request('/anthropic/v1/messages')).status, 401);
  } finally { relay.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
