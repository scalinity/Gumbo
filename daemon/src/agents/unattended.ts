// M8 unattended app boundary: a scheduled routine is restricted to the apps its saved
// procedure touches (procedure.apps — the KNOWN-procedure contract). The replay engine
// only targets those by construction; this wrapper is the boundary for the DRIFT
// FALLBACK loop, which otherwise roams freely. Same mutate-invoke idiom as wrapSteering
// (and it composes with it: unattended wrap first — it applies to the engine too — then
// the steering wrap for the loop).
//
// An out-of-set app is a would-be-confirm, not a deny: it rides the SAME parked escalate
// as every unattended confirm (one gate, one prompt, one stand-down/park path), and an
// approval admits the app for the rest of the run.
//
// Scan HIGHs (2026-07-22) hardened this from an allowlist-of-four-tools to default-deny
// over every app-observing/affecting surface the mac toolset exposes:
//   - read_document joins the app-arg set (it returns full document text from any app);
//   - app:null is no longer a free pass: a frontmost read is allowed only after the run
//     itself brought an in-set app forward (tracked below); before that it refuses with
//     an instruction to name the app. Residual, honestly: an app that steals focus on its
//     own can still be read by a null-app call after attestation — frontmost attribution
//     lives shell-side and is not attested back to the daemon.
//   - region captures confirm: the shell treats region as a GLOBAL screen rectangle, so
//     an in-set app name proves nothing about what the rect actually shows.
//   - click_point confirms per use: a global-coordinate HID click can't be attributed to
//     any app from the daemon.
//   - run_script confirms when its script targets an out-of-set app (tell application /
//     open -a literals) or an app it can't identify (a non-literal tell target).
// ax_act/ax_query stay outside THIS boundary: their refs bind to the last snapshot,
// which is boundary-checked above; dangerous labels/chords ride the native-action policy.
import type { ConfirmScript } from './mac-tools.ts';

/** Tools whose `app` argument states which app the run is about to read or drive. */
const APP_ARG = new Set(['focus_app', 'ax_snapshot', 'screen_ocr', 'screen_look', 'read_document']);
/** Capture tools whose optional `region` is a global screen rectangle. */
const CAPTURE = new Set(['screen_ocr', 'screen_look']);

const TELL_LITERAL = /\btell\s+app(?:lication)?\s+"([^"]+)"/gi;
const TELL_ANY = /\btell\s+app(?:lication)?\b/gi;
const OPEN_A = /\bopen\b[^|;&\n]*?\s-a\s+(?:"([^"]+)"|'([^']+)'|(\S+))/gi;

interface ParsedArgs {
  app?: unknown;
  region?: unknown;
  interpreter?: unknown;
  script?: unknown;
  x?: unknown;
  y?: unknown;
}

/** One boundary instance per unattended run — the tools share the allowed set and the
 *  frontmost attestation, so `map(wrap)` over the toolset keeps one coherent state. */
export function createUnattendedWrapper(allowedApps: string[], confirm: ConfirmScript) {
  const allowed = new Set(allowedApps.map((a) => a.trim().toLowerCase()).filter(Boolean));
  const label = () => [...allowed].join(', ') || 'none';
  // The last in-set app THIS RUN brought forward (focus_app or an in-set activate
  // script) — the attestation a null-app "frontmost" call rides.
  let attestedFrontmost: string | null = null;

  /** null = proceed; otherwise the refusal string (deny-safe, loud). */
  async function gateApp(app: string): Promise<string | null> {
    if (allowed.has(app.toLowerCase())) return null;
    const approved = await confirm(
      `The unattended routine wants to use "${app}", which is outside its recorded apps (${label()}). Allow it for this run?`,
      'Routine wants another app',
    );
    if (!approved) {
      return `the user didn't approve using "${app}" during this unattended run — stay within the procedure's apps (${label()}) or wrap up and report what remains.`;
    }
    allowed.add(app.toLowerCase());
    return null;
  }

  /** App names a script drives, or null when it targets an app we can't identify. */
  function scriptAppTargets(script: string): string[] | null {
    const targets = [...script.matchAll(TELL_LITERAL)].map((m) => m[1]);
    if ([...script.matchAll(TELL_ANY)].length > targets.length) return null; // non-literal tell
    for (const m of script.matchAll(OPEN_A)) targets.push((m[1] ?? m[2] ?? m[3]).trim());
    return targets;
  }

  return function wrap<T extends { name: string; invoke: (...args: never[]) => Promise<unknown> }>(toolObj: T): T {
    const gated = APP_ARG.has(toolObj.name) || toolObj.name === 'run_script' || toolObj.name === 'click_point';
    if (!gated) return toolObj;
    const original = toolObj.invoke.bind(toolObj);
    toolObj.invoke = (async (...args: never[]) => {
      const rawInput = args[1];
      let parsed: ParsedArgs | null = null;
      try {
        parsed = typeof rawInput === 'string' ? (JSON.parse(rawInput) as ParsedArgs) : null;
      } catch { /* unparseable args → the tool itself will reject them */ }

      if (toolObj.name === 'click_point') {
        const at = typeof parsed?.x === 'number' && typeof parsed?.y === 'number' ? ` at (${parsed.x}, ${parsed.y})` : '';
        const approved = await confirm(
          `The unattended routine wants a raw screen click${at} — a global click can't be tied to its recorded apps (${label()}). Allow it?`,
          'Routine wants a raw click',
        );
        if (!approved) return `the user didn't approve a raw screen click during this unattended run — use the app's own elements (ax_act on a snapshot ref) or wrap up and report what remains.`;
        return original(...args);
      }

      if (toolObj.name === 'run_script') {
        const script = typeof parsed?.script === 'string' ? parsed.script : '';
        const targets = scriptAppTargets(script);
        if (targets === null) {
          const approved = await confirm(
            `The unattended routine wants to run a script that drives an app it doesn't name literally — the app boundary (${label()}) can't be checked. Allow it?`,
            'Routine script targets an unidentified app',
          );
          if (!approved) return `the user didn't approve that script during this unattended run — name apps literally (tell application "…") and stay within ${label()}.`;
        } else {
          for (const target of targets) {
            const refusal = await gateApp(target);
            if (refusal) return refusal;
          }
          const inSet = targets.find((t) => allowed.has(t.toLowerCase()));
          if (inSet && /\bactivate\b/i.test(script)) attestedFrontmost = inSet.toLowerCase();
        }
        return original(...args);
      }

      // App-arg tools: a named app gates on the set; app:null is a frontmost read and
      // rides the attestation (the run must have surfaced an in-set app itself first).
      const app = typeof parsed?.app === 'string' && parsed.app.trim() ? parsed.app.trim() : null;
      if (CAPTURE.has(toolObj.name) && parsed?.region != null) {
        const approved = await confirm(
          `The unattended routine wants to capture a raw screen region — the region is a global rectangle, not bounded to its recorded apps (${label()}). Allow it?`,
          'Routine wants a screen region',
        );
        if (!approved) return `the user didn't approve a raw region capture during this unattended run — capture a named app window instead (${label()}).`;
      }
      if (app) {
        const refusal = await gateApp(app);
        if (refusal) return refusal;
      } else if (!attestedFrontmost) {
        return `name the app explicitly (one of: ${label()}) — an unattended run can't verify what the frontmost window is until the routine has focused one of its own apps.`;
      }
      const result = await original(...args);
      // Attest the frontmost only when the focus visibly succeeded (the toolset's failure
      // contract is an "Error (kind)…" string) — optimistic beyond that, and said so above.
      if (toolObj.name === 'focus_app' && app && !(typeof result === 'string' && result.startsWith('Error ('))) {
        attestedFrontmost = app.toLowerCase();
      }
      return result;
    }) as T['invoke'];
    return toolObj;
  };
}
