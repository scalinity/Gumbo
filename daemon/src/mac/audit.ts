import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';

// Same self-healing memoized mkdir as search/audit.ts — boot normally covers it.
let logsDirReady = false;

/**
 * M6 audit trail: every performed (or refused) mac-lane ACTION — hot mac_do scripts,
 * sub-agent ax_act steps and run_script calls, and (M7) browser-lane acts/navigations —
 * lands as one JSONL line in logs/mac-audit.jsonl (private: logs/ is not /files-served).
 * Observations (snapshot, query, health, tab lists) are deliberately not audited; the
 * trail records what touched the machine, including declined confirms (gate 'declined')
 * — refusals are part of the security story. Browser lines carry the page URL (SPEC §M7:
 * the audit line carries the URL trail).
 */
export function auditMacAction(entry: {
  tier: 'hot' | 'subagent';
  kind: 'script' | 'act' | 'browser';
  /** The script text (scripts) or a verb+target summary (acts, browser actions). */
  action: string;
  /** How the gate resolved: auto-allowed, the user confirmed, or the user/timeout declined. */
  gate: 'auto' | 'confirmed' | 'declined';
  ok: boolean;
  error?: string;
  taskId?: string;
  /** Browser lane: the page URL the action ran against (or navigated to). */
  url?: string;
}) {
  try {
    if (!logsDirReady) {
      mkdirSync(config.home.logs, { recursive: true });
      logsDirReady = true;
    }
    appendFileSync(
      join(config.home.logs, 'mac-audit.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch (err) {
    // Auditing must never take an action (or the daemon) down with it.
    console.error('mac audit write failed:', err);
  }
}
