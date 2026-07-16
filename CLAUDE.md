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
  (web-search provider clients), `scrape/` (Firecrawl content-acquisition client).
- `dashboard/` — React 19 + Vite + zustand activity dashboard. **No `useEffect`** — module-scope
  WS singleton → zustand.
- `shell/` — Swift/SwiftUI menu-bar app (notch UI, PTT hotkey, VPIO audio). Owns all TCC grants.
- Daemon binds loopback only; the webview/React layer talks to the daemon over WS/HTTP and must
  never see API keys or call external providers directly.

## Provider-client conventions (established by the web-search work — follow for any new provider)

- **Secrets:** keys live in the repo-root `.env` (`OPENAI_API_KEY`, `EXA_API_KEY`,
  `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`), loaded by `daemon/src/config.ts` via
  `process.loadEnvFile`, validated at boot in `index.ts`. Keys are read from `process.env`
  inside the daemon only — never sent to, or read by, the dashboard/shell.
- **HTTP + retries:** all provider calls go through `requestJson`/`postJson` in
  `daemon/src/search/client.ts` (GET/DELETE exist for async-job polling/cancellation).
  Retry only 429/5xx, max 2 retries, backoff 500 ms → 1500 ms. **Voice hot path passes
  `retries: 0`** — it fails fast instead of stacking backoff on a waiting voice turn.
- **Typed errors:** throw `SearchError` with `kind` ∈ `timeout | auth | quota | empty_results |
  http | network`. Callers branch on `kind`, never on message strings. 401/403 → `auth`
  (never retried), 429 → `quota`, aborts → `timeout`.
- **Timeouts:** per-call `AbortSignal.timeout`. Hot path budget is
  `config.search.quickLookupTimeoutMs`; background calls get generous budgets (Exa `deep`: 180 s).
- **Audit log:** every outbound provider call — success or failure — appends one JSONL line to
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
- **Firecrawl = content acquisition, never search:** `scrape/firecrawl.ts` serves background
  sub-agent tools only (`scrape_page`, `map_site`, `crawl_site`, `extract_structured`) — fetch,
  crawl, map, and extract content from **known URLs/sites**. Firecrawl's `/search` endpoint is
  deliberately not integrated (search belongs to Tavily + Exa), and no Firecrawl tool may ever
  appear in the realtime session config (`realtime/tools.test.ts` asserts this on the registry).
  Persistence exception: map returns URL lists, not page content, so map results are NOT
  persisted to the memory table — scrape/crawl/extract results are.
- **Crawl breadth bounds:** crawls are scope-bounded, not content-clamped — max-pages
  (default 100) + max-depth (default 3) + include/exclude path patterns. The page cap is sent
  as the API `limit` (whose own default is 10 000 pages = 10 000 credits) **and** enforced in
  our client while collecting. Prefer map-then-selective-scrape over blind crawls. robots.txt
  is respected (Firecrawl's default; never set `ignoreRobotsTxt`).
- **Async jobs poll, never webhooks:** the daemon binds loopback, so provider webhooks can't
  reach it. Pattern: submit → poll status on an interval → collect paginated results, under an
  overall job budget from `config`. Task aborts propagate to a remote cancel where the API
  supports it (crawl: `DELETE /v2/crawl/{id}`; extract has no documented cancel — polling just
  stops). Every outbound call — submit, each poll, each pagination fetch, remote cancels —
  gets its own audit line (job routes logged as `/crawl/:id`-style endpoints, target URL as
  `query`); a failed operation adds exactly one op-level failure line.
- **Permissions:** no permission engine exists yet (spec'd for M4). Current stance: hot-path
  lookup is auto-allowed; background research rides the existing spawn-task flow the user triggers
  by voice. Firecrawl `scrape`/`map` are auto-allowed like background search; `crawl` and
  `extract` ride the voice-triggered spawn-task approval flow (they hit many pages on someone
  else's infrastructure — deliberate, not automatic). When the M4 permission engine lands,
  register all providers under it with those defaults.

## Working rules

- Dev only: `npm run dev` (daemon: `tsx watch`; dashboard: Vite). Don't run build/compile
  commands (`tsc`, `vite build`, `xcodebuild`) unless the user asks — exception: he authorized
  `xcodegen`/`xcodebuild` for `shell/`.
- Daemon tests: `npm test -w daemon` (`node --test`, strip-only TS — no constructor parameter
  properties or other non-erasable syntax).
- Sandboxed runs can't write `~/Gumbo`; set `GUMBO_HOME=<scratchpad>` (and `GUMBO_PORT` to avoid
  colliding with a live daemon on 8737).
- Gumbo addresses the user as **the user**. Minimal implementations only — no speculative features.
