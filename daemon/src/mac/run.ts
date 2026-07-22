import { execFile } from 'node:child_process';
import { config } from '../config.ts';
import { auditMacAction } from './audit.ts';
import { gateScript, describeMacDo } from './policy.ts';
import type { MacBridge } from '../ws/mac.ts';

/** No daemon-held secret may reach a spawned subprocess (config.ts). mac_do is the
 *  model-authored bash sink, so it gets a minimal ALLOWLISTED environment rather than a
 *  denylist strip — a denylist only covers the keys it names, and `mac_do("printenv")`
 *  would echo every unlisted credential (GITHUB_TOKEN, AWS_*, …) back into the realtime
 *  context. The child is a login shell (-lc), so the user's profile re-creates its own
 *  PATH/exports anyway; only the bootstrap vars are passed through. */
const ENV_ALLOWLIST = ['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM'];
/** Exported for offline unit tests. */
export function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (ENV_ALLOWLIST.includes(key) || key === 'LANG' || key.startsWith('LC_')) env[key] = process.env[key];
  }
  return env;
}

export type MacInterpreter = 'bash' | 'osascript' | 'shortcuts';

interface BashResult {
  ok: boolean;
  output: string;
  errorKind?: string;
}

/** Daemon-side bash for no-TCC commands (open, defaults read, tmutil). The daemon runs
 *  UNSANDBOXED (only the Claude CLI is Seatbelt-wrapped), so this is the right home for
 *  `open -a Chrome` — no TCC attribution needed, sub-second. Hard timeout: a voice turn
 *  is waiting, and a hung child must never wedge it. Injectable so tests don't shell out. */
function runBashDaemonSide(script: string, timeoutMs: number): Promise<BashResult> {
  return new Promise((resolvePromise) => {
    execFile('/bin/bash', ['-lc', script], { timeout: timeoutMs, maxBuffer: config.mac.outputMaxChars, env: minimalEnv() }, (err, stdout, stderr) => {
      const output = (String(stdout ?? '') + String(stderr ?? '')).trim();
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // maxBuffer overflow vs real timeout: on Node 26 overflow raises
        // ERR_CHILD_PROCESS_STDIO_MAXBUFFER (stdout AND stderr, killed=undefined) while a
        // timeout has code null + killed=true — but older/newer Nodes have used per-stream
        // *_MAXBUFFER_EXCEEDED codes and set killed on overflow, so match the family
        // (review 🟡: the previous exact-string check missed the real constant = dead branch).
        const overflow = typeof code === 'string' && code.startsWith('ERR_CHILD_PROCESS_') && code.includes('MAXBUFFER');
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed && !overflow;
        resolvePromise({
          ok: false,
          output: output || (overflow ? 'Output exceeded the size limit.' : killed ? `Timed out after ${timeoutMs} ms.` : String(err)),
          errorKind: killed ? 'timeout' : 'script_error',
        });
      } else {
        resolvePromise({ ok: true, output });
      }
    });
  });
}

/** The two idioms the model uses to OPEN/FOCUS an app, alone (no URL, no other verb).
 *  Routed to the shell's fuzzy resolver so an approximate name ("ChatGPT" →
 *  "ChatGPT Classic") resolves and the app launches if needed — raw `tell application` /
 *  `open -a` need a near-exact name. A non-matching script runs verbatim (no regression). */
export function pureAppOpenTarget(script: string, interpreter: MacInterpreter): string | null {
  const s = script.trim();
  if (interpreter === 'osascript') {
    const m = /^tell application "([^"]+)" to activate$/i.exec(s);
    return m ? m[1].trim() : null;
  }
  if (interpreter === 'bash') {
    const m = /^open\s+-a\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i.exec(s);
    return m ? (m[1] ?? m[2] ?? m[3]).trim() : null;
  }
  return null;
}

export interface MacDoDeps {
  macBridge: Pick<MacBridge, 'request'>;
  /** Notch confirm for a risky script; resolves false on deny/timeout (fail safe). */
  confirm: (detail: string) => Promise<boolean>;
  /** Injectable bash executor (real one by default) so unit tests never touch the shell. */
  runBash?: (script: string, timeoutMs: number) => Promise<BashResult>;
}

/**
 * Hot-path mac_do: gate → (confirm if risky) → execute → one audit line. Bash runs
 * daemon-side; osascript/shortcuts route to the shell (TCC attribution). The gate + the
 * audit line are the whole mitigation for running outside the Seatbelt — a declined
 * confirm is still audited and never executes.
 */
export async function executeMacDo(
  script: string,
  interpreter: MacInterpreter,
  deps: MacDoDeps,
): Promise<string> {
  // gateScript is the shared choke point (also used by the sub-agent's run_script): it
  // normalizes FIRST so the policy patterns and the executor see the same string.
  const { script: trimmed, decision } = gateScript(interpreter, script, 'hot');
  if (!trimmed) return 'Empty command — nothing to run.';

  let gate: 'auto' | 'confirmed' | 'declined' = decision.route === 'auto' ? 'auto' : 'confirmed';

  if (decision.route === 'confirm') {
    const approved = await deps.confirm(`${decision.reason}: ${describeMacDo(trimmed)}`);
    if (!approved) {
      auditMacAction({ tier: 'hot', kind: 'script', action: trimmed, gate: 'declined', ok: false, error: decision.reason });
      return `The user didn't approve that command (${decision.reason}), so I didn't run it.`;
    }
  }

  // Opening/focusing an app routes to the shell's fuzzy resolver (launches if needed,
  // resolves approximate names) instead of running the raw exact-name script — so "open
  // ChatGPT" finds "ChatGPT Classic" and launches Notes even when it's quit.
  const appTarget = pureAppOpenTarget(trimmed, interpreter);
  if (appTarget) {
    const res = await deps.macBridge.request({ kind: 'activate', app: appTarget }, { timeoutMs: config.mac.rpcTimeoutMs });
    auditMacAction({ tier: 'hot', kind: 'script', action: trimmed, gate, ok: res.ok, error: res.ok ? undefined : res.error_kind });
    if (!res.ok) return `Couldn't open "${appTarget}" (${res.error_kind ?? 'error'})${res.output ? `: ${res.output}` : ''}.`;
    return res.output || 'Done.';
  }

  const runBash = deps.runBash ?? runBashDaemonSide;
  let ok: boolean;
  let output: string;
  let errorKind: string | undefined;

  if (interpreter === 'bash') {
    const res = await runBash(trimmed, config.mac.hotScriptTimeoutMs);
    ({ ok, output, errorKind } = res);
  } else {
    // osascript / shortcuts execute in the shell (Apple-Events / Shortcuts TCC).
    const res = await deps.macBridge.request(
      { kind: 'script', interpreter, script: trimmed, timeout_ms: config.mac.hotScriptTimeoutMs },
      { timeoutMs: config.mac.hotScriptTimeoutMs + 2000 }, // RPC budget > script budget so the shell's own timeout wins
    );
    ok = res.ok;
    output = res.output;
    errorKind = res.error_kind;
  }

  auditMacAction({ tier: 'hot', kind: 'script', action: trimmed, gate, ok, error: ok ? undefined : errorKind });
  if (!ok) return `That command failed (${errorKind ?? 'error'})${output ? `: ${output}` : ''}.`;
  return output || 'Done.';
}
