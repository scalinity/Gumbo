import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import type { Provider } from './client.ts';

// Every outbound search call — success or failure — lands as one JSONL line in
// logs/search-audit.jsonl (private: logs/ is not a /files-served subtree). This is the
// audit trail of every query Gumbo sends off-box.
export function auditSearchCall(entry: {
  provider: Provider;
  endpoint: string;
  query: string;
  resultCount: number;
  ok: boolean;
  error?: string;
}) {
  try {
    mkdirSync(config.home.logs, { recursive: true });
    appendFileSync(
      join(config.home.logs, 'search-audit.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch (err) {
    // Auditing must never take a search call down with it.
    console.error('search audit write failed:', err);
  }
}
