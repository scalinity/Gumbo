import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { createBrowserTools } = await import('./browser-tools.ts');
const { rememberHost } = await import('../mac/hosts.ts');
const { config } = await import('../config.ts');
import type { BrowserSurface } from './browser-tools.ts';
import type { BrowserResult } from '../browser/client.ts';

const auditPath = join(config.home.logs, 'mac-audit.jsonl');
function auditLines(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

type ToolLike = { name: string; invoke: (ctx: unknown, args: string) => Promise<string> };

function fakeSurface(overrides: Partial<BrowserSurface> & { actResult?: BrowserResult } = {}) {
  const acts: Array<Record<string, unknown>> = [];
  const surface = {
    acts,
    snapshot: overrides.snapshot ?? (async () => ({ ok: true, output: 'url: https://ok.test/\ntitle: Ok\n---\n- button "Go" [ref=g1e1]' })),
    act:
      overrides.act ??
      (async (input: Record<string, unknown>) => {
        acts.push(input);
        return overrides.actResult ?? { ok: true, output: '+ something changed' };
      }),
    navigate: overrides.navigate ?? (async (url: string) => ({ ok: true, output: `url: ${url}\ntitle: New\n---\n(snapshot)` })),
    back: overrides.back ?? (async () => ({ ok: true, output: '(snapshot)' })),
    listTabs: overrides.listTabs ?? (async () => ({ ok: true, output: '1. [active] https://ok.test/ — Ok' })),
    switchTab: overrides.switchTab ?? (async () => ({ ok: true, output: '(snapshot)' })),
    refInfo: overrides.refInfo ?? (() => ({ role: 'button', name: 'Go' })),
    formMethod: overrides.formMethod ?? (async () => null),
    currentUrl: overrides.currentUrl ?? (() => 'https://ok.test/page'),
  };
  return surface as unknown as BrowserSurface & { acts: Array<Record<string, unknown>> };
}

function tools(surface: BrowserSurface, confirm: (detail: string, title?: string) => Promise<boolean> = async () => false) {
  return createBrowserTools('bt1', surface, new AbortController().signal, confirm) as unknown as ToolLike[];
}
function byName(list: ToolLike[], name: string) {
  const t = list.find((t) => t.name === name);
  assert.ok(t, `${name} missing`);
  return t!;
}
const actArgs = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ verb: 'click', ref: 'g1e1', value: null, role: null, name: null, timeout_ms: 5000, ...over });

// Approve the fake surface's host once for the whole file — host-gate specifics get their
// own tests below with distinct hosts.
rememberHost('ok.test');

test('the browser toolset exposes exactly the three sub-agent tools', () => {
  const names = tools(fakeSurface()).map((t) => t.name);
  assert.deepEqual(names.sort(), ['browser_act', 'browser_navigate', 'browser_snapshot'].sort());
});

test('an ordinary click on an approved host runs without confirm and audits with the url', async () => {
  const surface = fakeSurface();
  let confirmed = 0;
  const out = await byName(tools(surface, async () => ((confirmed += 1), true)), 'browser_act').invoke({}, actArgs());
  assert.equal(out, '+ something changed');
  assert.equal(confirmed, 0, 'no confirm for a plain click');
  const last = auditLines().at(-1)!;
  assert.equal(last.kind, 'browser');
  assert.equal(last.gate, 'auto');
  assert.equal(last.url, 'https://ok.test/page');
  assert.equal(last.action, 'click Go');
});

test('a send/submit-named click ALWAYS confirms; declined = audited + never acts', async () => {
  const surface = fakeSurface({ refInfo: () => ({ role: 'button', name: 'Send message' }) });
  const asked: string[] = [];
  const out = await byName(
    tools(surface, async (detail, title) => {
      asked.push(`${title}: ${detail}`);
      return false;
    }),
    'browser_act',
  ).invoke({}, actArgs());
  assert.match(out, /didn't approve/);
  assert.equal(surface.acts.length, 0, 'the act never reached the browser');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Allow this browser action\?/);
  assert.match(asked[0], /clicking "Send message"/);
  const last = auditLines().at(-1)!;
  assert.equal(last.gate, 'declined');
  assert.equal(last.ok, false);
});

test('approved submit runs and audits gate=confirmed', async () => {
  const surface = fakeSurface({ refInfo: () => ({ role: 'button', name: 'Submit order' }) });
  const out = await byName(tools(surface, async () => true), 'browser_act').invoke({}, actArgs());
  assert.equal(out, '+ something changed');
  assert.equal(surface.acts.length, 1);
  assert.equal(auditLines().at(-1)!.gate, 'confirmed');
});

test('Enter in a POST form confirms; in a GET form it stays auto', async () => {
  const surfacePost = fakeSurface({ formMethod: async () => 'post' });
  let asked = 0;
  await byName(tools(surfacePost, async () => ((asked += 1), true)), 'browser_act').invoke({}, actArgs({ verb: 'press', ref: null, value: 'Enter' }));
  assert.equal(asked, 1, 'POST form Enter asks');
  const surfaceGet = fakeSurface({ formMethod: async () => 'get' });
  await byName(tools(surfaceGet, async () => ((asked += 1), true)), 'browser_act').invoke({}, actArgs({ verb: 'press', ref: null, value: 'Enter' }));
  assert.equal(asked, 1, 'GET form Enter does not ask');
});

test('acting on an unlisted host asks once per task, memoizes approval, and refuses on deny', async () => {
  const surface = fakeSurface({ currentUrl: () => 'https://unlisted.example/x' });
  let asked = 0;
  const approveOnce = tools(surface, async (detail, title) => {
    asked += 1;
    assert.equal(title, 'Open this website?');
    assert.match(detail, /unlisted\.example/);
    return true;
  });
  await byName(approveOnce, 'browser_act').invoke({}, actArgs());
  await byName(approveOnce, 'browser_act').invoke({}, actArgs({ ref: 'g1e2', value: 'x' }));
  assert.equal(asked, 1, 'approval memoized for the task');

  const denyTools = tools(fakeSurface({ currentUrl: () => 'https://denied.example/x' }), async () => false);
  const out = await byName(denyTools, 'browser_act').invoke({}, actArgs());
  assert.match(out, /didn't approve using denied\.example/);
});

test('browser_navigate gates the TARGET host before going there', async () => {
  const surface = fakeSurface();
  const navArgs = JSON.stringify({ action: 'goto', url: 'https://brandnew.example/page', tab: null });
  const out = await byName(tools(surface, async () => false), 'browser_navigate').invoke({}, navArgs);
  assert.match(out, /didn't approve using brandnew\.example/);
  const ok = await byName(tools(surface, async () => true), 'browser_navigate').invoke({}, navArgs);
  assert.match(ok, /url: https:\/\/brandnew\.example\/page/);
  const last = auditLines().at(-1)!;
  assert.equal(last.action, 'goto https://brandnew.example/page');
});

test('type refuses newlines (submit would dodge the gate); fill is the multiline path', async () => {
  const surface = fakeSurface();
  const out = await byName(tools(surface), 'browser_act').invoke({}, actArgs({ verb: 'type', value: 'line1\nline2' }));
  assert.match(out, /single-line/);
  assert.equal(surface.acts.length, 0);
  await byName(tools(surface), 'browser_act').invoke({}, actArgs({ verb: 'fill', value: 'line1\nline2' }));
  assert.equal(surface.acts.length, 1, 'fill with newlines is allowed');
});

test('the repetition guard short-circuits the 3rd identical act', async () => {
  const surface = fakeSurface();
  const act = byName(tools(surface), 'browser_act');
  await act.invoke({}, actArgs());
  await act.invoke({}, actArgs());
  const third = await act.invoke({}, actArgs());
  assert.equal(surface.acts.length, 2, 'the 3rd never reached the browser');
  assert.match(third, /repeated "click" on the same target 3 times/);
});

test('three no_change acts in a row trip the structured stall note', async () => {
  const surface = fakeSurface({ actResult: { ok: true, output: '(no observable change on the page)', no_change: true } });
  const act = byName(tools(surface), 'browser_act');
  await act.invoke({}, actArgs({ ref: 'g1e1' }));
  await act.invoke({}, actArgs({ ref: 'g1e2' }));
  const third = await act.invoke({}, actArgs({ ref: 'g1e3' }));
  assert.match(third, /no observable change — you are not making progress/);
});

test('typed failures surface the kind with a re-snapshot hint', async () => {
  const surface = fakeSurface({ actResult: { ok: false, output: 'ref g1e9 is from an older snapshot', error_kind: 'stale_ref' } as BrowserResult });
  const out = await byName(tools(surface), 'browser_act').invoke({}, actArgs({ ref: 'g1e1' }));
  assert.match(out, /Error \(stale_ref\)/);
  assert.match(out, /browser_snapshot/);
});
