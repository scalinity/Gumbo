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

// Bash/osascript patterns that always confirm, checked before anything else. Patterns are
// `\b`-anchored (not head-of-token), so a directory prefix like /usr/bin/sudo still trips
// them — the basename bypass only ever threatened the delete lane (see commandName below).
const CONFIRM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/, reason: 'sudo' },
  // osascript's privilege-escalation form — the AppleScript equivalent of sudo.
  { pattern: /with\s+administrator\s+privileges/i, reason: 'administrator privileges' },
  // Sending data off the machine (uploads/POSTs) — plain downloads stay auto (mirrors the
  // supervisor's network-send rule).
  {
    pattern: /\b(curl|wget)\b[^|;&]*(\s-(d|F|T)\b|--data\b|--data-[a-z]+\b|--form\b|--upload-file\b|--post-[a-z]+\b|--body-[a-z]+\b|-X\s*(POST|PUT|PATCH|DELETE)\b)/i,
    reason: 'network send',
  },
  // GET-style exfil: a curl/wget/open whose URL/args carry a shell expansion ($VAR, `cmd`,
  // $(…)) can smuggle a secret into a query string — the channel the M4.1 egress proxy
  // closed for the sandboxed lane, which mac_do runs OUTSIDE. Plain `open URL` stays auto.
  { pattern: /\b(curl|wget|open)\b[^|;&]*[$`]/i, reason: 'possible data exfiltration (expanded URL)' },
  { pattern: /\bgit\b[^|;&]*\bpush\b/, reason: 'git push' },
  // Sending a message. The mail/sendmail CLIs send by default; app-driven sends (Messages
  // via AppleScript) are matched by `send` near a messaging noun in EITHER order — the old
  // pattern required a leading `mail|osascript` token, which the word "osascript" never
  // supplies when the script IS the osascript body.
  { pattern: /(^|[|;&]\s*)(mail|sendmail)\b/i, reason: 'sending mail' },
  { pattern: /\bsend\b[^|;&]*\b(message|buddy|chat|imessage|sms)\b|\b(message|buddy|chat|imessage|sms)\b[^|;&]*\bsend\b/i, reason: 'sending a message' },
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
  // `do shell script`, so this recurses at most one level.
  for (const m of script.matchAll(DO_SHELL_SCRIPT)) {
    const inner = macDoDecision(m[1]);
    if (inner.route === 'confirm') return { route: 'confirm', reason: `do shell script → ${inner.reason}` };
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
