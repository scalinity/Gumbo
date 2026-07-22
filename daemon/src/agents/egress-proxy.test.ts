import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, type Socket } from 'node:net';
import { hostAllowed, startEgressProxy, vetResolvedAddresses, MAX_ESCALATIONS, type EgressProxy } from './egress-proxy.ts';

// Scan MEDIUM (2026-07-22): a hostname that resolves to a private/loopback address (DNS
// rebinding / split-horizon) must be refused even after allowlisting or a confirm.
test('vetResolvedAddresses: refuses any private/loopback resolution, accepts a public one', () => {
  assert.equal(vetResolvedAddresses(['93.184.216.34']), '93.184.216.34', 'a public IP is dialed');
  assert.equal(vetResolvedAddresses(['127.0.0.1']), null, 'loopback refused');
  assert.equal(vetResolvedAddresses(['10.0.0.5']), null, 'RFC1918 refused');
  assert.equal(vetResolvedAddresses(['169.254.169.254']), null, 'link-local (cloud metadata) refused');
  assert.equal(vetResolvedAddresses(['93.184.216.34', '127.0.0.1']), null, 'reject-if-ANY-forbidden (rebinding returns both)');
  assert.equal(vetResolvedAddresses(['::1']), null, 'IPv6 loopback refused');
  assert.equal(vetResolvedAddresses([]), null, 'no addresses → refuse');
});

test('startEgressProxy: an APPROVED host that resolves to a private IP is still refused (SSRF)', async () => {
  // onUnknown approves the host, but the injected resolver (standing in for DNS) points it
  // at a private address → the proxy must refuse AFTER approval, before dialing.
  const asked: string[] = [];
  const proxy = await startEgressProxy(
    [],
    async (h) => { asked.push(h); return true; }, // approve everything
    '127.0.0.1',
    async () => vetResolvedAddresses(['10.0.0.5']), // "DNS" says this host is private → null
  );
  try {
    const res = await doConnect(proxy.port, 'rebind.test:443');
    assert.equal(res.status, 403, 'a private resolution is refused despite approval');
    assert.ok(asked.includes('rebind.test'), 'the host WAS approved — the block is the resolution guard, downstream of the confirm');
  } finally {
    proxy.close();
  }
});

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
  // Inject a resolver mapping the test hostname to the loopback echo server — the default
  // resolver would (correctly) refuse a host that resolves to loopback (SSRF guard), so a
  // test exercising the TUNNEL mechanism points its fake host at the echo server directly.
  const proxy: EgressProxy = await startEgressProxy(['localhost'], onUnknown, '127.0.0.1', async () => '127.0.0.1');

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

test('startEgressProxy: an APPROVED unknown host tunnels end-to-end (escalate→200 round-trip)', async () => {
  const echo = createServer((sock) => sock.pipe(sock));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  const echoPort = (echo.address() as { port: number }).port;
  // Empty allowlist; onUnknown approves 'localhost'. Injected resolver points it at the echo
  // server (the default resolver would refuse a loopback resolution — see the SSRF tests).
  const proxy = await startEgressProxy([], async (host) => host === 'localhost', '127.0.0.1', async () => '127.0.0.1');
  try {
    const ok = await doConnect(proxy.port, `localhost:${echoPort}`);
    assert.equal(ok.status, 200, 'approved unknown host establishes the tunnel');
    const roundTrip = await new Promise<string>((resolve) => {
      ok.socket!.on('data', (d) => resolve(d.toString()));
      ok.socket!.write('pong');
    });
    assert.equal(roundTrip, 'pong', 'approved tunnel pipes bytes');
    ok.socket!.destroy();
  } finally {
    proxy.close();
    echo.close();
  }
});

test('startEgressProxy: malformed/forbidden CONNECT targets are refused without escalating', async () => {
  const asked: string[] = [];
  const proxy = await startEgressProxy([], async (h) => { asked.push(h); return true; }); // approve-all: only a refuse-before-escalate yields 403
  try {
    for (const target of ['github.com:99999', 'github.com:0', ':443', '127.0.0.1:8080', '169.254.169.254:80', '10.0.0.5:443']) {
      const r = await doConnect(proxy.port, target);
      assert.equal(r.status, 403, `${target} refused at parse/literal guard`);
    }
    assert.equal(asked.length, 0, 'none of the malformed/forbidden targets reached escalation');
  } finally {
    proxy.close();
  }
});

test('startEgressProxy: memo key is case-insensitive — case variants do not re-prompt', async () => {
  const asked: string[] = [];
  const proxy = await startEgressProxy([], async (h) => { asked.push(h); return false; });
  try {
    await doConnect(proxy.port, 'EVIL.com:443');
    await doConnect(proxy.port, 'evil.com:443');
    assert.deepEqual(asked, ['evil.com'], 'onUnknown called once, with the lowercased host');
  } finally {
    proxy.close();
  }
});

test('startEgressProxy: concurrent connects to one unknown host share a single escalation', async () => {
  let calls = 0;
  let release!: (v: boolean) => void;
  const gate = new Promise<boolean>((r) => (release = r));
  const proxy = await startEgressProxy([], async () => { calls += 1; return gate; });
  try {
    const both = Promise.all([doConnect(proxy.port, 'slow.test:443'), doConnect(proxy.port, 'slow.test:443')]);
    release(false); // resolve the single in-flight decision → both refused
    const [a, b] = await both;
    assert.equal(a.status, 403);
    assert.equal(b.status, 403);
    assert.equal(calls, 1, 'in-flight promise shared — only one escalation for two concurrent connects');
  } finally {
    proxy.close();
  }
});

test('startEgressProxy: a THROWN escalation denies but is not cached — a later connect re-escalates', async () => {
  let calls = 0;
  const proxy = await startEgressProxy([], async () => { calls += 1; throw new Error('supervisor down'); });
  try {
    const first = await doConnect(proxy.port, 'flaky.test:443');
    assert.equal(first.status, 403, 'transient escalation error fails closed');
    const second = await doConnect(proxy.port, 'flaky.test:443');
    assert.equal(second.status, 403, 'still denied on the retry');
    assert.equal(calls, 2, 'error was NOT memoized — the host re-escalated');
  } finally {
    proxy.close();
  }
});

test('startEgressProxy: distinct-host escalations are capped, then refused without prompting', async () => {
  const asked: string[] = [];
  const proxy = await startEgressProxy([], async (h) => { asked.push(h); return false; });
  try {
    for (let i = 0; i <= MAX_ESCALATIONS; i++) {
      const r = await doConnect(proxy.port, `h${i}.test:443`);
      assert.equal(r.status, 403, `h${i} denied`);
    }
    assert.equal(asked.length, MAX_ESCALATIONS, `escalations capped at ${MAX_ESCALATIONS}; the extra host was refused without a prompt`);
  } finally {
    proxy.close();
  }
});

test('startEgressProxy: a bind failure rejects (fail-closed) instead of crashing/hanging', async () => {
  // 203.0.113.0/24 is TEST-NET-3 — not assigned to any interface, so listen() fails
  // EADDRNOTAVAIL. The promise must reject so the runner turns it into CLAUDE_PROXY_ERROR.
  await assert.rejects(startEgressProxy([], async () => false, '203.0.113.1'), /EADDRNOTAVAIL|ENOTAVAIL|error/i);
});

test('startEgressProxy: a plain-HTTP (non-CONNECT) request is refused 405', async () => {
  const proxy = await startEgressProxy([], async () => true);
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: 'http://example.com/' });
      req.on('response', (res) => { resolve(res.statusCode ?? 0); res.resume(); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 405, 'plain HTTP is not proxied');
  } finally {
    proxy.close();
  }
});
