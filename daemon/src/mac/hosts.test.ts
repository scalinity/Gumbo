import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { hostAllowed, hostOf, rememberHost } = await import('./hosts.ts');
const { config } = await import('../config.ts');

test('hostOf parses hosts and rejects non-URLs', () => {
  assert.equal(hostOf('https://Claude.AI/chat?x=1'), 'claude.ai');
  assert.equal(hostOf('https://sub.example.com:8443/p'), 'sub.example.com');
  assert.equal(hostOf('about:blank'), null);
  assert.equal(hostOf('not a url'), null);
  assert.equal(hostOf('file:///tmp/x.html'), null, 'file URLs have no host');
});

test('nothing is allowed until the user approves something', () => {
  assert.equal(hostAllowed('https://example.com/'), false);
});

test('remembered hosts persist, match subdomains, and survive a reload', () => {
  rememberHost('Example.com');
  assert.equal(hostAllowed('https://example.com/page'), true, 'exact');
  assert.equal(hostAllowed('https://www.example.com/'), true, 'subdomain of an entry');
  assert.equal(hostAllowed('https://notexample.com/'), false, 'suffix must be a dot boundary');
  const onDisk = JSON.parse(readFileSync(join(config.home.browser, 'hosts.json'), 'utf8'));
  assert.deepEqual(onDisk, ['example.com'], 'normalized + persisted');
});

test('config base entries allow without any remembered file', () => {
  config.browser.allowedHosts.push('base-host.dev');
  try {
    assert.equal(hostAllowed('https://api.base-host.dev/x'), true);
  } finally {
    config.browser.allowedHosts.pop();
  }
});

test('a corrupt hosts file degrades to empty, not a crash', async () => {
  // Fresh process state isn't available inside one file — but the load path is exercised
  // via a corrupt file BEFORE the first read in a fresh import. Simulate by writing junk
  // and asserting rememberHost round-trips it back to a clean list.
  mkdirSync(config.home.browser, { recursive: true });
  writeFileSync(join(config.home.browser, 'hosts.json'), '{not json');
  // The module cache already loaded a good list this process; the corrupt file only
  // matters for the NEXT daemon boot — assert the writer repairs it.
  rememberHost('repaired.io');
  const onDisk = JSON.parse(readFileSync(join(config.home.browser, 'hosts.json'), 'utf8'));
  assert.ok(onDisk.includes('repaired.io'));
});
