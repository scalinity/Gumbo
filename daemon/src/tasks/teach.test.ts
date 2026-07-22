import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { sanitizeTeachStep, teachingReport, SECRET_FIELD_RE } = await import('./teach.ts');
const { config } = await import('../config.ts');

test('sanitize: a well-formed click step passes with all fields', () => {
  const step = sanitizeTeachStep({
    kind: 'click', app: 'Mail', window: 'Inbox', role: 'AXButton',
    identifier: 'composeButton', name: 'Compose', value: 'click',
  });
  assert.ok(step);
  assert.equal(step.kind, 'click');
  assert.equal(step.app, 'Mail');
  assert.equal(step.window, 'Inbox');
  assert.equal(step.role, 'AXButton');
  assert.equal(step.identifier, 'composeButton');
  assert.equal(step.name, 'Compose');
  assert.equal(step.value, 'click');
  assert.equal(typeof step.ts, 'number');
});

test('sanitize: noise is rejected — non-objects, unknown kinds, missing app', () => {
  assert.equal(sanitizeTeachStep(null), null);
  assert.equal(sanitizeTeachStep('click'), null);
  assert.equal(sanitizeTeachStep({ kind: 'explode', app: 'Mail' }), null);
  assert.equal(sanitizeTeachStep({ kind: 'click' }), null); // no app = noise
});

test('sanitize: strings are capped and unknown fields dropped', () => {
  const step = sanitizeTeachStep({
    kind: 'type', app: 'Notes', name: 'Body',
    value: 'x'.repeat(config.teach.valueMaxChars + 500),
    frame: [10, 20, 30, 40], // coordinates must never survive sanitize
    extra: 'dropped',
  });
  assert.ok(step);
  assert.equal(step.value?.length, config.teach.valueMaxChars);
  assert.ok(!('frame' in step), 'coordinates must not survive sanitize');
  assert.ok(!('extra' in step), 'unknown fields must not survive sanitize');
});

// The HARD requirement: typed content into anything credential-shaped never survives as
// content — the shell is the primary gate, this is the daemon-side belt.
test('sanitize: secure subrole coerces type → secure_input and drops the content', () => {
  const step = sanitizeTeachStep({
    kind: 'type', app: 'Safari', subrole: 'AXSecureTextField', name: 'Password',
    value: 'hunter2',
  });
  assert.ok(step);
  assert.equal(step.kind, 'secure_input');
  assert.equal(step.value, undefined, 'credential content must be dropped');
});

test('sanitize: credential-shaped field LABELS coerce to secure_input too (belt over the lexicon)', () => {
  for (const label of ['Password', 'One-time passcode', 'OTP', '2FA code', 'API token', 'Card PIN', 'CVV']) {
    const step = sanitizeTeachStep({ kind: 'type', app: 'Chrome', name: label, value: 'sekrit' });
    assert.ok(step, `${label} step dropped entirely`);
    assert.equal(step.kind, 'secure_input', `"${label}" should coerce to secure_input`);
    assert.equal(step.value, undefined, `"${label}" content must be dropped`);
  }
  // …but ordinary fields keep their text (replay needs it).
  const plain = sanitizeTeachStep({ kind: 'type', app: 'Notes', name: 'Title', value: 'Q3 planning' });
  assert.equal(plain?.kind, 'type');
  assert.equal(plain?.value, 'Q3 planning');
});

// Scan HIGH (2026-07-22): web/custom fields often have an empty/generic NAME but a
// credential-shaped IDENTIFIER — those values used to survive as content.
test('sanitize: a credential-shaped IDENTIFIER coerces to secure_input even with a blank/generic name', () => {
  for (const identifier of ['password', 'user_password', 'otp', 'otp-input', 'token', 'auth_token', 'card_cvv']) {
    const step = sanitizeTeachStep({ kind: 'type', app: 'Chrome', identifier, name: '', value: 'sekrit' });
    assert.ok(step, `${identifier} step dropped entirely`);
    assert.equal(step.kind, 'secure_input', `identifier "${identifier}" should coerce to secure_input`);
    assert.equal(step.value, undefined, `identifier "${identifier}" content must be dropped`);
  }
  // A paste into a credential-id field degrades too (same disclosure risk).
  const paste = sanitizeTeachStep({ kind: 'paste', app: 'Chrome', identifier: 'password', value: 'hunter2', rtf: 'cnRm' });
  assert.equal(paste?.kind, 'secure_input');
  assert.equal(paste?.value, undefined);
  assert.equal(paste?.rtf, undefined);
  // An ordinary identifier keeps its content.
  const plain = sanitizeTeachStep({ kind: 'type', app: 'Notes', identifier: 'titleField', name: '', value: 'Q3 planning' });
  assert.equal(plain?.kind, 'type');
  assert.equal(plain?.value, 'Q3 planning');
});

test('sanitize: a secure_input step never carries a value, whatever the shell sent', () => {
  const step = sanitizeTeachStep({ kind: 'secure_input', app: 'Safari', name: 'Password', value: 'leaked?' });
  assert.ok(step);
  assert.equal(step.value, undefined);
});

test('secret lexicon covers the spread without swallowing ordinary labels', () => {
  for (const hit of ['Password', 'passphrase', 'Enter your OTP', 'verification code', 'secret key', 'PIN']) {
    assert.match(hit, SECRET_FIELD_RE, `"${hit}" should read as a credential label`);
  }
  for (const miss of ['Subject', 'Search', 'To', 'Title', 'Opinion', 'Pinned notes']) {
    assert.doesNotMatch(miss, SECRET_FIELD_RE, `"${miss}" must not read as a credential label`);
  }
});

test('teaching report reads as a numbered human step list and marks secure steps', () => {
  const steps = [
    sanitizeTeachStep({ kind: 'click', app: 'Mail', window: 'Inbox', role: 'AXButton', name: 'Compose', value: 'click' })!,
    sanitizeTeachStep({ kind: 'type', app: 'Mail', role: 'AXTextField', name: 'Subject', value: 'Expenses June' })!,
    sanitizeTeachStep({ kind: 'type', app: 'Mail', subrole: 'AXSecureTextField', name: 'Password', value: 'nope' })!,
    sanitizeTeachStep({ kind: 'key', app: 'Mail', value: 'cmd+s' })!,
  ];
  const report = teachingReport('file expenses', steps);
  assert.match(report, /"file expenses" — 4 steps recorded/);
  assert.match(report, /1\. click on Button "Compose" in Mail — Inbox/);
  assert.match(report, /2\. typed "Expenses June" into TextField "Subject"/);
  assert.match(report, /3\. the user entered a credential .* \(content not recorded — replays as a handoff\)/);
  assert.doesNotMatch(report, /nope/, 'credential content must never reach a report');
  assert.match(report, /4\. pressed cmd\+s/);
});

test('sanitize: select_text in a credential-shaped field degrades to secure_input with no value or occurrence', () => {
  const step = sanitizeTeachStep({ kind: 'select_text', app: 'Safari', role: 'AXTextField', name: 'Password', value: 'hunter2', occurrence: 1 });
  assert.equal(step?.kind, 'secure_input');
  assert.equal(step?.value, undefined, 'the selected credential text never survives');
  assert.equal(step?.occurrence, undefined);
});

test('sanitize: select_text keeps value and occurrence on an ordinary field', () => {
  const step = sanitizeTeachStep({ kind: 'select_text', app: 'Notes', role: 'AXTextArea', value: 'CLAUDE', occurrence: 2 });
  assert.equal(step?.kind, 'select_text');
  assert.equal(step?.value, 'CLAUDE');
  assert.equal(step?.occurrence, 2);
});

test('sanitize: a paste step keeps plain text + rtf; into a credential field it degrades content-free', () => {
  const ok = sanitizeTeachStep({ kind: 'paste', app: 'Notes', role: 'AXTextArea', value: 'styled list', rtf: 'cnRmZGF0YQ==' });
  assert.equal(ok?.kind, 'paste');
  assert.equal(ok?.value, 'styled list');
  assert.equal(ok?.rtf, 'cnRmZGF0YQ==');

  const secure = sanitizeTeachStep({ kind: 'paste', app: 'Safari', role: 'AXTextField', name: 'Password', value: 'hunter2', rtf: 'cnRm' });
  assert.equal(secure?.kind, 'secure_input');
  assert.equal(secure?.value, undefined);
  assert.equal(secure?.rtf, undefined, 'the styled payload never survives a credential field');
});
