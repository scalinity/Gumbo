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

// Bash/osascript patterns that always confirm, checked before anything else.
const CONFIRM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/, reason: 'sudo' },
  // Sending data off the machine (uploads/POSTs) — plain downloads stay auto (mirrors the
  // supervisor's network-send rule).
  {
    pattern: /\b(curl|wget)\b[^|;&]*(\s-(d|F|T)\b|--data\b|--data-[a-z]+\b|--form\b|--upload-file\b|--post-[a-z]+\b|--body-[a-z]+\b|-X\s*(POST|PUT|PATCH|DELETE)\b)/i,
    reason: 'network send',
  },
  { pattern: /\bgit\b[^|;&]*\bpush\b/, reason: 'git push' },
  { pattern: /\b(mail|sendmail|osascript)\b[^|;&]*\bsend\b/i, reason: 'sending a message' },
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

/** A delete whose target isn't provably inside a safe root → confirm. Conservative by
 *  design: an unresolvable target (shell expansion, stdin-fed xargs) confirms. */
function riskyDelete(command: string): string | null {
  const roots = safeRoots();
  for (const segment of command.split(/\|\||&&|;|\|/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const head = unquote(tokens[0]);

    if (head === 'xargs') {
      if (tokens.slice(1).some((t) => DELETE_COMMANDS.has(unquote(t)))) return 'xargs delete (targets from stdin)';
      continue;
    }

    const idx = tokens.findIndex((t) => DELETE_COMMANDS.has(unquote(t)));
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
  const badDelete = riskyDelete(script);
  if (badDelete) return { route: 'confirm', reason: `delete outside safe dirs (${badDelete})` };
  return { route: 'auto', reason: 'read-only / reversible command' };
}

/** One short human line for the notch confirm ("Run: sudo …"). */
export function describeMacDo(script: string): string {
  const text = script.replace(/\s+/g, ' ').trim();
  return text.length > 120 ? text.slice(0, 117) + '…' : text;
}
