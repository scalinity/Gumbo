// M8 watch-me teaching: the daemon-side shape of one demonstrated step, plus the
// sanitizer that coerces the shell's untrusted hand-built JSON into it (the
// MacBridge.sanitize precedent — never trust wire shapes from the shell).
//
// Steps are SEMANTIC — role/label/identifier of the element the user touched, never
// coordinates (SPEC §M8: a pixel recording is stale by the next window resize). Secure
// input NEVER carries content: the shell's recorder is the primary gate (keystrokes into
// a secure/credential field never leave the machine boundary of the shell process), and
// sanitize re-applies the same rule here as the daemon-side belt.
import { config } from '../config.ts';

export type TeachStepKind = 'click' | 'type' | 'key' | 'secure_input' | 'scroll' | 'drag' | 'select_text' | 'paste';

export type TeachStep = {
  kind: TeachStepKind;
  /** App the step happened in (localizedName). Required — a step with no app is noise. */
  app: string;
  window?: string;
  role?: string;
  subrole?: string;
  identifier?: string;
  /** Element label (AXTitle/AXDescription). */
  name?: string;
  /** click: verb (click|double_click|right_click); type: the typed text; key: the chord;
   *  select_text: the highlighted text; paste: the pasted PLAIN text. */
  value?: string;
  /** select_text: which occurrence of `value` was highlighted (0-based). */
  occurrence?: number;
  /** paste: base64 RTF of the pasted clipboard, so styling survives replay. A bare
   *  cmd+v replayed later would paste whatever the clipboard happens to hold THEN —
   *  the content is part of the demonstration, so it rides with the step. */
  rtf?: string;
  /** Daemon clock at ingest — the shell's clock is untrusted and unneeded. */
  ts: number;
};

const STEP_KINDS: ReadonlySet<string> = new Set(
  ['click', 'type', 'key', 'secure_input', 'scroll', 'drag', 'select_text', 'paste'] satisfies TeachStepKind[],
);

/** Pasted content outgrows typed bursts (a whole document in one gesture) — its own caps. */
const PASTE_PLAIN_MAX = 20_000;
const PASTE_RTF_MAX = 400_000; // base64 chars

/** Field labels that mean "credential" even when the AX subrole isn't AXSecureTextField
 *  (web OTP inputs, custom login forms). Mirrored in the shell's Recorder.swift — the
 *  shell is the primary gate (content never leaves it); this is the belt. */
export const SECRET_FIELD_RE = /passw|passcode|passphrase|\botp\b|2fa|verification|secret|token|\bpin\b|cvv|security code|credential/i;

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

/** Coerce one wire step into the typed contract, or null for noise. Unknown fields drop;
 *  strings are capped; anything credential-shaped becomes a content-free secure_input
 *  even if the shell's own gate somehow missed it. */
export function sanitizeTeachStep(raw: unknown): TeachStep | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== 'string' || !STEP_KINDS.has(r.kind)) return null;
  const app = str(r.app, 100);
  if (!app) return null;
  const step: TeachStep = { kind: r.kind as TeachStepKind, app, ts: Date.now() };
  const window = str(r.window, 200);
  const role = str(r.role, 100);
  const subrole = str(r.subrole, 100);
  const identifier = str(r.identifier, 200);
  const name = str(r.name, 200);
  const value = str(r.value, step.kind === 'paste' ? PASTE_PLAIN_MAX : config.teach.valueMaxChars);
  if (window) step.window = window;
  if (role) step.role = role;
  if (subrole) step.subrole = subrole;
  if (identifier) step.identifier = identifier;
  if (name) step.name = name;
  if (value) step.value = value;
  if (typeof r.occurrence === 'number' && Number.isInteger(r.occurrence) && r.occurrence >= 0) step.occurrence = r.occurrence;
  if (step.kind === 'paste') {
    const rtf = str(r.rtf, PASTE_RTF_MAX);
    if (rtf) step.rtf = rtf;
  }
  // Belt: content into anything credential-shaped becomes a semantic step with NO content (the
  // subrole could have been lost in transit, or the label is a variant the shell's lexicon
  // missed). secure_input is structurally content-free. Selecting text in — or pasting into —
  // a secure field is the same disclosure risk, so those degrade too.
  if ((step.kind === 'type' || step.kind === 'select_text' || step.kind === 'paste') && (subrole === 'AXSecureTextField' || SECRET_FIELD_RE.test(name ?? ''))) {
    step.kind = 'secure_input';
  }
  if (step.kind === 'secure_input') { delete step.value; delete step.occurrence; delete step.rtf; }
  return step;
}

/** Human-readable line for the teaching report (and Phase-2 compiler input). */
export function describeTeachStep(step: TeachStep, index: number): string {
  const target = step.name ? `"${step.name}"` : step.identifier ? `#${step.identifier}` : '';
  const where = [step.role?.replace(/^AX/, ''), target].filter(Boolean).join(' ');
  const app = step.window ? `${step.app} — ${step.window}` : step.app;
  switch (step.kind) {
    case 'click': return `${index}. ${step.value ?? 'click'} on ${where || 'an element'} in ${app}`;
    case 'type': return `${index}. typed "${step.value ?? ''}" into ${where || 'the focused field'} in ${app}`;
    case 'key': return `${index}. pressed ${step.value ?? 'a key'} in ${app}`;
    case 'secure_input': return `${index}. the user entered a credential into ${where || 'a secure field'} in ${app} (content not recorded — replays as a handoff)`;
    case 'scroll': return `${index}. scrolled in ${app}`;
    case 'drag': return `${index}. dragged (low fidelity) in ${app}`;
    case 'select_text': return `${index}. highlighted the text "${step.value ?? ''}"${step.occurrence ? ` (occurrence ${step.occurrence})` : ''} in ${where || 'the focused field'} in ${app}`;
    case 'paste': return `${index}. pasted clipboard content into ${where || 'the focused field'} in ${app} (${step.value?.length ?? 0} chars${step.rtf ? ', styled' : ''}; replay reproduces the captured content exactly): "${(step.value ?? '').slice(0, 300)}${(step.value?.length ?? 0) > 300 ? '…' : ''}"`;
  }
}

export function teachingReport(name: string, steps: TeachStep[], note?: string): string {
  const head = `Watched the user demonstrate "${name}" — ${steps.length} step${steps.length === 1 ? '' : 's'} recorded.`;
  const noteLine = note ? `\n(Recording stopped: ${note}.)` : '';
  const lines = steps.map((s, i) => describeTeachStep(s, i + 1));
  return `${head}${noteLine}\n\n${lines.join('\n')}\n`;
}
