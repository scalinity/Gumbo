// M8 unattended app boundary: a scheduled routine is restricted to the apps its saved
// procedure touches (procedure.apps — the KNOWN-procedure contract). The replay engine
// only targets those by construction; this wrapper is the boundary for the DRIFT
// FALLBACK loop, which otherwise roams freely. Same mutate-invoke idiom as wrapSteering
// (and it composes with it: unattended wrap first — it applies to the engine too — then
// the steering wrap for the loop).
//
// An out-of-set app is a would-be-confirm, not a deny: it rides the SAME parked escalate
// as every unattended confirm (Law 1 — one gate, one prompt, one stand-down/park path),
// and an approval admits the app for the rest of the task.
import type { ConfirmScript } from './mac-tools.ts';

/** Tools whose `app` argument states which app the task is about to read or drive. */
const APP_TARGETING = new Set(['focus_app', 'ax_snapshot', 'screen_ocr', 'screen_look']);

export function wrapUnattendedApps<T extends { name: string; invoke: (...args: never[]) => Promise<unknown> }>(
  toolObj: T,
  allowedApps: string[],
  confirm: ConfirmScript,
): T {
  if (!APP_TARGETING.has(toolObj.name)) return toolObj;
  const allowed = new Set(allowedApps.map((a) => a.trim().toLowerCase()).filter(Boolean));
  const original = toolObj.invoke.bind(toolObj);
  toolObj.invoke = (async (...args: never[]) => {
    const rawInput = args[1];
    let app: string | null = null;
    try {
      const parsed = typeof rawInput === 'string' ? (JSON.parse(rawInput) as { app?: unknown }) : null;
      app = typeof parsed?.app === 'string' && parsed.app.trim() ? parsed.app.trim() : null;
    } catch { /* unparseable args → the tool itself will reject them */ }
    // app null = frontmost — whatever the routine itself focused; the boundary is about
    // TARGETING a new app by name.
    if (app && !allowed.has(app.toLowerCase())) {
      const approved = await confirm(
        `The unattended routine wants to use "${app}", which is outside its recorded apps (${[...allowed].join(', ') || 'none'}). Allow it for this run?`,
        'Routine wants another app',
      );
      if (!approved) {
        return `the user didn't approve using "${app}" during this unattended run — stay within the procedure's apps (${[...allowed].join(', ') || 'none'}) or wrap up and report what remains.`;
      }
      allowed.add(app.toLowerCase());
    }
    return original(...args);
  }) as T['invoke'];
  return toolObj;
}
