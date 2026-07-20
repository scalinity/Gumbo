/**
 * M7 browser lane: pure helpers around Playwright's aria snapshots. EVERY capture uses
 * `mode:'ai'` — a default-mode capture WIPES Playwright's internal aria-ref map, killing
 * ref resolution for the act that follows (probed live, 2026-07-19; refs themselves are
 * per-element stable across ai captures). For diffing, refs + the focus marker are
 * stripped instead (stripForDiff). Kept playwright-free so the contracts test offline.
 */

/** Present Playwright's refs generation-scoped (`[ref=g3e12]`): aria-ref resolves against
 *  the LAST captured snapshot, so a ref from an older generation could silently rebind to
 *  a different element — the exact bug the M6 Swift executor fixed by encoding generation
 *  into the ref string. Frame refs (`f2e5`) keep their frame prefix. */
export function encodeRefs(yamlAi: string, generation: number): string {
  return yamlAi.replace(/\[ref=((?:f\d+)?e\d+)\]/g, `[ref=g${generation}$1]`);
}

/** Parse a model-supplied ref back into generation + the raw Playwright ref.
 *  Returns null for anything that isn't a generation-scoped ref. */
export function parseRef(ref: string): { generation: number; playwrightRef: string } | null {
  const m = /^g(\d+)((?:f\d+)?e\d+)$/.exec(ref.trim());
  return m ? { generation: Number(m[1]), playwrightRef: m[2] } : null;
}

export interface RefInfo {
  role: string;
  name: string | null;
}

/** role + accessible name per encoded ref, parsed from the SAME yaml the model saw — the
 *  submit/purchase gate decides on what the model believed it was clicking, not on a
 *  fresh (and possibly attacker-shifted) read of the page. */
export function refTable(encodedYaml: string): Map<string, RefInfo> {
  const table = new Map<string, RefInfo>();
  for (const line of encodedYaml.split('\n')) {
    // Greedy `.*` so attribute annotations between name and ref ([cursor=pointer],
    // [active], …) are crossed, and the LAST [ref=…] on the line wins — a name that
    // *contains* ref-looking text can't spoof the binding.
    const m = /-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?.*\[ref=(g\d+(?:f\d+)?e\d+)\]/.exec(line);
    if (m) table.set(m[3], { role: m[1], name: m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : null });
  }
  return table;
}

/** Normalize an ai-mode capture for DIFFING: drop [ref=…] (numbering noise, not page
 *  change) and [active] (focus hops on every act — churn, not content). Checked/expanded/
 *  selected/pressed stay — those are the state changes the model must verify. */
export function stripForDiff(yamlAi: string): string {
  return yamlAi.replace(/ \[ref=[^\]]+\]/g, '').replace(/ \[active\]/g, '');
}

/** Multiset line diff (duplicate-line changes still count — the M6 executor lesson):
 *  `−` lines left the page, `+` lines appeared. Order-insensitive by design — reflow
 *  moves lines without changing what exists. Empty diff = a real no-op signal. */
export function diffSnapshots(before: string, after: string, maxLines: number): { text: string; changed: boolean } {
  const counts = new Map<string, number>();
  for (const raw of before.split('\n')) {
    const line = raw.trimEnd();
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const raw of after.split('\n')) {
    const line = raw.trimEnd();
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else added.push(line);
  }
  const removed: string[] = [];
  for (const [line, n] of counts) {
    for (let i = 0; i < n; i++) removed.push(line);
  }
  const all = [...removed.map((l) => `− ${l.trim()}`), ...added.map((l) => `+ ${l.trim()}`)].filter((l) => l.length > 2);
  if (all.length === 0) return { text: '', changed: false };
  if (all.length > maxLines) {
    return {
      text: all.slice(0, maxLines).join('\n') + `\n… (${all.length - maxLines} more changed lines — the page changed substantially; take browser_snapshot for the full picture)`,
      changed: true,
    };
  }
  return { text: all.join('\n'), changed: true };
}

/** Cap a snapshot for model context, cutting at a line boundary with an explicit note —
 *  a silent truncation reads as "that's the whole page" when it isn't. */
export function capSnapshot(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf('\n', maxChars);
  return text.slice(0, cut > 0 ? cut : maxChars) + '\n… (snapshot truncated — the page is larger; scroll or act on what you can see)';
}
