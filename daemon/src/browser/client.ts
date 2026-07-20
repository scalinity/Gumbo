import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { config } from '../config.ts';
import { capSnapshot, diffSnapshots, encodeRefs, parseRef, refTable, stripForDiff, type RefInfo } from './snapshot.ts';

/** Typed error kinds mirroring MacErrorKind where the meaning matches — the sub-agent
 *  learns ONE loop discipline across lanes (SPEC §M7). */
export type BrowserErrorKind = 'element_not_found' | 'stale_ref' | 'timeout' | 'browser_unavailable' | 'page_error';

/** Same result contract as MacActionResult (minus health): callers branch on error_kind,
 *  never message strings; no_change is the structured stall signal. */
export interface BrowserResult {
  ok: boolean;
  output: string;
  error_kind?: BrowserErrorKind;
  no_change?: boolean;
}

export interface BrowserActInput {
  verb: 'click' | 'fill' | 'type' | 'press' | 'select' | 'hover' | 'focus' | 'scroll' | 'wait_for';
  ref: string | null;
  value: string | null;
  role: string | null;
  name: string | null;
  timeout_ms: number;
}

function failure(kind: BrowserErrorKind, output: string): BrowserResult {
  return { ok: false, error_kind: kind, output };
}

function stateFile(): string {
  return join(config.home.browser, 'state.json');
}

/**
 * M7 browser lane: Playwright on a DEDICATED automation profile — never the user's live
 * Chrome (locked decision). HEADED via the installed Chrome (`channel:'chrome'`, no
 * bundled-browser download) so the user can watch, steer, and — in a handoff — act himself.
 * Auth is capture-once-replay: each task gets a FRESH context seeded from the persisted
 * storage state (cookies + localStorage); the state is re-captured when the task ends, so
 * a login performed during a task (handoff) is remembered for the next one. No stored
 * passwords, ever. Anti-bot walls are a clean typed failure — never an evasion arms race.
 *
 * Runs entirely in-daemon (no TCC), so unlike the AX lane there is no shell RPC — but the
 * act contract is the same: settle, then auto-return a before/after DIFF (verify by diff,
 * never by return code), with refs valid for exactly one snapshot generation.
 */
export class BrowserClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  private newPages: Page[] = [];
  private generation = 0;
  private refs = new Map<string, RefInfo>();

  /** Launch (or reuse) the browser and open this task's fresh context. Idempotent per
   *  task — every tool call ensures it, only the first does work. */
  async open(): Promise<void> {
    if (!this.browser) {
      mkdirSync(config.home.browser, { recursive: true });
      try {
        this.browser = await chromium.launch({ channel: 'chrome', headless: false });
      } catch (err) {
        throw new Error(`Could not launch Google Chrome for the automation profile: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
      // the user quitting the automation Chrome must not wedge the lane — reset so the
      // next task relaunches cleanly.
      this.browser.on('disconnected', () => {
        this.browser = null;
        this.context = null;
        this.activePage = null;
      });
    }
    if (!this.context) {
      this.context = await this.newContextRecovering();
      this.context.on('page', (page) => {
        this.newPages.push(page); // popups/new tabs — the settle step switches + reports
      });
      this.activePage = await this.context.newPage();
      this.newPages = []; // the initial page is not "new"
    }
    // Guarantee a live page even when the context survived but every tab closed (a
    // window.close() control, or the user closing the last tab). Adopt a surviving tab, else
    // open a blank one — so the model gets a snapshot of an empty page it can navigate
    // from, never a hard task failure from requirePage throwing outside a try (review 🟡).
    if (!this.activePage || this.activePage.isClosed()) {
      const remaining = this.context.pages().filter((p) => !p.isClosed());
      this.activePage = remaining.length > 0 ? remaining[remaining.length - 1] : await this.context.newPage();
    }
  }

  /** New context seeded from the persisted storage state — but a TRUNCATED state.json (a
   *  crash mid-capture: storageState writes in place, not temp-then-rename) makes
   *  newContext throw, which would wedge EVERY future browser task until the file is
   *  removed by hand. Fail safe like hosts.ts does: on a seeded-launch failure, drop the
   *  bad file and launch fresh (a lost session is re-earnable; a wedged lane is not). */
  private async newContextRecovering(): Promise<BrowserContext> {
    if (!existsSync(stateFile())) return this.browser!.newContext({ viewport: null });
    try {
      return await this.browser!.newContext({ storageState: stateFile(), viewport: null });
    } catch (err) {
      console.error('browser: stored session state was unusable, starting fresh:', err instanceof Error ? err.message.split('\n')[0] : err);
      rmSync(stateFile(), { force: true });
      return this.browser!.newContext({ viewport: null });
    }
  }

  /** Getter for the active page — open() guarantees one exists, so this only throws in a
   *  genuinely broken state (which mapError turns into a recoverable browser_unavailable). */
  private requirePage(): Page {
    const page = this.activePage;
    if (!page || page.isClosed()) {
      const remaining = this.context?.pages().filter((p) => !p.isClosed()) ?? [];
      if (remaining.length > 0) {
        this.activePage = remaining[remaining.length - 1];
        return this.activePage;
      }
      throw new Error('The automation browser window is closed — navigate somewhere to reopen one.');
    }
    return page;
  }

  currentUrl(): string | null {
    try {
      return this.activePage && !this.activePage.isClosed() ? this.activePage.url() : null;
    } catch {
      return null;
    }
  }

  /** role+name the model saw for a ref in the CURRENT generation — the submit gate's input. */
  refInfo(ref: string): RefInfo | null {
    return this.refs.get(ref) ?? null;
  }

  /** The enclosing <form>'s method for a ref (or the focused element with ref null) —
   *  input to the POST-form submit gate. null = no form / unreadable (auto direction is
   *  then decided by the lexicon alone). */
  async formMethod(ref: string | null): Promise<string | null> {
    try {
      if (ref) {
        return await this.locatorFor(ref).evaluate((el) => (el.closest('form') as HTMLFormElement | null)?.method ?? null, undefined, { timeout: 2000 });
      }
      return await this.requirePage().evaluate(() => (document.activeElement?.closest('form') as HTMLFormElement | null)?.method ?? null);
    } catch {
      return null;
    }
  }

  /** Global-screen center of a ref's element, for the ghost cursor (pure visualization).
   *  Viewport CSS px + the window's content origin — both in points on macOS, matching
   *  the ghost's AXFrame coordinate space. The origin formula is the classic
   *  outer/inner-delta approximation: exact for a plain headed window, slightly off with
   *  devtools docked — acceptable for a cosmetic overlay. null = don't fly (never guess). */
  async screenPointForRef(ref: string): Promise<{ x: number; y: number } | null> {
    try {
      const box = await this.locatorFor(ref).boundingBox({ timeout: 1500 });
      if (!box) return null;
      const origin = await this.requirePage().evaluate(() => ({
        x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
        y: window.screenY + (window.outerHeight - window.innerHeight) - (window.outerWidth - window.innerWidth) / 2,
      }));
      return { x: Math.round(origin.x + box.x + box.width / 2), y: Math.round(origin.y + box.y + box.height / 2) };
    } catch {
      return null; // stale ref / closed page — the act itself will surface the real error
    }
  }

  /** Observe: ai-mode aria snapshot with generation-scoped refs + url/title/tab header. */
  async snapshot(): Promise<BrowserResult> {
    await this.open();
    const page = this.requirePage();
    try {
      const yamlAi = await this.captureAi(page, config.browser.actTimeoutMs);
      this.generation += 1;
      const encoded = encodeRefs(yamlAi, this.generation);
      this.refs = refTable(encoded);
      const header = await this.header(page);
      return { ok: true, output: `${header}\n---\n${capSnapshot(encoded, config.browser.snapshotMaxChars)}` };
    } catch (err) {
      return this.mapError(err, 'snapshot');
    }
  }

  private async header(page: Page): Promise<string> {
    const title = await page.title().catch(() => '');
    const pages = this.context?.pages().filter((p) => !p.isClosed()) ?? [];
    const tabs = pages.length > 1 ? `\ntabs: ${pages.indexOf(page) + 1} of ${pages.length} active (browser_tabs to list/switch)` : '';
    return `url: ${page.url()}\ntitle: ${title}${tabs}`;
  }

  private locatorFor(ref: string): Locator {
    const parsed = parseRef(ref);
    if (!parsed) throw new StaleRef(`"${ref}" is not a ref from a snapshot (expected e.g. g3e12)`);
    if (parsed.generation !== this.generation) {
      throw new StaleRef(`ref ${ref} is from an older snapshot (current is g${this.generation}) — take browser_snapshot again and use a fresh ref`);
    }
    return this.requirePage().locator(`aria-ref=${parsed.playwrightRef}`);
  }

  /** One ai-mode capture — the ONLY capture mode this class ever uses: a default-mode
   *  capture wipes Playwright's internal aria-ref map and the next ref-based act fails
   *  (probed live, 2026-07-19). Diff callers strip refs afterward instead. */
  private captureAi(page: Page, timeout: number): Promise<string> {
    return page.ariaSnapshot({ mode: 'ai', timeout });
  }

  /** Act, settle, and auto-return the before/after diff — the model never acts blind. */
  async act(input: BrowserActInput): Promise<BrowserResult> {
    await this.open();
    const page = this.requirePage();
    const beforeUrl = page.url();
    const before = await this.captureAi(page, config.browser.actTimeoutMs).then(stripForDiff).catch(() => '');
    try {
      await this.perform(page, input);
    } catch (err) {
      if (err instanceof StaleRef) return failure('stale_ref', err.message);
      if (input.verb === 'wait_for' && isTimeout(err)) {
        // M6 lesson: a wait_for timeout must return on-screen context, not a bare error.
        const now = await this.captureAi(page, 2000).then(stripForDiff).catch(() => '(page unreadable)');
        return failure('timeout', `Nothing matching role="${input.role}" name~"${input.name}" appeared within ${input.timeout_ms} ms. Current page (url: ${page.url()}):\n${capSnapshot(now, 4000)}`);
      }
      if (isTimeout(err) && input.ref) {
        // Distinguish "gone" from "present but not actionable" — a locator never says
        // not-found, it just times out waiting.
        const count = await this.locatorFor(input.ref).count().catch(() => -1);
        if (count === 0) {
          return failure('element_not_found', `The element for ref ${input.ref} is no longer on the page — take a fresh browser_snapshot.`);
        }
        return failure('timeout', `The element exists but never became actionable within ${input.timeout_ms} ms (covered, disabled, or off-screen). Try scrolling to it, or a different element.`);
      }
      return this.mapError(err, input.verb);
    }
    return this.settleAndDiff(page, before, beforeUrl);
  }

  private async perform(page: Page, input: BrowserActInput): Promise<void> {
    const { verb, ref, value } = input;
    const timeout = Math.min(input.timeout_ms, config.browser.actTimeoutMs);
    const need = (what: string): never => {
      throw new PageError(`${verb} needs a ${what}`);
    };
    switch (verb) {
      case 'click':
        return void (await (ref ? this.locatorFor(ref) : need('ref')).click({ timeout }));
      case 'fill':
        return void (await (ref ? this.locatorFor(ref) : need('ref')).fill(value ?? '', { timeout }));
      case 'type':
        return void (await (ref ? this.locatorFor(ref) : need('ref')).pressSequentially(value ?? need('value'), { timeout, delay: 15 }));
      case 'press':
        if (!value) need('value');
        return void (await (ref ? this.locatorFor(ref).press(value!, { timeout }) : page.keyboard.press(value!)));
      case 'select': {
        if (!value) need('value');
        const loc = ref ? this.locatorFor(ref) : need('ref');
        // Models copy the visible text — try the label first, then the value attribute.
        try {
          await loc.selectOption({ label: value! }, { timeout });
        } catch {
          await loc.selectOption(value!, { timeout: 2000 });
        }
        return;
      }
      case 'hover':
        return void (await (ref ? this.locatorFor(ref) : need('ref')).hover({ timeout }));
      case 'focus':
        return void (await (ref ? this.locatorFor(ref) : need('ref')).focus({ timeout }));
      case 'scroll':
        if (ref) return void (await this.locatorFor(ref).scrollIntoViewIfNeeded({ timeout }));
        return void (await page.keyboard.press(value === 'up' ? 'PageUp' : 'PageDown'));
      case 'wait_for': {
        if (!input.role) need('role (e.g. "button")');
        const target = page.getByRole(input.role as Parameters<Page['getByRole']>[0], input.name ? { name: input.name, exact: false } : {});
        return void (await target.first().waitFor({ state: 'visible', timeout: input.timeout_ms }));
      }
    }
  }

  /** Settle = wait out any started navigation, then poll the (ref-free) snapshot until
   *  two consecutive reads agree — the AX executor's debounced-signature idea. Then diff. */
  private async settleAndDiff(page: Page, before: string, beforeUrl: string): Promise<BrowserResult> {
    await page.waitForLoadState('load', { timeout: config.browser.settleTimeoutMs }).catch(() => {});
    const deadline = Date.now() + config.browser.settleTimeoutMs;
    let last: string | null = null;
    let after = '';
    let captured = false; // did ANY settle read succeed?
    do {
      try {
        const now = stripForDiff(await this.captureAi(page, config.browser.settleTimeoutMs));
        captured = true;
        if (last !== null && now === last) {
          after = now;
          break;
        }
        last = now;
        after = now;
      } catch {
        last = null; // mid-navigation captures throw — keep polling until the page exists
      }
      await new Promise((r) => setTimeout(r, config.browser.settlePollMs));
    } while (Date.now() < deadline);

    const notes: string[] = [];
    // A click that opened a tab/popup: switch to it — the task's attention follows the
    // page the site opened (login popups, target=_blank) — and say so explicitly.
    const opened = this.newPages.filter((p) => !p.isClosed());
    this.newPages = [];
    if (opened.length > 0) {
      this.activePage = opened[opened.length - 1];
      await this.activePage.waitForLoadState('load', { timeout: config.browser.settleTimeoutMs }).catch(() => {});
      notes.push(`a new tab opened and is now active: ${this.activePage.url()} — take browser_snapshot to see it`);
    } else if (page.url() !== beforeUrl) {
      notes.push(`url: ${beforeUrl} → ${page.url()}`);
    }

    // Never settled into a readable state (the page stayed mid-navigation the whole
    // window): diffing `before` against an empty `after` would render the entire page as
    // "removed", reading as "the page cleared" when it's just in flux (review 🔵). Report
    // the unsettled state instead and let the model re-snapshot.
    if (!captured) {
      const note = notes.length ? notes.map((n) => `~ ${n}`).join('\n') + '\n' : '';
      return { ok: true, output: `${note}~ the page is still loading — take browser_snapshot once it settles` };
    }

    const diff = diffSnapshots(before, after, config.browser.diffMaxLines);
    const noteText = notes.map((n) => `~ ${n}`).join('\n');
    if (!diff.changed && notes.length === 0) {
      return { ok: true, output: '(no observable change on the page)', no_change: true };
    }
    return { ok: true, output: [noteText, diff.text].filter(Boolean).join('\n') };
  }

  /** Navigate and return a FULL fresh snapshot — the model always re-orients after a
   *  page change anyway; folding it in saves a loop turn. */
  async navigate(url: string): Promise<BrowserResult> {
    await this.open();
    let page: Page;
    try {
      page = this.requirePage();
    } catch {
      this.activePage = await this.context!.newPage();
      page = this.activePage;
    }
    try {
      await page.goto(url, { waitUntil: 'load', timeout: config.browser.navTimeoutMs });
    } catch (err) {
      if (isTimeout(err)) {
        return failure('timeout', `The page did not finish loading within ${config.browser.navTimeoutMs} ms (url now: ${page.url()}). It may still be usable — take browser_snapshot to see what rendered.`);
      }
      return this.mapError(err, 'navigate');
    }
    return this.snapshot();
  }

  async back(): Promise<BrowserResult> {
    await this.open();
    const page = this.requirePage();
    try {
      await page.goBack({ waitUntil: 'load', timeout: config.browser.navTimeoutMs });
    } catch (err) {
      return this.mapError(err, 'back');
    }
    return this.snapshot();
  }

  async listTabs(): Promise<BrowserResult> {
    await this.open();
    const pages = this.context!.pages().filter((p) => !p.isClosed());
    const active = this.activePage;
    const lines = await Promise.all(
      pages.map(async (p, i) => `${i + 1}. ${p === active ? '[active] ' : ''}${p.url()} — ${await p.title().catch(() => '')}`),
    );
    return { ok: true, output: lines.join('\n') || '(no open tabs)' };
  }

  async switchTab(index: number): Promise<BrowserResult> {
    await this.open();
    const pages = this.context!.pages().filter((p) => !p.isClosed());
    const target = pages[index - 1];
    if (!target) return failure('element_not_found', `No tab ${index} — there are ${pages.length}.`);
    this.activePage = target;
    await target.bringToFront().catch(() => {});
    return this.snapshot();
  }

  /** Persist the context's storage state — cookies + localStorage, no passwords. Called
   *  at task end (and after a login handoff, Phase 3) so the NEXT run replays the session.
   *  Written temp-then-rename so a crash mid-capture can't truncate the live file (rename
   *  is atomic within a filesystem) — the read side (newContextRecovering) also self-heals,
   *  but not leaving a torn file is the belt to that suspenders (review 🟡). */
  async captureState(): Promise<void> {
    if (!this.context) return;
    mkdirSync(config.home.browser, { recursive: true });
    const tmp = stateFile() + `.tmp`;
    await this.context.storageState({ path: tmp });
    renameSync(tmp, stateFile());
  }

  /** Task teardown: capture-then-close the context; the browser process stays warm for
   *  the next task. Serialized with in-flight acts by Playwright itself (ops on a closed
   *  context reject typed, which the tool layer surfaces as an aborted-style error). */
  async closeTask(): Promise<void> {
    if (!this.context) return;
    await this.captureState().catch((err) => console.error('browser state capture failed:', err));
    await this.context.close().catch(() => {});
    this.context = null;
    this.activePage = null;
    this.newPages = [];
    this.generation += 1; // any ref the model still holds is now provably stale
    this.refs = new Map();
  }

  /** Daemon shutdown: best-effort close; Playwright's exit handlers reap the child too. */
  async shutdown(): Promise<void> {
    await this.closeTask().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }

  private mapError(err: unknown, what: string): BrowserResult {
    if (err instanceof StaleRef) return failure('stale_ref', err.message);
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    if (isTimeout(err)) return failure('timeout', `${what} timed out: ${msg}`);
    if (/closed|crashed|disconnected/i.test(msg)) {
      return failure('browser_unavailable', `The automation browser went away mid-${what} (${msg}). It relaunches on the next browser tool call.`);
    }
    return failure('page_error', `${what} failed: ${msg}`);
  }
}

class StaleRef extends Error {}
class PageError extends Error {}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

// One automation browser per daemon (there is one screen and one profile) — created
// lazily; nothing launches until a browser tool actually runs.
let singleton: BrowserClient | null = null;

export function getBrowserClient(): BrowserClient {
  return (singleton ??= new BrowserClient());
}

/** SIGTERM path — must not create the browser just to close it. */
export async function shutdownBrowser(): Promise<void> {
  await singleton?.shutdown();
}
