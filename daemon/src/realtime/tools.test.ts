import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { createOrchestratorTools } = await import('./tools.ts');

// Firecrawl is background-only content acquisition. If any scrape/crawl/map/extract tool
// ever leaks into the realtime session config, the voice model gains a way to hit many
// pages on someone else's infrastructure straight from the hot path — this asserts on the
// actual registry, not on source text.
test('no Firecrawl tool is registered in the realtime session config', () => {
  // Tool definitions are built eagerly; manager/store are only touched inside execute
  // closures, so stubs are safe here.
  const tools = createOrchestratorTools({} as never, {} as never);
  const names = tools.map((t) => (t as { name: string }).name);
  assert.ok(names.includes('web_quick_lookup'), 'sanity: the real registry loaded');
  assert.ok(names.includes('spawn_subagent'), 'sanity: the real registry loaded');
  for (const banned of ['scrape_page', 'map_site', 'crawl_site', 'extract_structured']) {
    assert.ok(!names.includes(banned), `${banned} must not be a realtime tool`);
  }
  for (const name of names) {
    assert.doesNotMatch(name, /firecrawl|scrape|crawl|extract/i, `${name} smells like a content-acquisition tool`);
  }
});
