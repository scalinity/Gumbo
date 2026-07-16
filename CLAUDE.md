# Gumbo — repo guide for Claude sessions

Gumbo is the user's personal macOS voice agent. Design source-of-truth is [`SPEC.md`](./SPEC.md);
running changelog + field notes live in [`IMPLEMENTATION_NOTES.md`](./IMPLEMENTATION_NOTES.md) —
**read it before building anything**, and append dated bullets there when you learn something
non-obvious (record *why*, not just *what*).

## Layout

- `daemon/` — Node/TS brain (npm workspace, `tsx watch`, Node 26 built-ins: `node:sqlite`,
  `process.loadEnvFile`, global `WebSocket`, native TS type-stripping). Subfolders per concern:
  `realtime/` (voice orchestrator + its tools), `agents/` (background sub-agent runner),
  `tasks/` (task lifecycle), `events/` (sqlite store), `ws/` (hub + wire protocol), `search/`
  (web-search provider clients).
- `dashboard/` — React 19 + Vite + zustand activity dashboard. **No `useEffect`** — module-scope
  WS singleton → zustand.
- `shell/` — Swift/SwiftUI menu-bar app (notch UI, PTT hotkey, VPIO audio). Owns all TCC grants.
- Daemon binds loopback only; the webview/React layer talks to the daemon over WS/HTTP and must
  never see API keys or call external providers directly.

## Provider-client conventions (established by the web-search work — follow for any new provider)

- **Secrets:** keys live in the repo-root `.env` (`OPENAI_API_KEY`, `EXA_API_KEY`,
  `TAVILY_API_KEY`), loaded by `daemon/src/config.ts` via `process.loadEnvFile`, validated at
  boot in `index.ts`. Keys are read from `process.env` inside the daemon only — never sent to,
  or read by, the dashboard/shell.
- **HTTP + retries:** all provider calls go through `postJson` in `daemon/src/search/client.ts`.
  Retry only 429/5xx, max 2 retries, backoff 500 ms → 1500 ms. **Voice hot path passes
  `retries: 0`** — it fails fast instead of stacking backoff on a waiting voice turn.
- **Typed errors:** throw `SearchError` with `kind` ∈ `timeout | auth | quota | empty_results |
  http | network`. Callers branch on `kind`, never on message strings. 401/403 → `auth`
  (never retried), 429 → `quota`, aborts → `timeout`.
- **Timeouts:** per-call `AbortSignal.timeout`. Hot path budget is
  `config.search.quickLookupTimeoutMs`; background calls get generous budgets (Exa `deep`: 180 s).
- **Audit log:** every outbound search call — success or failure — appends one JSONL line to
  `~/Gumbo/logs/search-audit.jsonl` via `search/audit.ts` (`ts`, `provider`, `endpoint`, `query`,
  `resultCount`, `ok`, `error?`). `logs/` is private (not `/files`-served). New providers must do
  the same.
- **Persistence:** background search results and finished-task reports land in the sqlite `memory`
  table (FTS5-indexed via `memory_fts`) through `store.saveSearchResult` / `store.saveTaskOutput`.
- **Routing:** Tavily (`search/tavily.ts`) serves the realtime `web_quick_lookup` tool only —
  quick factual one-liners, answer-first, spoken. Exa (`search/exa.ts`) serves background
  sub-agent tools only (`web_search`, `fetch_page_contents`) — full page text + highlights,
  deliberately **no `maxCharacters`/truncation anywhere** (quality over token cost). Don't cross
  these streams: the tool descriptions are the router, and their wording is load-bearing.
- **Permissions:** no permission engine exists yet (spec'd for M4). Current stance: hot-path
  lookup is auto-allowed; background research rides the existing spawn-task flow the user triggers
  by voice. When the M4 permission engine lands, register both providers under it with those
  defaults.

## Working rules

- Dev only: `npm run dev` (daemon: `tsx watch`; dashboard: Vite). Don't run build/compile
  commands (`tsc`, `vite build`, `xcodebuild`) unless the user asks — exception: he authorized
  `xcodegen`/`xcodebuild` for `shell/`.
- Daemon tests: `npm test -w daemon` (`node --test`, strip-only TS — no constructor parameter
  properties or other non-erasable syntax).
- Sandboxed runs can't write `~/Gumbo`; set `GUMBO_HOME=<scratchpad>` (and `GUMBO_PORT` to avoid
  colliding with a live daemon on 8737).
- Gumbo addresses the user as **the user**. Minimal implementations only — no speculative features.
