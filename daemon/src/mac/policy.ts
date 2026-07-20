import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { config } from '../config.ts';
import { hostAllowed, hostOf } from './hosts.ts';

/** Where a mac_do decision lands. 'auto' runs unreviewed; 'confirm' routes to the notch. */
export type MacRoute = 'auto' | 'confirm';
export interface MacPolicyResult {
  route: MacRoute;
  reason: string;
}

/**
 * M6 hot-path gate for mac_do, in the M4 supervisor spirit: a PURE table (no model, no
 * I/O) decides auto-run vs notch-confirm. Unlike the Claude supervisor there is no session
 * cwd — mac_do is the user's own voice one-shot — so the boundary for deletes is the agent
 * home + the OS temp dir; everything else escalates. This list can't be an exhaustive
 * shell parser (an obfuscated `nc`/`python` could slip through — the same accepted ceiling
 * as auto mode), but it must not be trivially evaded on the patterns it names. The gate +
 * the mac-audit.jsonl line ARE the mitigation for running outside the Seatbelt (the user,
 * 2026-07-16).
 */

// Bash/osascript patterns that always confirm, checked before anything else. Most are
// `\b`-anchored (not head-of-token), so a directory prefix like /usr/bin/sudo still trips
// them; the command-position patterns (mail) carry their own path-prefix tolerance. Scoped
// patterns use [^|;&\n]* so a match never spans into an unrelated command on another line
// (review 🔵: \n was over-matching; review 🔴: \n was UNDER-anchoring the mail pattern).
// The v1 LITERAL-URL RESIDUAL is now CLOSED for the sub-agent lane (M7): gateScript runs
// every literal fetch/open URL through the host allowlist (mac/hosts.ts) — an unlisted
// host confirms, exactly the M4.1 egress-proxy posture. The HOT lane stays ungated there
// by design: its script transcribes the user's own spoken words and has no screen-read
// context to exfiltrate (the same trust split as the shortcuts lane below).
const CONFIRM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/, reason: 'sudo' },
  // osascript's privilege-escalation form — the AppleScript equivalent of sudo.
  { pattern: /with\s+administrator\s+privileges/i, reason: 'administrator privileges' },
  // Reading a secret store: the env strip keeps keys out of the child process, but a
  // read-only `cat .env` would return them into the voice model's context anyway (the
  // daemon and its bash children run UNSANDBOXED — no Seatbelt backstop on this lane).
  // Same protected set the M4 supervisor guards for Claude sessions. Gumbo/browser holds
  // the automation profile's storage state — live session cookies (M7).
  { pattern: /\.env\b|\/\.(ssh|aws|npmrc)\b|~\/\.(ssh|aws|npmrc|config\/gh)\b|Gumbo\/browser\b/i, reason: 'reading a secret store' },
  // Sending data off the machine (uploads/POSTs) — plain downloads stay auto (mirrors the
  // supervisor's network-send rule).
  {
    pattern: /\b(curl|wget)\b[^|;&\n]*(\s-(d|F|T)\b|--data\b|--data-[a-z]+\b|--form\b|--upload-file\b|--post-[a-z]+\b|--body-[a-z]+\b|-X\s*(POST|PUT|PATCH|DELETE)\b)/i,
    reason: 'network send',
  },
  // GET-style exfil: a curl/wget/open whose URL/args carry a shell expansion ($VAR, `cmd`,
  // $(…)) can smuggle a secret into a query string — the channel the M4.1 egress proxy
  // closed for the sandboxed lane, which mac_do runs OUTSIDE. Plain `open URL` stays auto
  // (see the literal-URL residual note above). xargs-fed fetchers get their payload from
  // stdin — equally unresolvable, so they confirm too (review 🟡).
  { pattern: /\b(curl|wget|open)\b[^|;&\n]*[$`]/i, reason: 'possible data exfiltration (expanded URL)' },
  { pattern: /\bxargs\b[^|;&\n]*\b(curl|wget|open)\b/i, reason: 'possible data exfiltration (piped fetch)' },
  { pattern: /\bgit\b[^|;&\n]*\bpush\b/, reason: 'git push' },
  // Sending mail: command-position mail/sendmail on ANY separator — including newline,
  // the same separator set riskyDelete splits on (review 🔴: omitting \n let a multiline
  // script bury a `mail` line) — with optional path prefix (/usr/bin/mail) and
  // alias-busting backslash, mirroring commandName's delete-lane normalization.
  { pattern: /(^|[|;&\n\r]\s*)(?:[^\s|;&\n]*\/)?\\?(mail|sendmail)\b/i, reason: 'sending mail' },
  // App-driven sends (Messages/Mail via AppleScript): `send` near a messaging noun in
  // EITHER order. `mail` in the noun list restores the old \bmail\b coverage of
  // `tell application "Mail" to send …` (review 🔴 regression); `participant` is the
  // modern Messages dictionary target (review 🟡).
  { pattern: /\bsend\b[^|;&\n]*\b(message|buddy|chat|imessage|sms|participant|mail)\b|\b(message|buddy|chat|imessage|sms|participant|mail)\b[^|;&\n]*\bsend\b/i, reason: 'sending a message' },
  // `defaults write` mutates system/app prefs; `defaults read` stays auto.
  { pattern: /\bdefaults\s+write\b/, reason: 'writing system defaults' },
  { pattern: /\b(killall|pkill|kill)\b/, reason: 'force-quitting a process' },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b/, reason: 'power state change' },
  // osascript that deletes, empties trash, or quits an app (which can drop unsaved work).
  { pattern: /\b(delete|empty\s+trash|quit\s+(app|application))\b/i, reason: 'destructive app action' },
  // Disk / filesystem mutation utilities.
  { pattern: /\b(diskutil|dd|mkfs|fdisk)\b/, reason: 'disk operation' },
];

const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash']);
// $VAR / ${…} / $(…) / backticks — a target with these can't be resolved statically, so we
// can't prove where it lands: confirm rather than guess (the supervisor's CA1 bypass).
const SHELL_EXPANSION = /[$`]/;
// AppleScript can shell out — gate the INNER command of `do shell script "…"` too.
const DO_SHELL_SCRIPT = /do\s+shell\s+script\s+"([^"]*)"/gi;

// The only directories a delete may auto-run against: the agent home and the OS temp dir.
function safeRoots(): string[] {
  const roots = [config.agentHome, process.env.TMPDIR, '/tmp'].filter(Boolean) as string[];
  return roots.map((r) => resolve(r.replace(/\/+$/, '')));
}

function underAnyRoot(path: string, roots: string[]): boolean {
  const abs = resolve(path.startsWith('~') ? homedir() + path.slice(1) : path);
  return roots.some((root) => abs === root || abs.startsWith(root + sep));
}

function unquote(token: string): string {
  return token.replace(/^['"]|['"]$/g, '');
}

/** Collapse a command token to its bare program name so a full path (`/bin/rm`) or an
 *  alias-busting leading backslash (`\rm`) can't slip a delete past the basename check.
 *  Only for the COMMAND slot — target paths must keep their directory. */
function commandName(token: string): string {
  const bare = unquote(token).replace(/^\\/, '');
  const slash = bare.lastIndexOf('/');
  return slash === -1 ? bare : bare.slice(slash + 1);
}

/** A delete whose target isn't provably inside a safe root → confirm. Conservative by
 *  design: an unresolvable target (shell expansion, stdin-fed xargs) confirms. */
function riskyDelete(command: string): string | null {
  const roots = safeRoots();
  // Split on every command separator INCLUDING newline and single `&` (background) so each
  // command is analyzed on its own — a multi-line script isn't one giant segment.
  for (const segment of command.split(/\|\||&&|[;|&\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const head = commandName(tokens[0]);

    if (head === 'xargs') {
      if (tokens.slice(1).some((t) => DELETE_COMMANDS.has(commandName(t)))) return 'xargs delete (targets from stdin)';
      continue;
    }

    const idx = tokens.findIndex((t) => DELETE_COMMANDS.has(commandName(t)));
    if (idx === -1) continue;
    let sawTarget = false;
    for (const raw of tokens.slice(idx + 1)) {
      if (raw.startsWith('-')) continue; // a flag, not a path
      sawTarget = true;
      const target = unquote(raw);
      if (SHELL_EXPANSION.test(target) || target.startsWith('~') || !underAnyRoot(target, roots)) {
        return target;
      }
    }
    // `rm` with no resolvable path operand (only flags, or targets from a pipe) → confirm.
    if (!sawTarget) return 'delete with no explicit path';
  }
  return null;
}

/** Pure policy table for a mac_do script — exported for offline unit tests. */
export function macDoDecision(script: string): MacPolicyResult {
  for (const { pattern, reason } of CONFIRM_PATTERNS) {
    if (pattern.test(script)) return { route: 'confirm', reason };
  }
  // AppleScript that shells out (`do shell script "<cmd>"`) hides bash from the patterns
  // above — gate the inner command with the same table. The inner command has no nested
  // `do shell script` (its quotes would need escaping the capture can't span), so this
  // recurses at most one level.
  for (const m of script.matchAll(DO_SHELL_SCRIPT)) {
    const inner = macDoDecision(m[1]);
    if (inner.route === 'confirm') return { route: 'confirm', reason: `do shell script → ${inner.reason}` };
  }
  // A shell-out we can't statically read — a variable body (`do shell script cmd`) or a
  // concatenated literal (`do shell script "r" & "m -rf …"`) — can't be gated: confirm
  // rather than guess, the same stance SHELL_EXPANSION takes in the delete lane (review 🟡:
  // concatenation split the risky token across fragments and slipped the whole table).
  const shellOuts = [...script.matchAll(/do\s+shell\s+script/gi)].length;
  const literalShellOuts = [...script.matchAll(/do\s+shell\s+script\s+"([^"]*)"(?!\s*&)/gi)].length;
  if (shellOuts > literalShellOuts) {
    return { route: 'confirm', reason: 'unresolvable shell-out (do shell script)' };
  }
  const badDelete = riskyDelete(script);
  if (badDelete) return { route: 'confirm', reason: `delete outside safe dirs (${badDelete})` };
  return { route: 'auto', reason: 'read-only / reversible command' };
}

/** One short human line for the notch confirm. The risky-class reason (which carries the
 *  operative token — e.g. the resolved delete target) is prepended by the caller, so this
 *  just needs enough of the script to be recognizable. */
export function describeMacDo(script: string): string {
  const text = script.replace(/\s+/g, ' ').trim();
  return text.length > 160 ? text.slice(0, 157) + '…' : text;
}

/** The model sometimes double-wraps: interpreter 'osascript' AND a script of
 *  `osascript -e '…'` — which then fails as AppleScript (live demo, 2026-07-16). Unwrap the
 *  `-e` bodies into plain AppleScript source. Anything else passes through untouched.
 *  KNOWN LIMIT: a `-e` body with escaped/mixed quotes gets truncated at the first inner
 *  quote — that's SAFE because gate and executor both receive the same mangled string (the
 *  script just fails to run); it can never make the gate see less than the executor runs. */
export function normalizeOsascript(script: string): string {
  const trimmed = script.trim();
  const unwrapped = /^osascript\b/.test(trimmed)
    ? (() => {
        const bodies = [...trimmed.matchAll(/-e\s+(?:'([^']*)'|"([^"]*)")/g)]
          .map((m) => m[1] ?? m[2])
          .filter((b) => b !== undefined && b !== '');
        return bodies.length > 0 ? bodies.join('\n') : trimmed;
      })()
    : trimmed;
  // Fold AppleScript line continuations (`¬` at end of line) into a single statement so an
  // evasion can't split a concatenation onto the next physical line, AND so a clean
  // `open location ¬\n "https://unlisted"` still reaches the host check as one fetchy
  // segment (second-review 🔴 — folding must happen at NORMALIZE so both extractFetchUrls
  // and unresolvableNavTarget see it; `¬` is semantically a space to the executor, so the
  // gate and the executed string stay identical). Safe: `¬` never appears mid-URL.
  return foldContinuations(unwrapped);
}

/** Fold AppleScript `¬` end-of-line continuations to a single space. */
function foldContinuations(s: string): string {
  return s.replace(/¬[^\S\n]*\r?\n/g, ' ');
}

// M7 literal-URL host gate: URLs a script would FETCH OR OPEN (open/curl/wget/`open
// location` segments, plus AppleScript `URL:` property-list + `set [the] URL of … to`
// navigation). Trailing quote/punctuation is trimmed so `open location "https://x.com/a"`
// yields the bare URL. `URL` is a fetchy word (review 🟡) so `{URL:"…"}` and `set URL of
// tab 1 to "…"` get host-checked, not just `open location`.
// RESIDUAL (honest, second-review 🟡): because `url` is a fetchy word, a segment that
// merely NAMES a url in text — `display dialog "URL: https://example.com"` — now host-
// checks that literal and CONFIRMS an unlisted host where it used to auto-run. That's the
// safe direction (over-confirm on a rare dialog, one extra tap), not a hole; the earlier
// "a URL echoed in a dialog doesn't trip it" claim no longer holds and is removed.
const URL_LITERAL = /https?:\/\/[^\s"'`]+/gi;
const FETCHY_SEGMENT = /\b(open|curl|wget|location|url)\b/i;

/** Literal URLs in fetch/open positions, per command segment (same separator set the
 *  delete lane splits on, so a URL can't hide behind `;` or a newline). */
export function extractFetchUrls(script: string): string[] {
  const urls: string[] = [];
  for (const segment of script.split(/\|\||&&|[;|&\n]/)) {
    if (!FETCHY_SEGMENT.test(segment)) continue;
    for (const m of segment.matchAll(URL_LITERAL)) {
      urls.push(m[0].replace(/[)\].,;]+$/, ''));
    }
  }
  return urls;
}

// AppleScript URL navigation: `open location`, `set [the] URL of … to`, and `{… URL: …}`
// property lists. A target that is a bare variable (`open location u`) or built by `&`
// concatenation (`open location "https://ok" & "@evil.com/x"`) can't be host-checked
// statically — the executor concatenates/resolves it at runtime while the gate sees only
// a fragment (the SAME class the do-shell-script guard closes for bash). `URL:` is scoped
// to property-list position (`{`/`,` before it) so a dialog string mentioning "URL:"
// doesn't trip it. The optional definite article (`set THE url of …`) is idiomatic Safari/
// Chrome AppleScript — omitting it reopened the concatenation exfil on an articled form
// (second-review 🔴, the M6 "one-word variant reopens the gate" class).
const NAV_VERB = /\bopen\s+location\b|\bset\s+(?:the\s+)?url\b[^\n]*?\bto\b|[{,]\s*url\s*:/gi;
// AppleScript that runs JS IN a page (`do JavaScript`/`execute javascript`) can navigate
// or fetch from inside the DOM; its JS body is opaque to any host check, so it is always
// unresolvable → confirm (second-review 🔴 — it was covered by no gate list at all).
const JS_IN_PAGE = /\b(?:do\s+javascript|execute\s+javascript)\b/i;

/** True when a script performs URL navigation the host check can't resolve — in-page JS,
 *  or a nav verb whose target is a bare variable or a `&` concatenation. Such a script
 *  confirms as unresolvable (the SHELL_EXPANSION stance), closing the concatenation/
 *  indirection exfil bypass the literal-only host check misses. Clean single-literal
 *  targets fall through to the host allowlist via extractFetchUrls.
 *
 *  Robustness (second-review 🔴, corroborated by both reviewers): rather than parse the
 *  exact target (brittle — the article `the`, a `¬` line-continuation, or a comment between
 *  the literal and the `&` each dodged an exact parse), fold continuations first and treat
 *  ANY `&` in the nav STATEMENT as runtime-built → confirm. `&` inside the target literal
 *  is excluded (we look only AFTER the literal's closing quote). Folds internally too so a
 *  direct caller (tests) is covered even without going through normalizeOsascript. */
export function unresolvableNavTarget(script: string): boolean {
  const s = foldContinuations(script);
  if (JS_IN_PAGE.test(s)) return true;
  for (const m of s.matchAll(NAV_VERB)) {
    const rest = s.slice(m.index! + m[0].length).replace(/^\s+/, '');
    const literal = /^"[^"]*"/.exec(rest);
    if (!literal) return true; // bare variable target (`open location u`)
    // ANY concatenation in the remainder of THIS statement = target built at runtime.
    const stmt = rest.slice(literal[0].length).split(/[\n;]/, 1)[0];
    if (stmt.includes('&')) return true;
  }
  return false;
}

/** ONE choke point for both script lanes (hot mac_do + sub-agent run_script): normalize
 *  first, then decide on the SAME string the executor will run (review 🟡: the two lanes
 *  each did this independently and had already drifted). Shortcuts are opaque to the
 *  pattern table, so the LANE decides: the hot lane auto-runs them (the user spoke the
 *  shortcut's name himself); the sub-agent lane confirms them (it acts on untrusted
 *  on-screen text, and a named Shortcut can be arbitrarily destructive).
 *
 *  M7: the sub-agent lane additionally runs literal fetch/open URLs through the host
 *  allowlist — an unlisted host confirms, closing the recorded literal-URL exfil
 *  residual — AND confirms any URL navigation whose target is built by concatenation or a
 *  variable (unresolvableNavTarget), which the literal-only check would otherwise miss.
 *  The hot lane is exempt (the user spoke the URL himself; no screen-read context exists
 *  there to exfiltrate). `isHostAllowed` is injectable for offline tests and defaults to
 *  the real allowlist. */
export function gateScript(
  interpreter: 'bash' | 'osascript' | 'shortcuts',
  raw: string,
  lane: 'hot' | 'subagent',
  isHostAllowed: (url: string) => boolean = hostAllowed,
): { script: string; decision: MacPolicyResult } {
  const script = interpreter === 'osascript' ? normalizeOsascript(raw) : raw.trim();
  if (interpreter === 'shortcuts') {
    return {
      script,
      decision:
        lane === 'subagent'
          ? { route: 'confirm', reason: 'running a Shortcut' }
          : { route: 'auto', reason: 'shortcut named by the user' },
    };
  }
  const decision = macDoDecision(script);
  if (decision.route === 'confirm' || lane === 'hot') return { script, decision };
  // Unresolvable navigation targets (concatenation / variable) can't be host-checked —
  // confirm before the literal check even looks.
  if (unresolvableNavTarget(script)) {
    return { script, decision: { route: 'confirm', reason: 'opening an unresolvable URL (built at runtime)' } };
  }
  for (const url of extractFetchUrls(script)) {
    if (!isHostAllowed(url)) {
      return { script, decision: { route: 'confirm', reason: `opening an unlisted website (${hostOf(url) ?? 'unparseable URL'})` } };
    }
  }
  return { script, decision };
}

// M7 browser lane: send/submit/purchase ALWAYS confirms — an allowlisted SITE is not
// trusted CONTENT (pages are the top injection vector). The lexicon is deliberately the
// consequential/outbound classes; a false positive confirms, which is the safe direction.
const SUBMIT_NAME = /\b(send|submit|buy|purchase|pay|order|checkout|post|publish|tweet|reply|apply|book|donate|transfer|delete|confirm)\b/i;

/** Normalize an accessible name before the lexicon test: NFKC folds fullwidth/compatibility
 *  forms, and stripping zero-width + collapsing whitespace defeats `S​e​n​d`-style padding
 *  evasion (review 🟡). NOTE the residual, honestly: this does NOT fold cross-script
 *  homoglyphs (Cyrillic "Ѕend"), and it cannot see a consequential JS `onclick` on an
 *  innocuously-named control OUTSIDE a <form> — those are the documented ceiling of a
 *  name/form heuristic. The mitigations are the untrusted-screen-text rule in the loop
 *  instructions and that the model has no incentive to disguise its own actions. */
function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[​‌‍﻿]/g, '') // zero-width space / ZWNJ / ZWJ / BOM
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pure decision for one in-page browser action. Inputs are deterministic facts the
 *  browser layer read itself: the element's role+accessible name AS THE MODEL SAW THEM
 *  in the snapshot, and the enclosing <form>'s method when one exists. GET forms (search
 *  boxes) stay auto; POST forms submit data, so a button click, a `select` change, or an
 *  Enter press inside one confirms even when the control's name dodges the lexicon. */
export function browserActDecision(act: {
  verb: string;
  role?: string | null;
  name?: string | null;
  formMethod?: string | null;
  chord?: string | null;
}): MacPolicyResult {
  const method = (act.formMethod ?? '').toLowerCase();
  if (act.verb === 'click') {
    if (act.name && SUBMIT_NAME.test(normalizeName(act.name))) {
      return { route: 'confirm', reason: `clicking "${act.name}"` };
    }
    if (method === 'post' && act.role === 'button') {
      return { route: 'confirm', reason: 'submitting a form' };
    }
  }
  // A dropdown change inside a POST form can trigger an onchange submit/navigation — same
  // consequential class as the button (review 🟡: select was unconditionally auto).
  if (act.verb === 'select' && method === 'post') {
    return { route: 'confirm', reason: 'changing a selection in a form that submits' };
  }
  if (act.verb === 'press' && /\benter\b/i.test(act.chord ?? '') && method === 'post') {
    return { route: 'confirm', reason: 'pressing Enter in a form that submits' };
  }
  return { route: 'auto', reason: 'free navigation/typing' };
}
