# Gumbo — Implementation Notes

A running log of what got built, decisions made along the way, gotchas hit, and things future
sessions need to know. Append newest entries at the top of each phase. The design source-of-truth is
[`SPEC.md`](./SPEC.md); this file is the changelog + field notes.

**Convention for future sessions:** when you build or change something non-obvious, add a dated bullet
under the relevant phase. Record *why*, not just *what* — especially SDK quirks, version constraints,
and anything that would surprise the next person. Keep it honest (note what's verified vs assumed).

---

## Status

- **M1 — Brain, text-driven:** ✅ complete and verified end-to-end.
- **M2–M6:** not started. See SPEC §9.

---

## Environment facts (verified)

- Node **v26.3.1**, npm 11.16 (Homebrew). Node 26 gives us built-ins we rely on: `node:sqlite`
  (`DatabaseSync`), `process.loadEnvFile`, and a global `WebSocket`.
- This Mac runs a **macOS 27.0 beta** — spike DynamicNotchKit + TCC behavior early (M2 risk).
- `.env` at repo root holds `OPENAI_API_KEY` and `EXA_API_KEY`.
- **No git repo** yet — fixes are applied without commits (matches the user's "don't commit unless
  asked" rule). Initialize git when the user asks.
- **Sandbox note:** automated/sandboxed dev runs can't write to `~/Gumbo`; use
  `GUMBO_HOME=<scratchpad>` to run the daemon in those contexts. the user created the real `~/Gumbo`.

---

## M1 — Brain, text-driven

### Build (initial)
- Monorepo: npm workspaces `daemon` (Node/TS, `tsx watch`) + `dashboard` (React 19 + Vite 6 + zustand).
- Event store on **`node:sqlite`** (no `better-sqlite3` — avoids native-module builds lagging Node 26).
  WAL mode; `tasks` + `events` tables.
- Orchestrator = `gpt-realtime-2.1` over **websocket** transport, `outputModalities: ['text']` for
  M1 (flip to `['audio']` at M2). Driven by a dashboard `debug_text` composer.
- Generic sub-agents = `gpt-5.6-terra` via `@openai/agents` `run()` streaming, with a custom
  `web_search` tool wrapping `exa-js`, plus the hosted `codeInterpreterTool()`.
- Dashboard honors the **no-`useEffect`** rule via a module-scope WS singleton (`ws.ts`) → zustand.

### Gotchas hit
- `@openai/agents` 0.13 requires **zod v4** (peer dep); zod 3 fails `npm install`.
- `exa-js` (1.10) default import doesn't expose a named `WebSocket`-style export; use
  `import { Exa } from 'exa-js'` and `exa.searchAndContents(query, { text: { maxCharacters } })`
  (the `contents:{...}` shape from older docs is wrong for this version).
- Node ESM with `.ts` import specifiers needs `allowImportingTsExtensions: true` in tsconfig.
- Bug found during first verification: orchestrator (voice-model) tool calls weren't being logged —
  only sub-agent tool calls were. Fixed by also listening to the transport `function_call` event in
  the Realtime session.

### Review + address pass (2-agent /review-2, then /address)
Two Opus reviewers (debugger + auditor) reviewed the M1 codebase. **All findings addressed.** Notable:

- **CRITICAL — orchestrator wedge:** the `connecting` promise was only nulled on the success path, so
  a single transient connect failure left every future message awaiting a permanently-rejected
  promise (Gumbo dead until restart). Fixed with `try/finally` nulling `connecting` on both paths.
- **CRITICAL — network exposure:** daemon bound all interfaces + wildcard CORS + no WS origin check,
  so any website the user visits could drive the agent (burn credits) and `fetch('/files/gumbo.db')`
  to exfiltrate the whole task DB; any LAN device could `curl` it. Fixed three ways: bind
  `127.0.0.1`, delete the wildcard CORS header (dashboard uses the Vite proxy), add a WS
  `verifyClient` **Origin allowlist** (no-Origin native clients allowed → the future Swift shell).
- **Restart reaper:** tasks left `running` when the daemon dies (frequent under `tsx watch`) now get
  reaped to `failed` on Store init, so status stays truthful. Verified: flipped a task to `running`,
  restarted, it became `failed` with `"interrupted by daemon restart"`.
- **Cancellation:** the `AbortSignal` is now passed into `run()` so cancel actually aborts the model
  request (previously only stopped event forwarding, kept billing).
- **Task completion correctness:** switched to two-arg `.then(onFulfilled, onRejected)` so a failure
  while *writing* the report can't mislabel a succeeded task; `finish()` is now idempotent (guards a
  `finished` set) so no double `task.finished` / double-announcement.
- **Announcement collision:** completion announcements now prefer `transport.requestResponse?.()`
  (defers until any in-flight response completes) instead of a raw `response.create` that the server
  rejects mid-turn.
- **`/files` hardening:** restricted to `tasks/`/`images/`/`notes/` subtrees + `realpath` symlink
  re-check; **DB moved to `db/gumbo.db`**, outside the served subtree entirely. Stream now has an
  `error` listener so a mid-read I/O error can't crash the daemon.
- **Dashboard:** bootstrap now **merges** the HTTP snapshot with live-arrived events (deduped by
  `seq`, sorted) instead of a blind replace that dropped events arriving during the fetch window;
  `ReportPanel` gets a remount `key` so switching between two done tasks refetches; `Row` is
  `React.memo` and the streaming line is isolated into its own component so per-token updates don't
  re-render the whole feed; a **cancel button** on running tasks wires up the previously-dead
  `cancelTask` export. Tasks array is capped (200).
- Smaller: `EXA_API_KEY` validated at boot alongside OpenAI; inbound WS payloads shape-guarded;
  `status` `CHECK` constraint on the tasks table; magic truncation length centralized as
  `config.activityLogMaxChars`.

### New requirements folded in (from the user, this session)
- **Organized agent home:** `~/Gumbo/` is no longer flat — `tasks/`, `images/`, `notes/`, `db/`,
  created on boot. Only the first three are `/files`-served; the DB is private.
- **Agent self-organization:** added a `save_note` tool (one file per topic under `notes/`, append or
  replace) so Gumbo can retain durable knowledge across sessions. Verified live: asked it to save an
  editor preference → `notes/editor-preference.md` created. Deeper self-organization (archiving,
  reorganizing) is specced for later phases.
- **Name:** the agent addresses the user as **the user** (not the user). Applied to orchestrator
  instructions + announcement template.
- **Hotkey (spec only — Swift is M2):** mic activation is **Control + Option held together**. This is
  a modifier-only chord, so it must be detected with an `NSEvent` `.flagsChanged` global monitor
  (both `⌃` and `⌥` down, no letter), *not* a modifier+key binding library. Captured in SPEC §9 M2.

### Verified in M1 (how)
- Full research round-trip driven from the dashboard (Playwright): sub-agent streamed 5 Exa searches,
  `report.md` landed, follow-up "one-line takeaway" correctly triggered `read_report`.
- Daemon restart → dashboard history re-rendered from sqlite (persistence).
- Post-fix live checks: loopback bind (`lsof` shows `127.0.0.1` only), no CORS header, `/files`
  cannot reach `db/gumbo.db` (404 for both `../db/…` and `db/…`), restart-reaper flips `running`→
  `failed`, `save_note` writes an organized note, WS origin allowlist admits both the dashboard
  (`localhost:5173`) and a no-origin native client.

### Open items / assumptions to confirm later
- Model IDs (`gpt-realtime-2.1`, `gpt-5.6-terra`, `gpt-image-2`) are pinned in `config.ts`; confirm
  against the live API when each is first exercised.
- `transport.requestResponse` existence is feature-detected with a `sendEvent` fallback — validate
  against the installed SDK build when audio lands.
- Synchronous sqlite + broadcast run on the same event loop as the Realtime transport. Fine at M1
  (events are per run-item, low rate). Revisit batching/offload when M2 puts audio frames on the loop.

---

## M2+ — not started
(Append notes here as phases land.)
