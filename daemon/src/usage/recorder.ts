import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import type { Store, UsageRow } from '../events/store.ts';
import { priceTerraTokens, type PricedTokens } from './pricing.ts';

// Every priced provider call lands twice: one row in the sqlite usage table (feeds
// /api/usage and the dashboard charts) and one JSONL line in logs/usage.jsonl — its OWN
// ledger, deliberately separate from search-audit.jsonl so the search audit stays
// noise-free while debugging. Recording must never take a provider call down: every write
// is guarded, and an uninitialized recorder is a silent no-op (index.ts wires it at boot;
// tests init explicitly).

let store: Store | null = null;
let logsDirReady = false;

export function initUsageRecorder(s: Store) {
  store = s;
}

export interface UsageEntry {
  provider: string;
  model?: string;
  kind: string;
  taskId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  units?: number;
  costUsd: number;
  billed?: boolean; // default true; false = Claude equivalent value
  estimated?: boolean; // default false; true = unit-price/duration estimate
  detail?: Record<string, unknown>;
}

/** Local calendar date (YYYY-MM-DD) — stamped at write so aggregation never does tz math.
 *  Also used by /api/usage's default-window computation so both sides share one formatter. */
export function localDay(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function recordUsage(entry: UsageEntry) {
  try {
    if (!store) return; // pre-boot or test without init — deliberate no-op
    const ts = Date.now();
    const row: UsageRow = {
      ts,
      day: localDay(ts),
      provider: entry.provider,
      model: entry.model ?? null,
      kind: entry.kind,
      task_id: entry.taskId ?? null,
      input_tokens: entry.inputTokens ?? 0,
      output_tokens: entry.outputTokens ?? 0,
      cached_tokens: entry.cachedTokens ?? 0,
      cache_write_tokens: entry.cacheWriteTokens ?? 0,
      units: entry.units ?? 0,
      cost_usd: entry.costUsd,
      billed: entry.billed === false ? 0 : 1,
      estimated: entry.estimated ? 1 : 0,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
    };
    store.insertUsage(row);
    if (!logsDirReady) {
      mkdirSync(config.home.logs, { recursive: true });
      logsDirReady = true;
    }
    appendFileSync(join(config.home.logs, 'usage.jsonl'), JSON.stringify(row) + '\n');
  } catch (err) {
    console.error('usage record failed (continuing):', err);
  }
}

/** Convenience for a priced-token result (pricing.ts) — collapses the field mapping. */
export function recordPriced(
  priced: PricedTokens,
  meta: Omit<UsageEntry, 'costUsd' | 'inputTokens' | 'outputTokens' | 'cachedTokens'>,
) {
  recordUsage({
    ...meta,
    costUsd: priced.costUsd,
    inputTokens: priced.inputTokens,
    outputTokens: priced.outputTokens,
    cachedTokens: priced.cachedTokens,
    detail: { ...(priced.detail ?? {}), ...(meta.detail ?? {}) },
  });
}

// The @openai/agents SDK reports usage per model response — result.rawResponses[].usage
// with camelCase inputTokens/outputTokens (verified against the installed SDK's
// usage.d.ts). inputTokensDetails is an ARRAY of {cached_tokens,...} records on the Usage
// class (one per underlying API call), a single record on RequestUsage — handle both.
// Shared by the sub-agent runner (initial run + bounce retry) and the supervisor.
interface AgentsRawResponse {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokensDetails?: Record<string, number> | Array<Record<string, number>>;
  };
}

function cachedFromDetails(details?: Record<string, number> | Array<Record<string, number>>): number {
  if (!details) return 0;
  const records = Array.isArray(details) ? details : [details];
  return records.reduce((sum, r) => sum + (r?.cached_tokens ?? 0), 0);
}

export function recordAgentsRunUsage(
  rawResponses: AgentsRawResponse[] | undefined,
  meta: { kind: string; model: string; taskId?: string | null },
) {
  try {
    let input = 0;
    let output = 0;
    let cached = 0;
    for (const r of rawResponses ?? []) {
      const u = r.usage;
      if (!u) continue;
      input += u.inputTokens ?? 0;
      output += u.outputTokens ?? 0;
      cached += cachedFromDetails(u.inputTokensDetails);
    }
    if (input === 0 && output === 0) return; // nothing usable reported — skip, never guess
    // Rates: every run() model in the daemon is terra-priced today; callers pass their own
    // config key so a future model divergence at least labels its rows honestly.
    recordPriced(priceTerraTokens({ input, output, cached }), {
      provider: 'openai',
      model: meta.model,
      kind: meta.kind,
      taskId: meta.taskId,
    });
  } catch (err) {
    console.error('usage record failed (continuing):', err);
  }
}
