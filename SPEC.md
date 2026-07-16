# Gumbo — Specification

> Gumbo is a personal, always-alive voice agent for macOS. Talk to it; it orchestrates work by
> spawning background sub-agents, runs and supervises interactive Claude Code sessions, generates
> images, and drives the Mac itself. It lives in the MacBook notch, shows background work as
> screen-corner bubbles, and surfaces everything in a clean "activity center" dashboard.
>
> **Personal use only. Local machine only. Single user (the user).** No auth, analytics, telemetry,
> CI/CD, or deployment infra beyond what local development needs.

This is the source-of-truth spec. It is organized by build phase (M1–M6). A companion running log
lives in [`IMPLEMENTATION_NOTES.md`](./IMPLEMENTATION_NOTES.md). The original approved plan is at
`~/.claude/plans/<local-plan>.md`.

---

## 1. Product vision

A voice-first personal agent that feels alive and present without a window open:

- **Presence** — a notch app with live audio bars (idle / listening / thinking / speaking). Click it
  and a minified dashboard drops down from the notch.
- **Delegation** — the agent is an orchestrator. Ask for real work and it spins off sub-agents
  (generic OpenAI agents for research/writing; full Claude Code sessions for code/file/shell work),
  reports back when they finish, and never makes you wait.
- **Background swarm** — each running sub-agent is a bubble in the upper-right of the screen; multiple
  can run at once. Click a bubble to expand its activity.
- **Computer use** — the agent can drive any app (type into text boxes, open/quit apps, set
  reminders) with a **visible agent cursor** so you can watch it work.
- **Images** — generate images on request; they load in the dashboard and as notch/bubble thumbnails.
- **Activity center** — a desktop dashboard showing transcripts, tool calls, sub-agent feeds, images,
  and history. Clean, modern, minimalist.

---

## 2. Locked decisions (from the design interview — do not relitigate)

| Area | Decision |
|---|---|
| Orchestrator | The **voice model itself** (`gpt-realtime-2.1`) calls tools directly. Heavy planning is delegated *into* sub-agents, not done by the voice loop. |
| Generic sub-agents | OpenAI Agents SDK agents on **`gpt-5.6-terra`**, with **Exa** web search (`exa-js`) + hosted code interpreter. |
| Code/file/shell tasks | Full **Claude Code** sessions via `@anthropic-ai/claude-agent-sdk`, one workspace (`cwd`) per session. |
| Claude Code supervision | Each interactive Claude Code session is paired with a dedicated **supervisor agent** (`gpt-5.6-terra`) that answers its questions, gates permissions per policy, and escalates. |
| Claude billing | **Subscription auth** (the Claude Code CLI login). No `ANTHROPIC_API_KEY` in the daemon env. |
| Activation | Global hotkey / click-the-notch **push-to-talk**. The hotkey is **Control + Option held together** (a modifier-only chord). Session opens on demand, stays warm briefly, idle-closes. **Wake word is v2** (audio path reserves the seam). |
| Computer-use guardrails | Free navigation/typing/drafting. **Gate irreversible acts** — sending (message/email/post), deleting, paying, or acting in an app not on the allowlist requires a notch confirmation. **Kill switch** = hotkey or moving the real mouse. |
| Completions | When a sub-agent finishes: bubble flips to done + notch pulses + `report.md` written + dashboard entry + a **brief spoken announcement** ("your sub-agent finished the X task"). Inject into a live session if one is open, else one-shot TTS — **never open a realtime session just to announce**. |
| Shell | Native **Swift/SwiftUI** app owns the notch, bubbles, agent cursor, audio, macOS automation, and all TCC permissions. Dashboard is a **React** app in a `WKWebView` window. Brain is a **Node/TypeScript** daemon. |
| User's name | The agent addresses the user as **the user** (macOS username is `dev`). |
| Agent home | `~/Gumbo/`, kept **organized into subdirectories** — never a flat dumping ground. The agent can **manage its own organization**. |

---

## 3. System architecture

```
┌────────────────────────────┐        WS :8737 (JSON + binary audio)      ┌──────────────────────────┐
│  Swift shell  (Gumbo.app)  │  ◀──────────────────────────────────────▶  │  Node daemon  (the brain) │
│  · notch (DynamicNotchKit) │                                            │  · OpenAI Realtime session │
│  · bubbles (upper-right)   │                                            │  · task manager            │
│  · agent-cursor overlay    │        WKWebView → http://localhost:5173   │  · sub-agent runners       │
│  · AVAudioEngine mic/spkr  │  ◀──────────────────────────────────────▶  │  · Claude Code runner (M4) │
│  · hotkey (⌃⌥)             │                                            │  · supervisor (M4)         │
│  · AX / CGEvent / EventKit │                                            │  · image gen (M5)          │
│  · owns ALL TCC grants     │                                            │  · sqlite event store      │
└────────────────────────────┘                                            │  · WS hub + HTTP (/api,    │
                                                                          │    /files)                 │
        ┌───────────────────────────┐                                     └────────────┬──────────────┘
        │  React dashboard          │   WS live-tail  +  /api history                  │
        │  "activity center"        │  ◀───────────────────────────────────────────────┘
        │  zustand, NO useEffect    │              OpenAI Realtime / Agents / Images · Claude Agent SDK · Exa
        └───────────────────────────┘
```

**Why this split:** every polished notch/overlay app is native Swift, and macOS attributes TCC
permissions (mic, Accessibility, Screen Recording, Reminders) to one signed app bundle — so the
native surfaces live in Swift. The agent logic and both SDKs are TypeScript, so the brain is a Node
daemon. The dashboard is web tech (fast to build a rich activity center) rendered in a WKWebView the
Swift shell owns. The three talk over a local WebSocket + HTTP.

### Component responsibilities

- **Daemon (`daemon/`)** — the only component that holds API keys and talks to model providers. Owns
  the Realtime orchestrator session, the tool registry, the task manager, sub-agent runners, the
  event store, and the WS/HTTP servers. Bound to **loopback only**.
- **Shell (`shell/`, M2+)** — native macOS surfaces + audio + automation. A thin WS client of the
  daemon. Holds no secrets.
- **Dashboard (`dashboard/`)** — read-mostly activity center + a text composer (the M1 driver before
  voice exists). Talks to the daemon over WS (live) and HTTP (history). **No `useEffect`** (hard
  user constraint): a module-scope WS singleton feeds a zustand store.

---

## 4. Model & SDK inventory (pins)

Confirm exact IDs against the live API at implementation time; all live in `daemon/src/config.ts`.

| Purpose | Model / package | Notes |
|---|---|---|
| Voice orchestrator | `gpt-realtime-2.1` | via `@openai/agents/realtime`, **websocket** transport from Node. Swap point for future GPT-Live is this one constant. |
| Generic sub-agents + supervisor | `gpt-5.6-terra` | via `@openai/agents` `run()` (streaming). |
| Web search | **Exa** `exa-js` | custom `tool()` wrapping `searchAndContents`. `EXA_API_KEY` in `.env`. |
| Images (M5) | `gpt-image-2` | Images API, base64 → `~/Gumbo/images/`. |
| Code/file/shell tasks (M4) | Claude Code | `@anthropic-ai/claude-agent-sdk` `query()` streaming input, subscription auth. |
| Realtime SDK | `@openai/agents` ≥ 0.13 | requires **zod v4**. |
| Event store | Node built-in `node:sqlite` | no native module; Node 26+. |
| Dashboard | React 19 + zustand 5 + Vite 6 | no `useEffect`. |

---

## 5. Agent home & self-organization

`~/Gumbo/` (override with `GUMBO_HOME`) is **organized by concern** and created on daemon boot:

```
~/Gumbo/
├── tasks/<id>/          # one workspace per task — report.md, (M4) supervisor.md, agent scratch files
├── images/              # generated images (M5)
├── notes/<topic>.md     # agent-curated durable knowledge (self-organization)
└── db/gumbo.db          # sqlite — deliberately OUTSIDE the /files-served subtree
```

- Only `tasks/`, `images/`, and `notes/` are reachable via `GET /files/<name>/…`. The database is
  never servable.
- **Self-organization** is a first-class capability. M1 ships `save_note` (one file per topic,
  append or replace) so the agent retains durable knowledge across sessions instead of dumping
  everything in one place. Future phases extend this toward the agent curating, archiving, and
  reorganizing its own home (see M4+ and computer-use), always confined to the agent home.

---

## 6. WS protocol & event model

**Transport:** one WebSocket at `ws://127.0.0.1:8737/ws`. Text frames are JSON envelopes; binary
frames (M2+) carry audio with a 1-byte header (`0x01` realtime pcm16, `0x02` one-shot TTS). First
message from any client is `hello {role: 'shell' | 'dashboard'}`. The server enforces an **Origin
allowlist** (browsers must be `localhost:5173`; the native shell sends no Origin → allowed).

**History vs live:** the dashboard loads history over HTTP (`/api/events`, `/api/tasks`) on connect,
then live-tails events over WS. The store **merges** the HTTP snapshot with any events that arrived
during the fetch (deduped by `seq`) so nothing is dropped.

**Event envelope** (persisted, fanned out to dashboards): `{ seq, ts, task_id, type, payload }`.
Current event `type`s: `transcript.user`, `transcript.assistant`, `tool.call`, `tool.result`,
`subagent.message`, `task.created`, `task.finished`, `note.saved`, `announce.pending`,
`session.opened`, `session.closed`, `session.error`. M4 added `claude.message`, `claude.tool_use`,
`claude.tool_result`, `claude.plan` (a plan awaiting the user's approval), `supervisor.decision`, and
`task.status` (mid-run `needs_input` ⇄ `running` flips — plan review, confirm pending, intervention
cap, resume). M5 adds `image.created` (payload carries the **filename only** — base64 never rides
the event stream; edits add `edited_from` lineage + `selection`) and the scheduler lifecycle:
`reminder.set`, `reminder.fired`, `reminder.cancelled`. M5.5 adds `image.edit_requested` and
`image.edit_failed` (the shell viewer leaves its busy state on the latter).

**Message types** (see `daemon/src/ws/protocol.ts`, extended per phase):
- shell → daemon: `hello`, (M2) `ptt_start`/`ptt_stop`, mic binary, `confirm_response`,
  `kill_switch`, (M5) `reminder_created`, (M5.5) `image_context` (open image + brush strokes;
  what voice edits target) / `image_edit_request` (typed edit), (M6) `ax_tree`/`ax_result`/
  `screenshot`.
- daemon → shell: `session_state`, speaker binary, `audio_interrupted`, `notch_transcript`,
  `bubble_upsert`/`bubble_remove`, `notch_pulse` (M5 adds status `reminder`), `confirm_request`,
  (M5) `create_reminder`/`remove_reminder`, (M6) `computer_cmd`.
- dashboard ⇄ daemon: `hello`, `debug_text`, `task_action{cancel}`; daemon → `event`,
  `session_state`, `assistant_delta`.

---

## 7. Audio path (M2)

- **Capture:** `AVAudioEngine` tap (48 kHz float32) → `AVAudioConverter` → **24 kHz mono pcm16** (the
  Realtime default input format, so the daemon transcodes nothing) → 20 ms binary WS frames →
  `session.sendAudio()` verbatim.
- **Playback:** daemon relays `session.on('audio')` pcm16 → shell schedules on `AVAudioPlayerNode`.
- **Turn-taking:** server-side semantic VAD. **Barge-in:** SDK `audio_interrupted` → daemon forwards
  → shell stops playback + drops queued buffers.
- **Wake-word seam (v2):** `AudioEngine.start(reason:)` — a future `.wakeWord` reason runs the tap
  into a local detector before any cloud traffic. Nothing downstream changes.
- **Position:** browser-WebRTC voice is explicitly **not** used; M1 drives the whole loop via the
  dashboard text composer instead (tools live in the daemon; browser voice would be throwaway).

---

## 8. Security posture (single-user local tool)

Even as a personal tool, the daemon holds API keys and can spend money, so:

- **Loopback bind** (`127.0.0.1`) — never all interfaces. No LAN device can reach it.
- **No wildcard CORS** — the dashboard reaches `/api` and `/files` through the Vite dev proxy.
- **WS Origin allowlist** — blocks cross-origin WebSocket drive-by from any page the user visits.
- **`/files` is confined** to `tasks/`, `images/`, `notes/` with a canonicalize + prefix guard and a
  `realpath` symlink re-check; the database is outside the served subtree.
- **Parameterized SQL** everywhere.
- **Prompt-injection** is inherent to web-search agents (web content → sub-agent → `read_report` →
  orchestrator). Blast radius is bounded (sub-agents have only Exa + hosted code interpreter, no
  local shell; the orchestrator's worst case is spawning more tasks / burning credits). Revisit when
  M4 gives agents shell access — that is what the Claude Code supervisor + permission gates are for.

---

## 9. Phases

Each phase is independently demoable. **M1, M2, and M3 are complete.** Later phases list scope,
not final code.

### M1 — Brain, text-driven  ✅ DONE

**Goal:** the delegation spine, drivable by text before voice exists.

- Daemon: config, `node:sqlite` event store (tasks + events, WAL, status `CHECK`, restart reaper),
  WS hub (role-tagged, Origin allowlist), HTTP (`/api/tasks`, `/api/events`, `/files/*`).
- Realtime orchestrator (`gpt-realtime-2.1`, text output) driven by dashboard `debug_text`; lazy
  connect, 60 s idle-close, tool-call + transcript persistence.
- Tools: `spawn_subagent`, `list_tasks`, `get_task_status`, `cancel_task`, `read_report`,
  `save_note`.
- Generic sub-agent runner (`gpt-5.6-terra` + Exa web search + hosted code interpreter), streamed
  events, `report.md` per task, cancellation via `AbortSignal`.
- Completion pipeline: status update + `task.finished` + spoken announcement (inject if live, else
  `announce.pending`).
- Dashboard activity center: live transcript, tool calls, sub-agent feed, task rail with cancel,
  streaming assistant line, report viewer, history bootstrap, text composer. Dark-roux palette,
  "simmer bars" state indicator (previews the notch).

**Demo:** type a research request → watch the sub-agent stream → `report.md` lands → ask "is it
done?" → grounded answer. Survives daemon restart (history from sqlite).

**Verification:** driven end-to-end via the dashboard; `save_note`, cancel, restart-reaper, loopback
bind, CORS removal, and `/files` db-protection all confirmed live. See IMPLEMENTATION_NOTES.

### M2 — Swift shell + voice  ✅ DONE

**Goal:** the always-alive notch presence and real voice.

- xcodegen app (`shell/project.yml`): `LSUIElement`, `NSMicrophoneUsageDescription`, App Sandbox
  **off**, **Apple Development signing + stable bundle ID from day one** (ad-hoc signing loses TCC
  grants every rebuild).
- Notch UI via **DynamicNotchKit**: idle / listening / thinking / speaking states + live audio bars +
  a transcript line; click to drop down a minified dashboard.
- **Hotkey = Control + Option held together.** This is a modifier-only chord, so bind it with an
  `NSEvent` `.flagsChanged` global monitor (detect `⌃`+`⌥` both down, nothing else) rather than a
  key-plus-modifier library like `KeyboardShortcuts`, which models modifier+letter. Clicking the
  notch is the alternate trigger. Requires Accessibility (global monitor) — grant early.
- Full audio path (§7) incl. barge-in and idle-close. WS client with reconnect. `WKWebView` window
  hosting the dashboard.

**Demo:** hold ⌃⌥, speak the M1 scenario, interrupt mid-sentence; walk away and the session closes
itself.

**Verification:** live hold-⌃⌥ voice round-trips through the signed shell (VAD, PTT commit
semantics, transcripts, notch states); daemon-only smokes covered barge-in and both release
styles. Voice-exercised barge-in + the TCC rebuild-persistence check remain to observe in daily
use. See IMPLEMENTATION_NOTES §M2 for the build log and gotchas.

**Deferred:** wake word.

### M3 — Completion presence  ✅ DONE

**Goal:** background work you can feel without the dashboard open.

- Upper-right **bubbles**: one non-activating `NSPanel` per task — shipped as breathing
  Metal-shader **orbs** (ember plasma while running, cooled bay when done) that click-expand
  **in place** into a mini observability panel (live activity tail + history; full dashboard is
  the panel's ⤴ link); **notch pulse** on completion.
- **Spoken announcements** cold (no live session): one-shot TTS (`gpt-4o-mini-tts`, `marin`, pcm)
  via `0x02` audio frames — never opens a realtime session just to announce. Live-session
  completions deliver the report's key finding directly (no "task finished — want details?").
- Follow-ons landed with M3: playback-truthful `session_state` (`playback_state` from the shell,
  no idle-close mid-drain), read-along notch transcript paced to audio actually heard, mic-free
  playback audio graph (mic opens only during PTT), current-date injection + hard search recency
  filter, bare-notch click-to-dashboard, custom pot menu bar icon.

**Verification:** live with the user (cold announce, bubble flip, barge-in, TCC persistence) +
daemon smokes (cold path: zero `session.opened`, sample-aligned 0x02 frames; lifecycle: re-sync,
pulse, linger) + a 2-agent review/address pass (2 criticals found and fixed — see
IMPLEMENTATION_NOTES §M3). TCC risk #3 closed.

### M4 — Claude Code + supervisor  ✅ built + review-hardened (daemon smokes green; live voice demo pending)

**Goal:** delegate real code/file/shell work and supervise it autonomously.

- `claude-runner`: `@anthropic-ai/claude-agent-sdk` `query()` streaming input, one `cwd` per session
  (the named `project_dir` when the user gave one, else the task workspace — report.md +
  supervisor.md always land in the workspace), **subscription auth** (no `ANTHROPIC_API_KEY` in
  env; `USER` required for the keychain lookup), resume by persisted session id across daemon
  restarts via `send_to_session`.
- New tools: `spawn_claude_session` (title, brief, nullable `project_dir`), `send_to_session`.
- **Plan-then-execute** (the user, 2026-07-16): a fresh session runs read-only in `permissionMode:
  'plan'`, presents its plan (`ExitPlanMode` → `claude.plan` event + a notch confirm), and only
  builds after the user approves — then it switches to `'auto'` atomically. Resumes/follow-ups skip
  planning (already a direct instruction). Decline/timeout parks `needs_input` (resumable).
- **Execution runs in "auto mode" + a PreToolUse hook** (the user, 2026-07-15/16): `'auto'` lets the
  CLI's classifier auto-run safe actions with zero supervisor calls, but it bypasses `canUseTool`,
  so the supervisor's gate rides a **PreToolUse hook** (fires in every mode). A **pure policy
  table** decides: safe ops **defer** to the classifier; the **hard-escalate class** — `git push`,
  `sudo`, deletes outside `cwd`, network sends (curl/wget uploads, `gh` writes, mail) — routes to a
  notch confirm, deny on timeout. Every escalation/answer logs `supervisor.decision`.
- **Supervisor** (`gpt-5.6-terra`) holds the task brief and is invoked **only** when Claude asks
  (AskUserQuestion → answered on the user's behalf), capped per session (`maxInterventions`, default
  5) — past the cap the run interrupts and the task parks `needs_input`.
- **Resilience:** a supervisor-model outage degrades to a safe default instead of killing the run;
  hitting the turn/budget limit **parks** (resumable) rather than failing; an auth-expired session
  reports "log in again"; file checkpointing backs up edits so a live session can be undone
  (`undo_session`); a second session on the same `project_dir` is refused (concurrent-edit guard).
- `needs_input` is first-class: task.status events, gold beacon orb, dashboard rail state.
- Dashboard: Claude stream + supervisor-decision + plan feeds.

**Demo:** "have Claude add a `--json` flag to <project>" → Claude presents a plan → the user approves
on the notch → Claude edits under `cwd` → a `git push` escalates to the notch → completion
announced (delivery-first). Kill the daemon mid-session and resume via voice.

**Verification:** spikes (a) subscription auth + (b) supervisor canned-event harness passed; 95
daemon unit tests green; live daemon smokes (real Claude session on a scratch repo) — the original
auto-mode flow (`--json` flag, git push escalate→deny→honor, resume) AND the M4.0-hardening flow
(plan-mode approve→execute, `--loud` verified, git push escalated via the hook under `'auto'`,
checkpointing). Remaining to observe live with the user: the voice-driven flow end-to-end (spawn by
voice, plan-approval + notch confirm answers, completion announcement).

### M4.1 — OS-level sandbox for Claude sessions (planned)

**Why:** the supervisor policy table is a heuristic speed-bump, not a container — a regex tokenizer
can't fully parse a shell (`eval`, `$(…)`, `/bin/rm`, interpreter one-liners all slip past), and
Claude reads attacker-influenceable web/file content. M4 mitigates the *common* escapes; M4.1 makes
the filesystem/network boundary **deterministic**.

**Scope:** enable the Agent SDK's `sandbox` option on Claude sessions so commands run in an OS
sandbox (macOS Seatbelt / `sandbox-exec`; the SDK notes bubblewrap on Linux and *fails closed* on
unsupported platforms — so **spike macOS 27-beta support first**, this project's discipline). The
sandbox confines filesystem writes to the session `cwd` + task workspace and blocks outbound
network by default; the supervisor policy table then narrows to what it's actually good at —
**semantic** confirms (git push is legitimate-but-worth-confirming) rather than trying to be
containment. Keep plan-mode, the PreToolUse hook, and the escalations; layer the sandbox under them.
Set `failIfUnavailable: true` (fail closed) and surface a clear message if the platform can't
sandbox, rather than silently running unconfined. Kick this off as its own supervised Claude
session (prompt in IMPLEMENTATION_NOTES §M4.1).

### M5 — Images + a Gumbo-owned scheduler (reminders)  ✅ built (daemon tests + smoke green; live voice demo pending)

- `generate_image` (`gpt-image-2`, id + response shape verified live 2026-07-16): base64 PNG
  decoded daemon-side into `~/Gumbo/images/`, `image.created` event carrying the **filename
  only**, dashboard gallery thumbnail (from `/files/images/`) with a lightbox. Generation takes
  tens of seconds, so the tool acks instantly and a brief spoken completion rides the M3
  announce path when the file lands (no task/workspace — deliberately lightweight).
- **Reminders = a persistent Gumbo-owned scheduler**, not a one-shot. sqlite `schedule` table
  (`id, fire_at, kind, text, status pending|fired|cancelled, eventkit_id, created_at`) + a
  ~20 s poll loop (`daemon/src/schedule/`): due pending rows are marked fired (at-most-once),
  emit `reminder.fired`, and are spoken via the M3 announce pipeline — injected into a live
  session, else cold one-shot TTS (`0x02`) + a gold notch pulse; **never opens a session just
  to remind**. Restart-safe: rows persist, polling resumes on boot, and the restart reaper
  never touches schedule rows. `kind` + the text payload are the extensibility seam (recurring
  digests, timed task spawns later) — M5 ships only `kind:'reminder'`, one-shot.
- `set_reminder(text, fire_at)` does BOTH halves, complementary: (a) a schedule row — Gumbo's
  own awareness, spoken when awake; (b) `create_reminder` → shell **EventKit**
  (`requestFullAccessToReminders` + `NSRemindersFullAccessUsageDescription`, not AppleScript —
  100× slower) → a Reminders.app entry that fires at the OS level even if the daemon is off or
  the Mac is asleep; the shell replies `reminder_created` with the EventKit id, stored on the
  row. The orchestrator resolves natural time ("at 5", "in 10 minutes") to an absolute local
  ISO date-time (its instructions carry today's date **and time**); the daemon validates it's
  in the future. `list_reminders` / `cancel_reminder` complete the scheduler (cancel removes
  the row and best-effort removes the EventKit twin via `remove_reminder`).
- **Honest limitation, designed around (not fought):** the poll loop only fires while the
  daemon runs — a sleeping Mac fires late, on wake. EventKit is the reliable delivery; the
  daemon scheduler is Gumbo's spoken presence when awake. Both together = complete.
- Dashboard: images gallery + an upcoming/fired reminders list (bootstrap via `/api/images` +
  `/api/schedule`, live via `image.created` / `reminder.*` events; no `useEffect`).
- **M5.5 — image thumbnails + in-place editing (the user, 2026-07-16):** a new image surfaces as a
  **thumbnail bubble** stacked directly beneath the task orbs (top-right); click → an enlarged
  **full-resolution viewer/editor** panel. The viewer carries a **brush select tool** — paint the
  area to change (bright inside, dimmed outside) — and takes edit requests **typed** (composer in
  the panel → `image_edit_request`) or **by voice** (normal ⌃⌥ turn; the viewer arms
  `image_context` — open file + strokes — on the daemon, and the orchestrator's `edit_image` tool
  resolves "this image"/"the highlighted area" from it, so coordinates never pass through the
  voice model). Strokes travel as normalized polylines; the **daemon rasterizes the mask**
  (`images/mask.ts`, zero-dep PNG encoder) and calls `gpt-image-2` on `/v1/images/edits`
  (verified live: transparent mask pixels = edit region, source dimensions preserved). Edits are
  **non-destructive**: each lands as a new `image.created` with `edited_from` lineage; the open
  viewer swaps to the new version and its thumbnail replaces the parent's.

**Demo:** "make me a wallpaper of a swamp at dusk and remind me at 5 to review it."

### M6 — Computer use v1

- Swift primitives over WS: `AXUIElement` tree read/diff, click element, type via `CGEvent`,
  ScreenCaptureKit screenshot. **AX-tree-first, screenshot+vision fallback.**
- **Agent cursor**: transparent click-through fullscreen `NSWindow` at `.screenSaver` level with an
  animated fake cursor view (prior art: `farzaa/clicky`). Never intercepts real clicks.
- Dedicated computer-use sub-agent driving the primitives.
- **Guardrails:** free navigation/typing/drafting; send/delete/pay/off-allowlist → **notch confirm**;
  **kill switch** = hotkey or real-mouse movement (event tap → `AbortController`).

**Demo:** "open Notes and draft a packing list" with the visible fake cursor; jiggle the real mouse
and it halts instantly. Notes scenario completes AX-only (no screenshots in the event log).

**Deferred (post-M6):** wake word; GPT-Live model swap; computer-use polish (multi-display,
allowlist UI, scrolling heuristics); launchd auto-start; deeper agent self-organization (archiving /
reorganizing its home).

---

## 10. Risks & de-risking spikes

1. **Swift → WS → Realtime audio pipe** — ½-day throwaway echo spike (mic → 24 kHz pcm16 → WS → echo
   back → play) before any notch UI.
2. **Claude subscription auth from a daemon context** — 15-line `query()` script under `env -i`;
   confirm it answers on subscription auth; note `pathToClaudeCodeExecutable` fallback.
3. **TCC persistence across dev rebuilds** — sign with a real Apple Development cert + stable bundle
   id from day one; verify mic + Accessibility grants survive a rebuild.
4. **Supervisor ↔ Claude loop stability** — canned-event harness (2 questions + 1 dangerous
   permission); assert sensible answers, correct escalation, intervention cap.
5. **macOS 27 beta × DynamicNotchKit** — hello-world on this exact build first; pin the version;
   it's MIT, vendor it if broken. (This Mac runs a macOS 27.0 beta — notch geometry, ScreenCaptureKit,
   and TCC behavior all churn on betas.)

**Standing risk:** a realtime voice model as sole orchestrator is the design's weakest link.
Mitigations: ≤ ~10 forgiving tools (single free-text `brief` params), spawn tools return task ids
instantly, planning pushed into sub-agents. Expect iteration on the orchestrator instructions.

---

## 11. Repo layout & dev commands

```
Gumbo/
├── package.json            # npm workspaces: [daemon, dashboard]
├── .env                    # OPENAI_API_KEY, EXA_API_KEY  (loaded via process.loadEnvFile)
├── SPEC.md                 # this file
├── IMPLEMENTATION_NOTES.md # running build log
├── daemon/                 # Node/TS brain
│   └── src/{index,config,http}.ts, ws/, realtime/, tasks/, agents/, events/
├── dashboard/              # React + Vite activity center
│   └── src/{main,App}.tsx, ws.ts, store.ts, index.css
└── shell/                  # Swift/SwiftUI app (M2+; xcodegen project.yml)
```

- Daemon: `npm run dev:daemon` (`tsx watch`). Dashboard: `npm run dev:dashboard` (`vite`).
- **No build commands** on the JS side (dev servers only, per user rules). The Swift app is built/run
  from Xcode (unavoidable; flag at M2).
- `GUMBO_HOME` overrides the agent home (used for isolated/sandboxed runs).
- Requirements: OpenAI + Exa keys in `.env`; (M2) `brew install xcodegen` + an Apple Development cert;
  (M4) a logged-in Claude Code CLI.

---

## 12. Glossary

- **Orchestrator** — the live `gpt-realtime-2.1` session; the voice brain that calls tools.
- **Sub-agent** — a spawned background worker. Generic = OpenAI `gpt-5.6-terra`; code = Claude Code.
- **Supervisor** — the per-Claude-Code agent that answers questions and gates permissions (M4).
- **Task** — one unit of delegated work with a workspace, status, and event stream.
- **Bubble** — an upper-right screen panel representing one running task (M3).
- **Agent cursor** — the visible fake cursor shown while the agent drives the Mac (M6).
- **Announcement** — a brief spoken completion notice (injected live, or one-shot TTS).
- **Agent home** — `~/Gumbo/`, the organized directory the agent works and stores state in.
