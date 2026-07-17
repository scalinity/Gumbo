import { execFile } from 'node:child_process';
import { config } from '../config.ts';
import { auditMacAction } from './audit.ts';
import { macDoDecision, describeMacDo } from './policy.ts';
import type { MacBridge } from '../ws/mac.ts';

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
    execFile('/bin/bash', ['-lc', script], { timeout: timeoutMs, maxBuffer: config.mac.outputMaxChars }, (err, stdout, stderr) => {
      const output = (String(stdout ?? '') + String(stderr ?? '')).trim();
      if (err) {
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
        resolvePromise({
          ok: false,
          output: output || (killed ? `Timed out after ${timeoutMs} ms.` : String(err)),
          errorKind: killed ? 'timeout' : 'script_error',
        });
      } else {
        resolvePromise({ ok: true, output });
      }
    });
  });
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
  const trimmed = script.trim();
  if (!trimmed) return 'Empty command — nothing to run.';

  const decision = macDoDecision(trimmed);
  let gate: 'auto' | 'confirmed' | 'declined' = decision.route === 'auto' ? 'auto' : 'confirmed';

  if (decision.route === 'confirm') {
    const approved = await deps.confirm(`${decision.reason}: ${describeMacDo(trimmed)}`);
    if (!approved) {
      auditMacAction({ tier: 'hot', kind: 'script', action: trimmed, gate: 'declined', ok: false, error: decision.reason });
      return `the user didn't approve that command (${decision.reason}), so I didn't run it.`;
    }
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
