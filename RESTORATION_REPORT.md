# Gumbo restoration — 2026-10-17

A signed diagnostic build of the restored app is installed at `~/Applications/Gumbo.app`. Voice uses GPT-Live-1; the tool backend, research/Mac workers and coding sessions use Claude Opus 5.5 through the Anthropic API. Physical speech and interruptions work in repeated use. The first-press presentation issue remains under investigation after a physical retest still failed. Some Opus answers have a noticeable pause.

M9 and later features were not started. This report distinguishes executed checks from behavior retained through tests or source inspection.

## Findings and corrections

| Symptom | Finding and correction | Verification |
|---|---|---|
| Stuck voice/playback after cancellation or connection loss | Stale connection callbacks, pending native requests and audio completion accounting needed explicit invalidation. Added connection/capture generations, pending-request settlement, queue accounting and a playback watchdog. | Daemon lifecycle tests, native playback tests and repeated physical conversations. |
| Transient audio startup failure | Real use reported an unavailable output format while VPIO released/reacquired the device. A bounded retry retains unscheduled PCM; stopping invalidates that retry. Persistent failure remains visible. | Native test forces two zero-rate probes and then drains audio; another test cancels the pending retry. Physical output was audible at normal speed. |
| Blank native activity window | WebKit returned navigation error -1008 for `localhost:5173` despite successful HTTP responses. `127.0.0.1:5173` restored the rendered dashboard. The underlying hostname-specific OS failure is unknown. | Direct native inspection shows the activity feed and “daemon connected.” No OS protection or TCC setting was disabled. |
| Missing replies after Live migration | A complete user transcript sometimes produced neither an answer nor a delegation before the response watchdog expired. The provider's internal cause is unknown. One fallback dispatches the settled request to Opus; late delegation IDs attach to the same execution. Old interrupted captions cannot mark a new request answered. | Regression tests, a three-request live sequence with interruptions, a forced fallback through real Opus/Live, and repeated physical use. |
| Pauses after “Sure”; incomplete spoken story | Acknowledgments could disable recovery. Separate short commentary updates could also omit earlier answer content. Acknowledgments now leave recovery active. Short answers travel in one update; longer answers are supplied as quiet numbered context before one speech request. | A live five-sentence story arrived complete. Long-answer staging is unit tested; extended spoken fidelity is not yet verified. |
| First hotkey press appears ignored | The shell required a daemon “listening” acknowledgment before showing locally armed capture. It now opens from local capture state, with the UI update queued before cold audio startup. This is a demonstrated state-merge defect; it does not prove every missed physical key event had that cause. | Native test observes an opaque notch window while daemon state is still idle. Physical retesting still failed; temporary native tracing is ready for the next attempt. |
| Mac task stops while the computer is in use | Ordinary input triggered takeover cancellation. Control–Shift–Escape is now the explicit stop shortcut; ordinary keyboard/mouse use leaves tasks running. | Native shortcut tests and a real Finder task that created/opened a disposable folder, read back its location and persisted its report. |
| Notch reopening/fade behavior | DynamicNotchKit 1.1.0 is the latest stable upstream release checked. Existing local serialization of visibility transitions and disabled hover holding passed repeated native checks. No additional padding or clipping fix was justified by a reproduced geometry defect. | Ten expansion/collapse cycles, including five reopen-during-fade cases: one opaque, centered, top-anchored panel, with final hidden state. These establish lifecycle/geometry, not frame-by-frame visual perfection. |

## Provider and architecture changes

| Responsibility | Active implementation |
|---|---|
| Live voice | `gpt-live-1`, raw primary WebSocket via `ws` to `/v1/live/sessions`; client delegation, Marin, 24 kHz mono PCM16. |
| Voice/text tool backend, research, Mac workers, supervisor inference, procedures, vision and file rewrites | `claude-opus-5-5`, official `@anthropic-ai/sdk` 0.135.0, streaming Messages, adaptive thinking, automatic tool choice. |
| Coding sessions | `claude-opus-5-5`, `@anthropic-ai/claude-agent-sdk` 0.3.302. The older bundled CLI was rejected for this model; the updated CLI completed a real sandboxed API turn. |
| Existing tool definitions | `@openai/agents` 0.13.3 and zod remain for validated function schemas/invokers. Execution uses the Anthropic loop. The existing `openai-runner.ts` filename remains. |
| Context sizing | `js-tiktoken` 1.0.21, local o200k encoding with 450-token chunks and headroom below Live's 500-token append limit. Live does not publish a model-specific tokenizer mapping. |
| Search, images and cold announcements | Existing Exa/Tavily/Grok/Firecrawl routing remains. Image generation and one-shot speech retain their dedicated OpenAI models. |

The voice adapter does not send legacy Realtime commit/create events or infer completion from an output-done event. It maintains a paced input clock, buffers first speech until unmute acknowledgment, sends silence when PTT is released, gates output silence and lets actual native playback drive speaking state. Typed input reaches the backend without opening a paid Live session. Background tasks do not keep idle voice sessions open.

The Anthropic loop preserves native tool-use IDs, assistant/thinking blocks, cancellation, tool-local confirmations, steering, container reuse and server-tool continuation. Hosted Code Interpreter maps to Anthropic hosted code execution. Unsupported tool transports fail explicitly.

Both provider credentials were verified with real requests. Keys remain in the daemon. Coding children receive a short-lived local relay token; the relay injects the actual Anthropic key and accepts only Messages/count-tokens requests for the configured model. Secret stripping, protected paths, Seatbelt, CONNECT filtering and the supervisor hook remain active. Configured Context7 HTTP MCP connected through the actual sandbox/proxy path and exposed two tools. Inherited claude.ai connectors are not available through this API-authenticated configuration.

Live duration is finalized once from cumulative provider usage, with lost finalization marked estimated. Anthropic token/cache usage records the returned model and billed provider. Coding-session cost is labeled estimated. Container-time charges cannot be derived from tool-request counts and are not included in token-only totals.

Official protocol references: [Live migration](https://developers.openai.com/api/docs/guides/live-migration), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview). Dependency reference: [DynamicNotchKit releases](https://github.com/mrkai77/DynamicNotchKit/releases).

## Verification matrix

“PASS” describes the named check only; it is not a claim of exhaustive coverage.

| Criterion | Status | Method / result |
|---|---|---|
| Real microphone → GPT-Live → audible speaker output | PASS | Physical Control–Option speech produced input/output transcripts; direct listening confirmed audible normal-speed output. |
| Repeated replies and conversational interruption | PASS | Repeated physical tests, including changing story length mid-reply; latest feedback reports working answers with occasional slight lag. |
| First press visibly opens the notch after idle | FAIL | The local display-state regression passes, but a physical retest still ignored the first attempt. Native hotkey/visibility tracing is in progress. |
| Silent/short presses and rapid capture cancellation | PASS | Daemon PTT/VAD tests and native generation/cancellation tests. Not every case was repeated physically. |
| Local playback drain, flush and stale completion handling | PASS | Native audio lifecycle tests with real output hardware and controlled PCM. |
| Device-format recovery | PASS | Native forced zero-rate/retry/cancel tests. A second physical route-loss event has not been reproduced. |
| Provider/transport failures settle visibly | PASS | Mocked lifecycle tests plus observed real connection/voice timeout failures during development. |
| Native WebSocket disconnect and old callbacks | PASS | Pending Mac requests settle immediately; native test rejects stale socket callbacks. |
| Daemon restart and dashboard reconnection | PASS | Repeated development restarts and installed-app reopen; connected activity feed observed. |
| Idle voice timeout | PASS | Real session closed after idle; final duration accounting tested. |
| No missing-response hang in tested sequence | PASS | Live recovery test plus latest physical conversation. The provider's intermittent behavior remains a residual risk, handled by fallback/watchdog. |
| Real computer action and independent observation | PASS | Opus invoked Finder AppleScript, created/opened the disposable probe folder and queried the front window; Finder and filesystem state were observed. |
| Computer task status, report and memory persistence | PASS | Real task reached `done`, wrote `report.md` and stored matching `task_output` text. |
| Ordinary input does not cancel background work | PASS | Explicit shortcut native regressions and successful real retry after removing automatic takeover cancellation. |
| Explicit stop/cancellation propagation | PASS | Native shortcut and daemon task/bridge tests. Physical emergency-stop testing during a live paid task was not repeated. |
| Relevant macOS permissions | PASS | Actual microphone, playback, Accessibility/Finder and Apple Events paths worked with the retained signing identity. This does not cover every target app or Screen Recording route. |
| Typed question/tool/worker routing, microphone independent | PASS | Live typed request through Opus spawned the Finder worker and displayed its result; provider-mocked typed routing regressions cover the direct backend path. |
| Research provider | PASS | Real Opus/Exa search completed. The isolated research harness needed a corrected persistence call after model completion; common task persistence was separately verified with the real Mac task. |
| Coding API authentication and sandboxed model execution | PASS | Real Opus API response from the wrapped Claude CLI. |
| Coding plan approval, file edit and cross-restart resume on the new SDK | NOT VERIFIED | Existing tests retained; a complete new live editing/approval/resume scenario was not run. |
| Configured MCP through sandbox/proxy | PASS | Real Context7 connection and tool discovery, without a paid model request. |
| Hosted code execution compatibility | PASS | Adapter tests cover server-tool mapping and continuation. Actual remote code execution was not smoke-tested. |
| Provider/model usage accounting | PASS | Real usage rows plus mocked cumulative/finalization and token/cache pricing tests. Container charges remain outside token totals. |
| Context/tool association and persisted state | PASS | Delegation ID, late delegation, history/tool-result tests; real follow-up speech and persisted Mac task report. |
| Native notch geometry and repeated lifecycle | PASS | Ten cycles, including five fade/reopen cases, and recording/pulse checks. |
| Seam-free, flicker-free animation across appearances/displays | NOT VERIFIED | No frame-by-frame native motion capture or external-display/scaling qualification. Static geometry is not a substitute. |
| Transcript generation resets and state presentation | PASS | Caption-generation tests, native state tests and physical interactions. |
| Microphone privacy and local PTT boundaries | PASS | Capture gating, short/silent input and late permission callback tests; playback-only graph does not request microphone capture. OS-indicator behavior was not exhaustively exercised on every route. |
| M1–M8 regression suite | PASS | 557 daemon tests: **556 passed, one intentional skip**. Covers tasks, search, reminders, images/files, procedures, approvals, sandbox policy and costs. These are not fresh live demos of every feature. |
| Native regression suite | PASS | **11 tests passed**: eight restoration tests and three pre-existing local input/notch tests. Two additional earlier notch lifecycle tests also passed. |
| Full TypeScript check | FAIL | Existing test typing and teaching-protocol mismatches remain. No diagnostic names the new Live/Anthropic adapters. Runtime tests pass; typechecking is not reported green. |
| Installed signing identity and permission continuity | PASS | Exact designated requirements matched; strict signature verification passed before and after replacement. No TCC reset. |
| Unrelated working changes | PASS | Pre-existing changes remain outside the commits except overlapping behavior explicitly superseded by the requested provider/stop-control changes. |
| Credential exposure / test spending | PASS | Added-line public-push scans found no credentials or private-path/link hits. Approximately **$3.70** was recorded across checks and physical use at this review; small direct probes add cents. No paid test was allowed to run unbounded; the assignment ceiling was $5. |

## Changed files and retained boundaries

- Voice: `daemon/src/realtime/{live,session,backend-prompt}.ts`, focused Live/delegation/lifecycle/session tests, `config.ts`, `index.ts` and `ws/protocol.ts`.
- Workers/authentication: `daemon/src/agents/{anthropic,anthropic-relay,claude-runner,egress-proxy,openai-runner,supervisor,procedures,vision}.ts`, adapter/relay/worker regressions, `files/edit.ts`, `tasks/manager.ts` and `usage/pricing.ts`.
- Native lifecycle/UI: `shell/Sources/App.swift`, `Audio/AudioEngine.swift`, `Daemon/WSClient.swift`, `DashboardWindow.swift`, `Mac/{KillSwitch,MacBridge}.swift`; daemon `ws/mac.ts` and its tests.
- Native tests/build instructions: `shell/RestorationTests/`, `shell/tests.yml` and `shell/README.md`.
- Dependencies/documentation: `daemon/package.json`, `package-lock.json`, `.gitignore`, `SPEC.md`, `AGENTS.md`, `CLAUDE.md`, `IMPLEMENTATION_NOTES.md` and this report.

The installed build includes pre-existing local `NotchController.swift` visibility serialization and `Hotkeys.swift` modifier polling. Those changes remain uncommitted; a fresh remote checkout alone will not reproduce that exact installed state. Other pre-existing specification/research notes, local tests and project settings remain separate. No `ORCHESTRATION.html` exists, so there was no overview to realign.

Raw test logs and disposable probes remain locally under `/tmp/gumbo-restoration`; the previous signed app is retained in `~/Applications/Gumbo-backups.noindex`. They are not published. Avoid treating temporary logs as a permanent test archive.

## Remaining limits

The first-press issue remains unresolved after physical retesting. Further diagnosis is blocked on the pending physical two-press check: the UI automation available here cannot emit modifier-only keypresses. The installed diagnostic build logs modifier/capture/notch timing locally, with no speech or typed text. Temporary instrumentation is kept outside the repository and does not change action behavior. Seam/flicker and multi-display acceptance remain unverified. Occasional backend latency remains audible; selecting a cheaper/faster worker was not substituted for the requested Opus model. Long spoken answers can be paraphrased by Live. Full typechecking still fails on existing issues, and new-SDK coding edit/approval/resume plus every M1–M8 live feature were not fully exercised. The app remains a local development installation tied to its checkout.
