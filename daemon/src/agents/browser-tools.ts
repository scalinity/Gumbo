import { tool } from '@openai/agents';
import { z } from 'zod';
import { auditMacAction } from '../mac/audit.ts';
import { hostAllowed, hostOf } from '../mac/hosts.ts';
import { browserActDecision } from '../mac/policy.ts';
import type { BrowserActInput, BrowserResult } from '../browser/client.ts';
import type { MacBridge } from '../ws/mac.ts';
import type { ConfirmScript, ToolObservation } from './mac-tools.ts';

/** The slice of BrowserClient the tools need — structural, so tests inject a plain fake
 *  (the same seam idea as mac-tools' fakeBridge). */
export interface BrowserSurface {
  snapshot(): Promise<BrowserResult>;
  act(input: BrowserActInput): Promise<BrowserResult>;
  navigate(url: string): Promise<BrowserResult>;
  back(): Promise<BrowserResult>;
  listTabs(): Promise<BrowserResult>;
  switchTab(index: number): Promise<BrowserResult>;
  refInfo(ref: string): { role: string; name: string | null } | null;
  /** M8 replay: taught {role,name} → current-generation ref (null = no unambiguous match). */
  findRef(role: string | null, name: string | null): string | null;
  formMethod(ref: string | null): Promise<string | null>;
  /** Deterministic script-side-effect signal for a ref (javascript: href, formaction,
   *  inline handler) — a short reason, or null for a plain control. */
  scriptedControl(ref: string): Promise<string | null>;
  currentUrl(): string | null;
  /** Global-screen center of a ref's element — the ghost cursor's target (null = don't fly). */
  screenPointForRef(ref: string): Promise<{ x: number; y: number } | null>;
}

/** Same presentation contract as the AX lane: raw output on success, the typed kind up
 *  front on failure so the model branches on kind, never message text. */
function present(result: BrowserResult): string {
  if (result.ok) return result.output || '(no output)';
  const hint = result.error_kind === 'stale_ref' || result.error_kind === 'element_not_found' ? ' — take browser_snapshot again for fresh refs' : '';
  return `Error (${result.error_kind ?? 'unknown'})${hint}: ${result.output}`;
}

// Sign-in-page detection for the handoff nudge: a path segment that IS a login keyword
// (never a substring — /blog/why-sso-matters must not match), or a hostname whose first
// label is one (accounts.google.com, login.microsoftonline.com).
const LOGIN_SEGMENT = /^\/(?:[^/]+\/)*(?:log[-_]?in|sign[-_]?in|sessions?|auth|authorize|oauth2?|sso|2fa|mfa|challenge)(?:\/|$)/i;
const LOGIN_HOST = /^(?:login|log-in|signin|sign-in|auth|sso|accounts?|id|identity)\./i;

/** Live failure 2026-07-20 (twice): the agent landed on GitHub's sign-in redirect and
 *  ENDED the task with "the user must sign in" — the system-prompt handoff rule alone did
 *  not fire. So the trigger rides the tool result itself, the same next-attention-point
 *  trick as steering and the stall notes: every result that carries a fresh full snapshot
 *  (goto / back / switch_tab / browser_snapshot) names the next move when the landed page
 *  is a sign-in page. Acts return diffs, not snapshots — the model re-snapshots and the
 *  nudge fires then. */
function loginNudge(url: string | null): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (!LOGIN_SEGMENT.test(u.pathname) && !LOGIN_HOST.test(u.hostname)) return '';
  } catch {
    return '';
  }
  return (
    "\n\nNOTE: this is a SIGN-IN page. Needing the user's identity is a handoff, not a dead end — " +
    'call request_handoff NOW (tell them exactly what to log into) and continue after they finish. ' +
    'Do NOT end the task over a login.'
  );
}

/**
 * M7 browser-lane toolset for the computer-use sub-agent. Mirrors the AX contracts —
 * snapshot→act→verify-by-diff, one-generation refs, typed errors, the same repetition +
 * no-change stall guards — over Gumbo's dedicated automation browser. Gates, all
 * confirm-through-the-notch, deny-safe:
 *   1. HOST: navigating to (or acting on a page of) a host outside the allowlist asks
 *      the user once per task (M4.1 egress posture, memoized).
 *   2. SUBMIT: send/submit/purchase-class acts ALWAYS confirm, allowlisted or not — site
 *      trust ≠ content trust (pages are the top injection vector).
 * Every act/navigation writes one mac-audit line carrying the page URL; observations
 * (snapshot, tab list) don't. All of it is sub-agent-only — the realtime registry never
 * sees these tools (tools.test.ts pins that).
 */
export function createBrowserTools(taskId: string, surface: BrowserSurface, signal: AbortSignal, confirmScript: ConfirmScript, macBridge?: MacBridge, observe?: (obs: ToolObservation) => void) {
  // Hosts the user approved for THIS task (deny is not memoized — they may change their mind).
  const approvedHosts = new Set<string>();
  let lastActKey = '';
  let repeatCount = 0;
  let noChangeStreak = 0;

  /** null = approved (or not a web host at all); otherwise the refusal message. The
   *  notch panel carries a "Remember <host>" toggle (rememberHost) — with it, approval
   *  writes through to the allowlist and the site never asks again. */
  async function ensureHostApproved(url: string | null, what: string): Promise<string | null> {
    if (!url) return null;
    const host = hostOf(url);
    if (!host || hostAllowed(url) || approvedHosts.has(host)) return null;
    const approved = await confirmScript(`${what} ${host} — allow this site for the current task?`, 'Open this website?', host);
    if (approved) {
      approvedHosts.add(host);
      return null;
    }
    auditMacAction({ tier: 'subagent', kind: 'browser', action: `${what} ${host}`, gate: 'declined', ok: false, error: 'unlisted host', taskId, url });
    observe?.({ tool: 'browser_host_gate', ok: false, declined: true });
    return `the user didn't approve using ${host} — use a different site or report you can't proceed.`;
  }

  const browserSnapshot = tool({
    name: 'browser_snapshot',
    description:
      'Read the automation browser\'s current page as an accessibility tree: url, title, and one line ' +
      'per element with a ref like g3e12. Refs are valid ONLY until the next snapshot or navigation — ' +
      'always snapshot before acting, and again after a stale_ref error. This is how you SEE a web ' +
      'page; take one first for any web task.',
    parameters: z.object({}),
    async execute() {
      if (signal.aborted) return 'Task was cancelled.';
      const result = await surface.snapshot();
      observe?.({ tool: 'browser_snapshot', ok: result.ok, errorKind: result.error_kind });
      return result.ok ? present(result) + loginNudge(surface.currentUrl()) : present(result);
    },
  });

  const browserAct = tool({
    name: 'browser_act',
    description:
      'Act on the automation browser page by ref (from the latest browser_snapshot). Verbs: click, ' +
      'fill (set a field\'s full value), type (keystrokes into the focused field — single line only), ' +
      'press (a key like "Enter", "Escape", "Control+a" — value holds the key, ref optional), select ' +
      '(a dropdown option by visible label), hover, focus, scroll (to a ref, or PageDown/PageUp with ' +
      'value "down"/"up"), wait_for (block until an element with role+name appears). Returns a ' +
      'before/after DIFF of the page — read it to verify the step worked; an empty diff means nothing ' +
      'changed, DO NOT assume success. Sending/submitting/purchasing asks the user first.',
    parameters: z.object({
      verb: z.enum(['click', 'fill', 'type', 'press', 'select', 'hover', 'focus', 'scroll', 'wait_for']),
      ref: z.string().nullable().describe('Element ref from browser_snapshot (e.g. g3e12); null for press/scroll/wait_for'),
      value: z.string().nullable().describe('Text for fill/type, the key for press, option label for select, "down"/"up" for scroll'),
      role: z.string().nullable().describe('wait_for: the role to wait for (e.g. "button")'),
      name: z.string().nullable().describe('wait_for: substring of the accessible name'),
      timeout_ms: z.number().int().min(100).max(30_000).default(5000),
    }),
    async execute({ verb, ref, value, role, name, timeout_ms }) {
      if (signal.aborted) return 'Task was cancelled.';
      // Repetition guard — same shape as the AX lane's (a top-4 computer-use failure class).
      const key = `${verb}:${ref ?? role ?? ''}:${value ?? name ?? ''}`;
      repeatCount = key === lastActKey ? repeatCount + 1 : 0;
      lastActKey = key;
      if (repeatCount >= 2) {
        repeatCount = 0;
        return `You have repeated "${verb}" on the same target 3 times with no progress. Take a fresh browser_snapshot and try a different approach (a different element, browser_navigate, or report the site can't be driven).`;
      }
      // Newline typing would press Enter mid-string — an ungated submit. fill covers
      // multiline text (it sets the value without keystrokes); Enter is an explicit press.
      if (verb === 'type' && /[\r\n]/.test(value ?? '')) {
        return 'type is single-line only: use fill for multiline text, and press with value "Enter" to submit (that may ask the user).';
      }
      // Acting on a page IS using its site — same gate as navigating to it (a link click
      // can land anywhere; the next act re-checks the host it landed on).
      const refusal = await ensureHostApproved(surface.currentUrl(), 'The task wants to act on');
      if (refusal) return refusal;

      // Submit/purchase gate: decided on the role+name the model SAW in the snapshot,
      // plus the enclosing form's method for the ambiguous cases. `select` is included so
      // the POST-form dropdown rule in browserActDecision is actually REACHABLE — without
      // it, formMethod was never fetched for a select and that gate branch was dead code
      // (second-review 🟡).
      const info = ref ? surface.refInfo(ref) : null;
      const needsForm = verb === 'click' || verb === 'select' || (verb === 'press' && /\benter\b/i.test(value ?? ''));
      const formMethod = needsForm ? await surface.formMethod(ref) : null;
      // Deterministic scripted-control read (javascript: href / formaction / inline
      // handler): an innocuous name on an attribute-scripted control still confirms.
      const scripted = verb === 'click' && ref ? await surface.scriptedControl(ref) : null;
      const decision = browserActDecision({ verb, role: info?.role, name: info?.name, formMethod, chord: value, scripted });
      let gate: 'auto' | 'confirmed' = 'auto';
      const url = surface.currentUrl() ?? undefined;
      if (decision.route === 'confirm') {
        const approved = await confirmScript(`${decision.reason} on ${hostOf(url ?? '') ?? 'this page'}`, 'Allow this browser action?');
        if (!approved) {
          auditMacAction({ tier: 'subagent', kind: 'browser', action: `${verb} ${info?.name ?? ref ?? ''}`.trim(), gate: 'declined', ok: false, error: decision.reason, taskId, url });
          observe?.({ tool: 'browser_act', ok: false, declined: true });
          return `the user didn't approve that (${decision.reason}) — try another approach or skip it.`;
        }
        gate = 'confirmed';
      }

      // Cursor continuity (pure visualization): in-page acts ride CDP — no HID at all — so
      // fly the ghost to the element first. Resolve the point BEFORE the act so the two
      // don't race the same page's ref state (review 🔵); the fire-and-forget cursor RPC
      // still never delays the act.
      if (ref && macBridge) {
        const pt = await surface.screenPointForRef(ref).catch(() => null);
        if (pt) void macBridge.request({ kind: 'cursor_to', x: pt.x, y: pt.y }, { timeoutMs: 2000 });
      }
      const result = await surface.act({ verb, ref, value, role, name, timeout_ms });
      auditMacAction({ tier: 'subagent', kind: 'browser', action: `${verb} ${info?.name ?? ref ?? role ?? ''}`.trim(), gate, ok: result.ok, error: result.ok ? undefined : result.error_kind, taskId, url });
      observe?.({ tool: 'browser_act', ok: result.ok, errorKind: result.error_kind, noChange: result.no_change === true });
      const stalled = result.ok && result.no_change === true;
      noChangeStreak = stalled ? noChangeStreak + 1 : 0;
      if (noChangeStreak >= 3) {
        noChangeStreak = 0;
        return (
          present(result) +
          '\n\nNOTE: your last 3 actions all produced no observable change — you are not making progress. ' +
          'Take a fresh browser_snapshot and switch strategy; if the site blocks automation, stop and report that instead of continuing to try.'
        );
      }
      return present(result);
    },
  });

  const browserNavigate = tool({
    name: 'browser_navigate',
    description:
      'Drive the automation browser between pages: goto a URL directly (never type URLs into address ' +
      'bars), go back, list open tabs, or switch to a tab. goto/switch return a fresh snapshot of the ' +
      'new page. Visiting a site the user hasn\'t approved asks them first.',
    parameters: z.object({
      action: z.enum(['goto', 'back', 'list_tabs', 'switch_tab']),
      url: z.string().nullable().describe('goto: the full URL (https://…)'),
      tab: z.number().int().min(1).nullable().describe('switch_tab: the tab number from list_tabs'),
    }),
    async execute({ action, url, tab }) {
      if (signal.aborted) return 'Task was cancelled.';
      switch (action) {
        case 'goto': {
          if (!url) return 'goto needs a url.';
          if (!/^https?:\/\//i.test(url)) return 'goto takes a full http(s):// URL.';
          const refusal = await ensureHostApproved(url, 'The task wants to open');
          if (refusal) return refusal;
          const result = await surface.navigate(url);
          auditMacAction({ tier: 'subagent', kind: 'browser', action: `goto ${url}`, gate: 'auto', ok: result.ok, error: result.ok ? undefined : result.error_kind, taskId, url });
          observe?.({ tool: 'browser_navigate', ok: result.ok, errorKind: result.error_kind });
          // Nudge on the LANDED url (currentUrl), not the requested one — the login case
          // is usually a redirect away from what the model asked for.
          return result.ok ? present(result) + loginNudge(surface.currentUrl()) : present(result);
        }
        case 'back': {
          const result = await surface.back();
          auditMacAction({ tier: 'subagent', kind: 'browser', action: 'back', gate: 'auto', ok: result.ok, error: result.ok ? undefined : result.error_kind, taskId, url: surface.currentUrl() ?? undefined });
          return result.ok ? present(result) + loginNudge(surface.currentUrl()) : present(result);
        }
        case 'list_tabs':
          return present(await surface.listTabs());
        case 'switch_tab': {
          // Re-orients the task onto a different page — audit it with the URL it lands on,
          // like goto/back (review 🔵: switch_tab was the one navigation that was silent).
          const result = await surface.switchTab(tab ?? 1);
          auditMacAction({ tier: 'subagent', kind: 'browser', action: `switch_tab ${tab ?? 1}`, gate: 'auto', ok: result.ok, error: result.ok ? undefined : result.error_kind, taskId, url: surface.currentUrl() ?? undefined });
          return result.ok ? present(result) + loginNudge(surface.currentUrl()) : present(result);
        }
      }
    },
  });

  return [browserSnapshot, browserAct, browserNavigate];
}
