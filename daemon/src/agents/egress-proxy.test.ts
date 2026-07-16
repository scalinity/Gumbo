import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, type Socket } from 'node:net';
import { hostAllowed, startEgressProxy, type EgressProxy } from './egress-proxy.ts';

test('hostAllowed: exact + subdomain match, case-insensitive, no partial-suffix match', () => {
  const allow = ['github.com', 'anthropic.com'];
  assert.equal(hostAllowed('github.com', allow), true, 'exact');
  assert.equal(hostAllowed('api.github.com', allow), true, 'subdomain');
  assert.equal(hostAllowed('API.GitHub.com', allow), true, 'case-insensitive');
  assert.equal(hostAllowed('raw.githubusercontent.com', allow), false, 'different domain');
  assert.equal(hostAllowed('notgithub.com', allow), false, 'leading-dot guard blocks suffix-only match');
  assert.equal(hostAllowed('evil.com', allow), false, 'unlisted');
});

// Raw CONNECT through the proxy. Node's http client emits 'connect' on a 2xx (tunnel
// established) and 'response' on a non-2xx (our 403) — handle both, resolving the status.
function doConnect(proxyPort: number, target: string): Promise<{ status: number; socket?: Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on('response', (res) => resolve({ status: res.statusCode ?? 0 }));
    req.on('error', reject);
    req.end();
  });
}

test('startEgressProxy: tunnels an allowlisted host, 403s + escalates unknowns (memoized once)', async () => {
  // Local echo server stands in for an allowlisted upstream.
  const echo = createServer((sock) => sock.pipe(sock));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  const echoPort = (echo.address() as { port: number }).port;

  const asked: string[] = [];
  const onUnknown = async (host: string) => {
    asked.push(host);
    return host === 'approved.test'; // deny everything except this one
  };
  const proxy: EgressProxy = await startEgressProxy(['localhost'], onUnknown);

  try {
    // 1. Allowlisted host → tunnel established (200), and bytes echo back through it.
    const ok = await doConnect(proxy.port, `localhost:${echoPort}`);
    assert.equal(ok.status, 200, 'allowlisted CONNECT establishes the tunnel');
    const roundTrip = await new Promise<string>((resolve) => {
      ok.socket!.on('data', (d) => resolve(d.toString()));
      ok.socket!.write('ping');
    });
    assert.equal(roundTrip, 'ping', 'tunnel pipes bytes both ways');
    ok.socket!.destroy();

    // 2. Unknown host, escalation denies → 403, and onUnknown was consulted for it.
    const blocked = await doConnect(proxy.port, 'blocked.test:443');
    assert.equal(blocked.status, 403, 'denied unknown host is refused');
    assert.ok(asked.includes('blocked.test'), 'escalation ran for the unknown host');

    // 3. Second connect to the SAME denied host reuses the memoized decision — no re-prompt.
    const before = asked.length;
    const blockedAgain = await doConnect(proxy.port, 'blocked.test:443');
    assert.equal(blockedAgain.status, 403, 'still denied');
    assert.equal(asked.length, before, 'decision memoized — onUnknown not called again');
  } finally {
    proxy.close();
    echo.close();
  }
});
