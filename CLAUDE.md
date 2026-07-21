# Gumbo — repo guide for Claude sessions

Gumbo is a personal, always-alive macOS voice agent for a single user — the user — on this one
machine. Talk to it; it orchestrates background sub-agents, supervises Claude Code sessions,
generates images, sets reminders, and drives the Mac itself, all from the notch. Capability,
efficiency, and presence are the product. Its gating stack (policy table + Seatbelt + egress
proxy + notch confirms) exists to make MORE autonomy safe to ship — safety machinery here buys
autonomy, it never spends it on governance for its own sake.

Design source-of-truth is [`SPEC.md`](./SPEC.md) (M1–M7 built and merged; M8 built on a worktree,
pending live demos + merge; M9–M17 planned); running build log + field notes live in
[`IMPLEMENTATION_NOTES.md`](./IMPLEMENTATION_NOTES.md) —
**read it before building anything**, and append dated bullets there when you learn something
non-obvious (record *why*, not just *what*).

## What this is — and what it must never become

One principal, one machine, ~five action channels, ~five egress sinks, a voice surface, cheap
undo. Every design decision flows from that shape — never from internet or enterprise
conventions generalized past their assumptions.

- **The the user-moment test (the binding build filter, SPEC §cross-cutting):** before building
  any sub-item, name the concrete moment in the user's day it serves — "what did my sister text me",
  "undo that", "what's this beeping", "stop asking about this". "A paper recommended it" /
  "the field converged here" is context, never a reason. Mechanisms whose real audience is a
  fleet, a team, or an untrusted insider fail this test by construction: those principals do
  not exist here.
- **The friction economy (five rules, SPEC §cross-cutting; rule wins over phase text):**
  friction follows irrecoverability — reversible acts announce-and-undo instead of asking, and
  track record only ever loosens gates (never a new ask); at most one prompt per action, decided
  by one pure `decide()`; effects attach to channels, not tools; provenance is a per-task
  source-set checked at the egress sinks; no silent negatives.
- **Never build (standing rejections — SPEC's rejected lists are load-bearing, check them
  before proposing anything governance-shaped):** hash-chained/tamper-evident journals,
  statistical autonomy calibrators ahead of a felt need, policy-activation review beyond one
  confirm card, workflow-engine state breadth for personal intentions, up-front
  memory-curation/lineage machinery, platform-first substrate sequencing (effect layers arrive
  per channel), and everything on SPEC's out-of-scope list (telemetry, multi-tenant anything,
  payment rails, remote surfaces).
- **Vocabulary (binding, docs and code alike):** "rules" never "laws"; "the user's standing
  rules" never "constitution"; `decide()` never `verdict()`; "track record" / "history" never
  "evidence" as gating vocabulary; "activation card" never "ceremony"; the user "approves",
  never "ratifies". Plain personal language over legal/compliance register, everywhere. Examples
  use roles — "my sister", "the landlord", "the dentist" — never invented person names.
- **Docs state the current design, not its history of removals.** When a design changes, write
  the new state cleanly — no "(previously X)" trails or references to what was cut. Dated
  provenance tags on the design itself (`(specced 2026-07-19)`, `(amended …)`) are fine and used
  throughout SPEC; it's removal-narration that belongs only in IMPLEMENTATION_NOTES.

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
  `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`, `XAI_API_KEY`), loaded by `daemon/src/config.ts` via
  `process.loadEnvFile`, validated at boot in `index.ts`. Keys are read from `process.env`
  inside the daemon only — never sent to, or read by, the dashboard/shell. Every provider key
  must also be in `config.secretEnvKeys` so it's stripped from spawned Claude Code sessions.
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
- **Grok (xAI) = live X/real-time-social, both tiers:** `search/grok.ts` serves a hot-path
  realtime tool (`x_lookup` → `xLookup`, spoken `{answer,sources}`/`lookup_failed`, `retries:0`)
  AND a background sub-agent tool (`x_search` → `grokLiveSearch` `style:'detailed'`, `retries:2` +
  task signal, persisted to `memory` as provider `'grok'`). Grok closes a real gap — Exa/Tavily
  barely see inside X. **Agent Tools API** (`POST /v1/responses` + server-side `web_search` +
  `x_search` tools) — the old declarative Live Search (`/chat/completions` + `search_parameters`)
  is **decommissioned (HTTP 410)**; don't reach for it. Answer is the trailing `output[]` item of
  `type:'message'` → `content[].output_text.text`; sources are its `annotations[]` of
  `type:'url_citation'`. The model injects inline `[[n]](url)` markers — **stripped** for speech.
  Sources are **X+web** (catch a post OR a blog) but the tool descriptions are **X-first** so
  routing stays clean vs Tavily's general-facts lane — don't cross the streams.
  **TIERED MODELS (measured live):** hot path uses `config.grok.hotModel`
  (`grok-4.20-non-reasoning`, ~2–8 s) because the reasoning model `grok-4.5` ran **28–45 s** on
  the hot path (non-viable — `max_tool_calls` does NOT bound the reasoning loop, so it's not sent;
  the per-call timeout is the real guard). Background uses `config.grok.backgroundModel`
  (`grok-4.5`) for depth. Hot-path budget `quickLookupTimeoutMs` (15 s) headroom over the ~11 s
  tail; on timeout → `lookup_failed`. `realtime/tools.test.ts` asserts `x_lookup` is registered
  alongside `web_quick_lookup`. **Any new provider needs a live smoke** (docs lag deprecations —
  Context7 still described the 410'd surface). Deferred: the sub-agent MODEL swap to Grok, and
  A-style multi-provider consensus.
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
- **Permissions:** the search/scrape providers still have no dedicated engine — hot-path lookup
  is auto-allowed; background research + Firecrawl `scrape`/`map` are auto-allowed; `crawl`/
  `extract` ride the voice-triggered spawn-task approval flow. **M4 added a permission model for
  Claude Code sessions only** (see `agents/supervisor.ts`): auto mode + a pure policy table gate
  the session; the hard-escalate class (git push, sudo, deletes outside cwd, network sends) goes
  to a notch confirm. **M4.1 wraps the WHOLE Claude CLI in a macOS Seatbelt sandbox** (file tools
  included) as the deterministic containment underneath — see the M4.1 gating note below.

## M4 Claude-session gating (auto mode + hook — follow this exactly)

- Sessions run `permissionMode: 'auto'` for execution (fresh sessions plan first in `'plan'`,
  then approve-and-switch to `'auto'`). **`'auto'` bypasses `canUseTool`** — the CLI classifier
  auto-runs safe ops. So the supervisor's escalations and question-answering ride a **PreToolUse
  hook** (`claude-runner.ts` → `supervisor.gateForHook`), which fires in every mode. `canUseTool`
  is left with ONLY the ExitPlanMode plan-approval mode switch (atomic via `updatedPermissions:
  [{type:'setMode', mode:'auto'}]` — never call `setPermissionMode` inside `canUseTool`/a hook,
  it reentrant-deadlocks). The intervention cap interrupts via a `setImmediate`-scheduled
  `query.interrupt()` for the same reason.
- **FOOTGUN (latent, review 2026-07-16):** the runner leaves `settingSources` at default, so a
  session loads the user's `~/.claude` skills/agents/CLAUDE.md — AND his `settings.json` permission
  rules. A `Bash(...)` allow rule there resolves before the supervisor and would silently ungate
  that command class. the user has no allow rules today (verified), so it's inert — but if
  escalations ever stop firing, check `~/.claude/settings.json` `permissions.allow` first.

## M4.1 OS sandbox (whole-CLI Seatbelt wrap — governs file tools AND bash; rebuilt 2026-07-16)

- **The WHOLE CLI runs under macOS Seatbelt.** `buildSandboxProfile(cwd, taskId)` +
  `sandboxWrappedSpawn` (`claude-runner.ts`) launch the CLI as `sandbox-exec -p <profile> <cli>`
  via the SDK's `spawnClaudeCodeProcess` seam — so the CLI's **own file tools** (Read/Write/Edit/
  Grep) are OS-confined too, not just spawned bash. macOS forbids nesting a second sandbox, so this
  **REPLACES** the SDK `sandbox` option (do not re-add it — `sandbox_apply` EPERMs under the wrap).
- **Safety net, not a cage (the user):** the profile is `(allow default)` MINUS three subtractions —
  (1) **writes** confined to cwd + task workspace + runtime/cache dirs (`~/.claude`, `$TMPDIR`,
  `~/.npm`, `~/.cache`, `~/Library/Caches`); (2) **secret reads** denied (`.env`, `~/.ssh`, `~/.aws`,
  gh/npm/cloud tokens); (3) **network default-deny** — every direct socket denied, only loopback to
  the egress proxy re-allowed. Reads are otherwise open. Same "safety net not cage" spirit on the
  network: known hosts flow freely, unknown ones ESCALATE to a notch confirm (not a hard 403).
- **Egress filtering proxy (M4.1 follow-up, 2026-07-16 — network flipped OPEN → default-deny):**
  `egress-proxy.ts` is a loopback CONNECT proxy running UNSANDBOXED in the daemon; the CLI reaches it
  via `HTTPS_PROXY`, so the CLI AND any bash it spawns are forced through one choke point (a single
  Seatbelt layer can't split CLI-vs-bash egress by IP — that's why the proxy exists). Allowlisted host
  → tunnel; unknown → `Supervisor.escalateHost` (same notch confirm as git-push, deny-on-timeout,
  memoized per session). Allowlist = base (Anthropic + inherited exa MCP + dev/registry hosts) +
  config MCP hosts (derived from URLs) + `config.claude.sandbox.allowedDomains`. **No DNS rule** — the
  proxy resolves upstream. This CLOSED the Keychain/transcript GET-exfil residual for attacker hosts.
- **Fail-closed** twice, pre-spawn: `sandboxUnavailableReason` (non-macOS / missing `sandbox-exec` →
  `CLAUDE_SANDBOX_ERROR`) and a proxy that won't bind → `CLAUDE_PROXY_ERROR`. No unconfined/unfiltered run.
- **Capability:** CLIs work (read+exec; egress via the proxy — allowlisted hosts flow, unknown ones
  confirm; `firecrawl` uses its own stored auth, so the env-strip stays intact). Context7 docs MCP is
  wired via `config.claude.mcpServers` on top of the inherited `~/.claude` MCPs, and connects through
  the proxy (MCP-over-HTTP honors `HTTPS_PROXY`). Inherited MCP hosts the runner can't see (e.g. the
  claude.ai Tavily connector) escalate on first use — add to `allowedDomains` if needed headlessly.
- **Belt-and-suspenders (still in supervisor.ts):** `protectedPathHit` hard-`deny` + edit-outside-cwd
  escalate remain — redundant with the OS layer for `.env` but give a clean message and cover the
  Read tool on `~/.claude` (OS-readable so the CLI can read its own state). The policy's network-SEND
  escalation stays as the semantic layer for approved-host sends (git push). Keep all routes.
- Full rationale, the nesting/network trade-offs, and the egress-proxy verification are in
  IMPLEMENTATION_NOTES §M4.1 (REBUILT + the egress-proxy entry) — read it before touching
  sandbox/secret-path/network handling. On SDK/CLI upgrade, re-verify the sandbox spawn seam and
  the MCP-through-proxy path (the M4.1 spike checks, described in IMPLEMENTATION_NOTES §M4.1) as a
  gate.

## Working rules

- Dev only: `npm run dev` (daemon: `tsx watch`; dashboard: Vite). Don't run build/compile
  commands (`tsc`, `vite build`, `xcodebuild`) unless the user asks — exception: he authorized
  `xcodegen`/`xcodebuild` for `shell/`.
- Daemon tests: `npm test -w daemon` (`node --test`, strip-only TS — no constructor parameter
  properties or other non-erasable syntax).
- Sandboxed runs can't write `~/Gumbo`; set `GUMBO_HOME=<scratchpad>` (and `GUMBO_PORT` to avoid
  colliding with a live daemon on 8737).
- Gumbo addresses the user as **the user**. Minimal implementations only — no speculative features;
  when in doubt, apply the the user-moment test.
