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
- **M3 — Completion presence:** built + smoke-verified (branch `m3-completion-presence`);
  awaiting the live demo with the user (cold announce + bubble flip + pulse) before marking done.
- **M4–M6:** not started. See SPEC §9.

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
