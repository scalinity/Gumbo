import { tool } from '@openai/agents';
import { z } from 'zod';
import { config } from '../config.ts';
import { auditMacAction } from '../mac/audit.ts';
import type { MacBridge } from '../ws/mac.ts';
import type { MacActionResult } from '../ws/protocol.ts';

/** Format a shell result for the model: the raw output on success; on failure the typed
 *  kind up front so the model branches on it (never on the message text). */
function present(result: MacActionResult): string {
  if (result.ok) return result.output || '(no output)';
  const hint = result.error_kind === 'stale_ref' ? ' — re-run ax_snapshot to get fresh refs' : '';
  return `Error (${result.error_kind ?? 'unknown'})${hint}: ${result.output}`;
}

/**
 * M6 computer-use toolset for the background sub-agent. Breadth is cheap here (unlike the
 * realtime registry): ax_snapshot / ax_query observe, ax_act drives the dispatch ladder,
 * run_script covers the scriptable world, check_permissions disambiguates a broken tree.
 * Every tool routes through the shell (it owns the TCC grants) via MacBridge; acts and
 * scripts each write one mac-audit.jsonl line, observations don't (they touch nothing).
 *
 * The repetition detector lives here in per-task state: the same act on the same ref three
 * times running is a top-4 documented computer-use failure — short-circuit with a warning
 * before it burns the step budget looping.
 */
export function createMacTools(taskId: string, macBridge: MacBridge, signal: AbortSignal) {
  let lastActKey = '';
  let repeatCount = 0;

  const axSnapshot = tool({
    name: 'ax_snapshot',
    description:
      'Read a compacted Accessibility tree of an app window: one line per interactive element ' +
      '(ref, role, label, value). Pass app null for the frontmost window, or an app name. Refs are ' +
      'valid ONLY until the next snapshot — always snapshot before acting, and re-snapshot after a ' +
      'stale_ref error. This is how you SEE the screen; take one first on every task.',
    parameters: z.object({
      app: z.string().nullable().describe('App name (e.g. "Notes"); null = frontmost window'),
      max_elements: z.number().int().min(1).max(1000).default(config.mac.snapshotMaxElements),
    }),
    async execute({ app, max_elements }) {
      const result = await macBridge.request({ kind: 'snapshot', app, max_elements }, { signal });
      return present(result);
    },
  });

  const axQuery = tool({
    name: 'ax_query',
    description:
      'Search the LAST snapshot for elements whose role, label, value, or identifier contains your ' +
      'text — use it when a snapshot was truncated or you need an element that scrolled out of the ' +
      'interactive sample. Does not take a new snapshot.',
    parameters: z.object({
      query: z.string().describe('Substring to match against role/label/value/identifier'),
      max_results: z.number().int().min(1).max(200).default(40),
    }),
    async execute({ query, max_results }) {
      const result = await macBridge.request({ kind: 'query', query, max_results }, { signal });
      return present(result);
    },
  });

  const axAct = tool({
    name: 'ax_act',
    description:
      'Act on an element by ref (from the latest snapshot). Verbs: press (click/activate), focus, ' +
      'set_value (write a value directly), type (send keystrokes — use for web/Electron fields), ' +
      'key (a keyboard shortcut like "cmd+n" or "return" — value holds the chord, no ref needed), ' +
      'show_menu (right-click/context menu), wait_for (block until an element with role+name appears; ' +
      'use role+name instead of ref). Returns a before/after DIFF of what changed — read it to verify ' +
      'the step worked; an empty diff means nothing changed, so DO NOT assume success. Secure ' +
      '(password) fields are refused.',
    parameters: z.object({
      verb: z.enum(['press', 'focus', 'set_value', 'type', 'key', 'show_menu', 'wait_for']),
      ref: z.string().nullable().describe('Element ref from ax_snapshot; null for key/wait_for'),
      value: z.string().nullable().describe('Text for type/set_value, or the chord for key'),
      role: z.string().nullable().describe('wait_for: the role to wait for (e.g. "AXButton")'),
      name: z.string().nullable().describe('wait_for: substring of the label to wait for'),
      timeout_ms: z.number().int().min(100).max(30_000).default(5000),
    }),
    async execute({ verb, ref, value, role, name, timeout_ms }) {
      // Repetition guard: same verb on same ref ×3 in a row → stop and warn.
      const key = `${verb}:${ref ?? role ?? ''}:${value ?? name ?? ''}`;
      repeatCount = key === lastActKey ? repeatCount + 1 : 0;
      lastActKey = key;
      if (repeatCount >= 2) {
        repeatCount = 0;
        return `You have repeated "${verb}" on the same target 3 times with no progress. Stop and take a fresh ax_snapshot, then try a different approach (a different element, a keyboard shortcut, or check for a dialog blocking the way).`;
      }
      const result = await macBridge.request(
        { kind: 'act', verb, ref, value, role, name, timeout_ms },
        { signal, timeoutMs: timeout_ms + 5000 },
      );
      const summary = `${verb} ${ref ?? role ?? ''}`.trim();
      auditMacAction({ tier: 'subagent', kind: 'act', action: summary, gate: 'auto', ok: result.ok, error: result.ok ? undefined : result.error_kind, taskId });
      return present(result);
    },
  });

  const runScript = tool({
    name: 'run_script',
    description:
      'Run an osascript (AppleScript) or a Shortcut when a scriptable path beats driving the UI — ' +
      'app dictionaries, `open`, tmutil, defaults, or `shortcuts run <id>`. For interpreter "shortcuts", ' +
      'pass the shortcut name/UUID as the script. Prefer this over ax_act when an app exposes a direct ' +
      'command. Always finishes within its timeout.',
    parameters: z.object({
      interpreter: z.enum(['osascript', 'shortcuts']),
      script: z.string().describe('AppleScript source, or a shortcut name/UUID'),
    }),
    async execute({ interpreter, script }) {
      const result = await macBridge.request(
        { kind: 'script', interpreter, script, timeout_ms: config.mac.scriptTimeoutMs },
        { signal, timeoutMs: config.mac.scriptTimeoutMs + 2000 },
      );
      auditMacAction({ tier: 'subagent', kind: 'script', action: `${interpreter}: ${script.slice(0, 120)}`, gate: 'auto', ok: result.ok, error: result.ok ? undefined : result.error_kind, taskId });
      return present(result);
    },
  });

  const checkPermissions = tool({
    name: 'check_permissions',
    description:
      'Probe whether Accessibility control is actually working right now. Use it when snapshots come ' +
      'back empty or you get ax_unavailable, to tell "this app has no accessible UI" (fall back to ' +
      'run_script or report it) from "the permission silently broke" (stop and tell the user to relaunch).',
    parameters: z.object({}),
    async execute() {
      const result = await macBridge.request({ kind: 'health' }, { signal });
      return result.health ? `health=${result.health}: ${result.output}` : present(result);
    },
  });

  return [axSnapshot, axQuery, axAct, runScript, checkPermissions];
}
