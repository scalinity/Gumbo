# Gumbo — Specification

> Gumbo is a personal, always-alive voice agent for macOS. Talk to it; it orchestrates work by
> spawning background sub-agents, runs and supervises interactive Claude Code sessions, generates
> images, and drives the Mac itself. It lives in the MacBook notch, shows background work as
> screen-corner bubbles, and surfaces everything in a clean "activity center" dashboard.
>
> **Personal use only. Local machine only. Single user (the user).** No auth, analytics, telemetry,
> CI/CD, or deployment infra beyond what local development needs.

This is the source-of-truth spec. It is organized by build phase (M1–M17; M1–M7 built and merged,
M8 built on a worktree and pending live demos + merge, M9–M17 are the personal-capability roadmap).
A companion running log lives in
[`IMPLEMENTATION_NOTES.md`](./IMPLEMENTATION_NOTES.md). The original approved plan is at
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
| Cloud processing | **Accepted** for the Realtime orchestrator under a one-time standing grant per connector/data class. The daemon minimizes every connector result before model ingress; raw media still needs its own explicit release. No second local orchestrator. |
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

### M6 — Computer use v1 (design refined + locked with the user, 2026-07-16)

**Two tiers, one domain — the same physics as the search lanes (hot one-shot vs background loop).**
The realtime registry grows by **≤2 tools total** for the whole domain — deliberately no per-verb
tools (`open_app`/`quit_app`/…): the voice model's router degrades as the toolbox bloats, and
generic primitives subsume the verbs anyway.

- **Hot tier — `mac_do(script)`, one realtime tool:** one-shot commands ("open Chrome to
  claude.ai", "dark mode on", "how many Time Machine backups?") — the voice model writes the
  bash/osascript one-liner itself (these are memorized idioms; spawning a sub-agent for a 100 ms
  `open -a` is wrong by voice). Policy-gated in the M4 spirit: read-only/reversible → auto-run;
  risky patterns (send/delete/pay, `sudo`, `rm` outside agent home, …) → **notch confirm** via the
  existing `ConfirmBridge`. Every execution appends one JSONL audit line (`mac-audit.jsonl`, same
  shape as `search-audit.jsonl`). No-TCC commands run daemon-side (`execFile`); TCC-bound scripts
  route to the shell (placement below). This tool runs OUTSIDE the Claude-session Seatbelt — the
  gate + audit ARE the mitigation (accepted trade-off, the user 2026-07-16).
- **Multi-step tier — the computer-use sub-agent:** "open X, navigate there, do the task" without
  the user dictating steps. Runs in the **existing background sub-agent runner** (`agents/` —
  in-daemon loop, in-process tools; NOT the sandboxed Claude CLI — no MCP/Seatbelt/TCC threading),
  reached via `spawn_subagent` (description widened to cover on-Mac tasks; +1 realtime tool at
  most). **The voice model NEVER drives the act→observe loop:** each iteration would round-trip a
  shallow latency-optimized model, and every AX snapshot would sit in the voice session's context
  for the rest of the session — the same split that put Grok's reasoning model on the background
  tier only.

**Primitives (sub-agent toolbox — breadth is cheap there, unlike the realtime registry):**

- `ax_snapshot` — **compacted** AX tree of the target/frontmost window: actionable elements only,
  role/label/value/frame, window scoping, depth caps. **The full tree never enters LLM context**
  (a Slack-scale window ≈ 8k elements / 200–800 KB raw): the SHELL holds the snapshot (ref →
  `AXUIElementRef` map, recreated per snapshot — live refs are never cached across event-loop
  ticks) and the sub-agent gets a flat one-line-per-element interactive sample + summary, with a
  slice/grep RPC for more. Refs are opaque and **valid for one snapshot generation** (prefer
  `AXIdentifier` when the app sets one — the only selector stable across runs); a stale ref is a
  typed error, never a nearest-match guess, and coordinates never enter the primary action space
  (ref-based grounding eliminates the wrong-coordinate failure class AND measurably resists
  prompt injection vs pixels). Compaction + settle-detection are the engineering meat — mechanics
  and perf budgets in IMPLEMENTATION_NOTES §M6 (batched attribute reads, BFS + depth cap,
  role-filter during traversal, per-element messaging timeouts; ~50 ms focused-window read).
- `ax_act` — press/focus/set-value/type by ref, via the **dispatch ladder** (2026 consensus):
  AX action first (`AXPress` — background-safe, works on occluded elements, never moves the
  pointer) → pid-targeted synthetic event (`CGEventPostToPid`) → global `CGEvent` last (drags are
  global-only; right-click on Chromium = `AXShowMenu`). Keyboard shortcuts where AX has no verb —
  and as the *preferred* fallback for stubborn widgets. **The tool settles, then auto-returns
  post-action state as a server-side before/after DIFF** (`+`/`−`/`~` lines, volatile fields
  stripped; empty diff = a real no-op signal) + `{ok, error_kind}` — the model never acts blind
  and never has to *decide* to re-observe (Playwright-MCP/Terminator contract; kills the
  assume-success failure mode structurally, not by prompt alone). **Verify by diff, never by
  return code** — `AXPress` false-passes on backgrounded/disabled items. Settle = debounced
  AXObserver notifications (~150–300 ms of silence) wrapped by poll + timeout (destroyed/changed
  notifications drop silently on Sequoia/Tahoe). Typed errors mirror `SearchError.kind`:
  `element_not_found | stale_ref | ax_unavailable | timeout | out_of_scope` (`stale_ref` →
  re-snapshot). `wait_for(role, name)` covers slow transitions — waits live in the tools, never
  as model-issued sleeps. Electron/web fields: set `AXManualAccessibility` on first touch
  (plain Chrome: `AXEnhancedUserInterface`) and type via key events, not `AXValue` writes.
  **Secure fields: subrole `AXSecureTextField` → the SWIFT EXECUTOR hard-refuses read/type**
  (policy lives in the executor, never the prompt) and surfaces to the user.
- `run_script` — bash/osascript for the scriptable world (app dictionaries, `tmutil`, `defaults`,
  `open`) **plus `shortcuts run <uuid>`** — the sanctioned App Intents bridge (when an intent
  exists it beats any UI drive; discover via `shortcuts list --show-identifiers`; ALWAYS under a
  timeout — a prompting shortcut hangs forever). Same gate + audit as `mac_do`. Hard per-call
  timeouts are mandatory across this lane: Tahoe regressed Apple-Events timing (scripts hang to
  the 2-min `-1712` timeout on some apps) — one more reason the raw AX + CGEvent layer outranks
  System Events scripting when both can do the job.
- **Browser lane (revised by the 2026-07-16 research pass):** browsers are AX's *worst* terrain
  (lazy, enormous renderer trees) — and AppleScript's page reach is shallow (tabs/URLs yes;
  reliable in-page action no). **v1: URL/tab-level work only**, via `run_script`
  (`open` / Chrome dictionary). Multi-step *in-page* web tasks are out of M6 scope — the
  consensus channel is a dedicated Playwright/CDP lane with a11y-snapshot+ref tools (deferred,
  post-M6); never drive a browser through OS-level AX. One lane per surface; the tool
  descriptions are the router (load-bearing wording, as with Tavily/Exa/Grok — don't cross the
  streams).
- **Screenshot+vision stays deferred — but the seam is typed NOW:** observations are
  `{kind: 'ax' | 'screenshot', …}` from day one, so the vision lane later slots in without loop
  surgery (for hollow trees — canvas, games, Qt/OpenGL, AX-hostile Electron). **Sparse-tree
  escape hatch:** a near-empty actionable set is *detected* (typed `ax_unavailable`; cross-check
  against Finder — a guaranteed AX tree — to split "app has no tree" from "permission silently
  broke") → fall back to the keyboard/`run_script` lane, or fail cleanly with "app not
  AX-automatable" — never grind the loop against an empty tree. When vision does land: on-device
  Vision-framework OCR is the middle step before any cloud vision model, and ScreenCaptureKit
  brings the separate Screen Recording TCC grant.

**Loop contract (research pass folded in 2026-07-16 — evidence + sources in IMPLEMENTATION_NOTES
§M6):**

- **Never act blind, never assume success:** `ax_act` auto-returns settled state (above), and the
  sub-agent's instructions carry the verification rule — after each step, evaluate the returned
  state before the next; verify **states, not elements** ("am I on the compose window?" survives
  layout drift where element checks break). Every task *starts* with an observe-first
  "is it already done?" check (idempotency).
- **Budgets, all of them:** max-steps (default ~50, hard cap 100) + wall-clock + a harness-side
  **repetition detector** — same action on same target ×3 injects a warning turn (redundant
  looping is a top-4 documented computer-use failure class; the detector is cheap).
- **Recovery, layered:** unexpected-dialog check before acting (generic Escape/dismiss
  affordance); on repeated failure, return to a known state (re-focus app, close stray windows)
  instead of forward-flailing; login/permission prompts are classified **states** that pause or
  escalate to the user — never retried through.
- **Context policy:** keep the last 2–3 snapshots verbatim; older ones collapse to one-line
  placeholders ("[snapshot omitted — Mail main window]"); long outputs land in the task
  workspace (file-system-as-context — Gumbo tasks already have one).
- **Injection posture:** all UI-read text is **untrusted data, never instructions** — stated in
  the sub-agent's instructions. NOTE: the Claude API's built-in computer-use injection
  classifiers run ONLY on the official screenshot `computer_*` tool type — a custom AX toolset
  gets none of that, so Gumbo's own gates (notch confirm + policy + audit) carry the entire
  injection load.
- **Model note:** the research sweet spot for text-observation loops is a Sonnet-class model at
  medium effort (with text observations, vision-grounding gaps between models matter much less).
  Runner model choice stays the user's call at build.

**Placement — the reminders idiom, third client (confirms were the second):** brain = sub-agent in
the daemon; hands = shell. New WS RPC pair (`mac_action` / `mac_action_result`, correlation id,
pending-map + timeout modeled on `ConfirmBridge`; fail-safe error when no shell is connected). The
shell executes AX via Swift `AXUIElement` under its **one Accessibility grant (already granted —
covers ALL target apps; no per-app prompts, and no Screen Recording until the vision fallback)**;
osascript Apple-Events targets prompt Automation per target app (`NSAppleEventsUsageDescription`
required in Info.plist). **Permission health is a state machine, not a boolean:**
`AXIsProcessTrusted()` has a documented stale-cache failure (returns true while every real call
fails; persists on Tahoe) — the shell probes LIVE state (listen-only `CGEvent.tapCreate` +
a functional walk of Finder's tree), retries ~3× then prompts a relaunch, and reports health over
the RPC so the daemon can tell "action failed" from "permission silently dead".

- **Agent cursor:** transparent click-through fullscreen `NSWindow` at `.screenSaver` level with an
  animated fake cursor view (prior art: `farzaa/clicky`). Pure visualization — the AX and
  pid-targeted rungs never move the real pointer (only the rare global rung, e.g. drags, does);
  the ghost cursor animates to each target's `AXFrame` with a brief highlight ring before the
  action fires. Never intercepts real clicks.
- **Guardrails:** free navigation/typing/drafting; send/delete/pay/off-allowlist app → **notch
  confirm**; **kill switch = hotkey or HUMAN input — synthetic input must be distinguishable**
  (research correction 2026-07-16: "any mouse movement aborts" self-triggers once the dispatch
  ladder's global rung moves the real pointer). Tag every agent-synthesized event (dedicated
  `CGEventSource` user-data), run a listen-only event tap, and any UNTAGGED HID input = the user =
  instant abort (event tap → `AbortController`, propagating through the existing task-cancel
  path). Secure-field deny (executor-level); one audit line per performed action.

**Demo:** "open Notes and draft a packing list" with the visible fake cursor; jiggle the real mouse
and it halts instantly. Notes scenario completes AX-only (no screenshots in the event log). Hot
tier: "open Chrome and go to claude.ai" → a single `mac_do`, sub-second, no sub-agent spawned.

### M7 — Computer use v2: full-surface coverage + cooperation (specced 2026-07-16; build after M6)

v1 proves the loop on AX-clean native apps; v2 closes the two observation/action surfaces v1
deliberately punted (in-page web, AX-hostile apps) and upgrades interruption into cooperation.
Same loop, same guardrails, same audit — new LANES only; nothing here changes the M6 contracts.

- **Browser lane, in-page (the deferred Playwright/CDP channel):** a DEDICATED automation browser
  profile driven via Playwright/CDP — never the user's live profile (anti-bot systems flag CDP
  sessions; a burned live profile is unacceptable blast radius; attaching to the live browser
  would also require a permanently open debug port and fight Chrome's profile singleton — asked
  and re-declined 2026-07-20). The automation profile is PERSISTENT (`launchPersistentContext`,
  amended 2026-07-20 — the user wants uBlock): logins stick the moment he performs them (Chrome
  owns the disk state; the original capture-once-replay storage-state machinery is retired), and
  extensions he installs once from the Web Store ride along (Playwright's default
  `--disable-extensions` is stripped; branded Chrome no longer honors `--load-extension`
  side-loading, so Web-Store-into-profile is the supported route). Chrome's password manager is
  disabled at profile creation — "no stored passwords, ever" holds; the on-disk cookie store is
  secret-class like state.json was (script-gate pattern + Seatbelt deny cover `~/Gumbo/browser`
  wholesale). Tools mirror the AX contracts
  exactly — `browser_snapshot` (a11y tree + one-generation refs; Playwright-MCP prior art),
  `browser_act` (settles, auto-returns post-action state, same typed `error_kind`s),
  `open_url`/`navigate` first-class — so the sub-agent learns ONE loop discipline across lanes.
  One lane per surface: descriptions route (the Tavily/Exa convention), and OS-AX still never
  touches a browser window. Cursor continuity: CDP element bounds → screen coords → the same
  ghost cursor rides over web pages. Known holes recorded up front: cross-origin iframes need
  explicit frame switching; canvas/WebGL is invisible to the tree (vision fallback); anti-bot
  walls on major consumer sites → a clean "site blocks automation" failure, never an evasion
  arms race.
- **Web injection posture (pages are the #1 injection vector):** M6's untrusted-text rule stands,
  PLUS: any send/submit/purchase inside the browser lane → **notch confirm regardless of the
  allowlist** (an allowlisted SITE is not trusted CONTENT), and the audit line carries the URL.
- **Vision observation lane (fills the `{kind:'screenshot'}` seam):** entered ONLY via the
  sparse-tree escape hatch (`ax_unavailable`, canvas regions) — never the default. Two rungs
  before any cloud pixels: (1) on-device Vision-framework OCR overlay with deterministic hint
  labels, `(*)` marking OCR-only elements (application-use prior art); (2) screenshot to the
  vision-capable sub-agent model with zoom-style region inspection, never full-frame-every-turn
  (screenshots ≈ 1–1.8k tokens each). Capture via ScreenCaptureKit (occluded windows by id) —
  brings the **Screen Recording TCC grant, the last planned permission**. Coordinate discipline
  arrives with this lane and stays confined to it: Retina 2× DPR halving + multi-display mapping
  are the documented #1 cause of offset clicks.
- **Cooperative handoff:** M6 classifies login/permission/secure-field as pause states; v2
  completes the round trip. The notch shows why it paused and what happens next; the user performs
  the one step HIMSELF — the kill-switch tap already distinguishes his input, so his manual step
  is *detected as the handoff*, not an abort — then the agent verifies the state diff and
  resumes. Pause → human step → verify → resume.
- **Voice steering:** the `send_to_session` idiom, extended to computer-use tasks — a PTT turn
  while a watched task runs can inject guidance ("use the personal account", "skip that dialog")
  into the running loop as a user message instead of opening a new conversational thread.
  Watching the cursor and talking to it is the whole point of a voice agent driving a visible
  Mac.
- **Polish (absorbed from the old post-M6 deferred list):** multi-display (per-display cursor
  overlay + `AXFrame`→display mapping); scrolling heuristics (AXScrollArea verbs first, Page-Down
  preference — keyboard beats mouse emulation); **allowlist management UI** — a dashboard section
  over config + `/api`, and the off-allowlist notch confirm gains a "remember this app" that
  writes through to it.

**Demo:** "grab the latest invoice from the billing portal and file it in ~/Documents/Bills" —
the first run pauses at the login (handoff: the user types his password himself, the agent verifies
and resumes), downloads, files, and audits the URL trail; the second run replays the stored
session with no pause. And the vision rung: "read me the output value from [AX-hostile app]" —
answered via on-device OCR, no cloud screenshot in the event log.

### M8 — Computer use v3: routines — teaching, procedure memory, scheduled autonomy (specced 2026-07-16)

v2 makes the agent able to act anywhere; v3 makes delegation COMPOUND — Gumbo learns how the user's
recurring tasks are done, replays them cheaper/faster/more reliably each time, and runs them on
its own scheduler. Intelligence moves from "figure it out every time" to "remember how we do
this".

- **Demonstration teaching ("watch me"):** the user performs the task once; the shell's listen-only
  event tap (the kill-switch plumbing, reused) records his actions WITH their AX context — the
  role/label/identifier of every element he touches, never coordinates (semantic recording
  survives layout drift; a pixel recording is stale by the next window resize). The sub-agent
  compiles the recording into a named procedure. Replay strictness = **adaptive** (research:
  strict / adaptive / goal-oriented — adaptive recommended: follow the demonstrated path, adapt
  when the UI drifted, bail to the full loop when adaptation fails).
- **Procedure memory (learned skills):** any SUCCESSFUL multi-step run — taught or self-derived —
  can be distilled into a procedure: goal, preconditions, and a step skeleton of (state check →
  action → verify), persisted in the sqlite `memory` table (FTS5 — same store as search/task
  results). A matching future request replays the skeleton deterministically with LLM
  supervision only at the verify checkpoints — the research's "L2 deterministic fallback" made
  first-class, and the SAFE form of action-batching (steps batch because they were verified
  together before, not because the model guessed they would). Fewer model decisions = fewer
  failure points at a fraction of the tokens. A drifted step falls back to the full loop and
  UPDATES the procedure — self-healing, not brittle macros.
- **Scheduled routines:** the M5 scheduler's `kind` seam ships its designed second consumer —
  `kind:'routine'` rows fire a computer-use task at fire time, one-shot or recurring (recurrence
  itself lands here; M5 shipped one-shot rows only). **Unattended policy:** the notch confirm
  presumes the user is present; unattended runs are restricted to allowlisted apps + KNOWN
  procedures, and any would-be-confirm action PAUSES the task + notifies (notch pulse + log)
  until the user answers — deny-on-timeout stays, and nothing is EVER auto-approved in absentia.
  Results ride the M3/M5 announce path (spoken if awake, pulse otherwise).
- **First-party channel contingency (App Intents × MCP):** macOS 26.1 betas staged OS-level
  MCP→App-Intents wiring, unshipped as of 2026-07. If macOS 27 (Golden Gate) ships it,
  cooperating apps gain a first-party action channel that OUTRANKS UI driving — the dispatch
  ladder grows a rung zero (intent → AX → events). Until then, `shortcuts run` (already in the
  v1 action space) is the bridge.
- **Considered and REJECTED — parallel rollouts (Behavior Best-of-N):** the 2026 OSWorld leader
  runs N attempts in parallel and judges the best — in sandboxed VMs. On a LIVE machine, actions
  mutate real state; parallel attempts are unsafe by construction. Gumbo's reliability budget
  goes to verification + procedure memory instead. (Recorded so it doesn't get re-imported.)
- **Long-horizon hygiene:** procedures make interrupted tasks resumable — re-enter at the last
  VERIFIED state checkpoint, not step 1 (verify-at-start is already the M6 loop contract).

**Demo:** "watch me file an expense report" → the user does it once → "file this month's expense
report" runs as a learned procedure (visibly faster, near-zero model chatter in the event log) →
"do that every first Monday at 9" → a scheduled routine that runs unattended and pauses only at
the confirm-gated submit until the user taps.

**Deferred (post-M8):** wake word; GPT-Live model swap; launchd auto-start; deeper agent
self-organization (archiving / reorganizing its home).

---

## M9–M17 — Personal-capability roadmap (specced 2026-07-19; amended 2026-07-21)

M1–M8 built a voice agent that acts on the web, the Mac, and code. M9–M17 make that agent personal:
it remembers the user, reads the sources he chooses, keeps explicit promises, explains and reverses
effects where possible, uses a local worker when that buys measured value, prefers typed app actions,
and can inspect a bounded physical scene when the user asks.

Four decisions bind the roadmap:

- **the user-moments set scope.** Research explains a mechanism; it never creates a milestone. Every
  sub-item must name the concrete moment in the user's day it serves.
- **The cloud model is a disclosure sink.** Cloud processing is accepted under §2's standing grant,
  but the daemon returns the smallest projection sufficient for the turn. Connector content,
  retrieved memory, local-worker output, and extracted physical text are minimized before model
  ingress; raw media needs a separate explicit release.
- **Capability lands in vertical slices.** Minimal M9 memory → the first M11 connector the user wants
  → its first explicit M12 watch → M14 receipts/undo for the first mutating channel. M10 provenance
  and M14 effects land at each real sink/effect as the slice reaches it, not as broad platform work
  blocking read-only value. M12's receipt-based outcome closure waits for the relevant M14 channel.
- **M13 is cross-cutting discipline, not a sequential milestone.** Its learning and regression
  deliverables live with the phases that own them.

The five rules below win over any conflicting phase text.

### Cross-cutting architecture: the friction economy (2026-07-20)

Gumbo has one principal, one machine, a small number of action channels and disclosure sinks, a voice
surface, and cheap undo where the channel can honestly provide it. The rules below keep friction
proportional to consequence while preserving deterministic containment.

**Rule 1 — One gate, one prompt.** Layers never decide; they emit FACTS (effect class, task
source-set, standing-rule matches, track record, sink). One pure `decide()` — the natural
evolution of the M4 policy table + M6 gateScript, absorbing existing gates as phases touch them,
never via big rewrite — maps facts to exactly one of `auto | announce | confirm(card) |
deny(reason)`. At most one prompt per action, rendered from the decision's card (what it does, what
it read, what it's based on, how it reverses); every decision requiring the user's input drives the
same kill-switch stand-down bracket (the generalized makeStandDown lesson). Because decide() is
pure over enumerable facts, the interaction matrix is a table-driven `node --test` — hundreds of
fact combinations asserting one-decision/no-double-prompt — so gate collisions become test failures
instead of live-demo surprises.

**Rule 2 — Friction follows irrecoverability; disclosure is the irreversible axis.** Prompts are
priced by the cost of being wrong — never by novelty, category, HTTP method, or provenance alone.
Reversible → `announce`: act, say what happened in one sentence, keep "undo that" armed — even when
tainted, even on day one. A compensatable effect is priced by its COMPENSATION cost, not its
category: a free, reliable, immediate compensation (removing a private calendar event with no
invitees) `announce`s and stays undoable; `confirm` is reserved for compensation that is costly,
uncertain, time-limited, or itself discloses. The irreversible axis is **new disclosure** — private
or task-derived information reaching a recipient or service not already entailed by the user's request
or a standing rule. That boundary is transport-independent: a search query over POST discloses its
query but may already be entailed by the user's request, while a GET URL constructed from unrelated
task-read content can leak it. New disclosure is irreversible by information regardless of local
state — the M7 literal-URL rule generalized — which keeps injection blast radius on the
auto/announce tiers bounded to recoverable local state. The cloud orchestrator is itself a
disclosure sink (§2, M11):
the least-disclosure projection is how a connector read stays inside the user's standing
cloud-processing grant. Track record only ever LOOSENS: cold start equals the status quo's gates;
nothing ever earns a new prompt for being new.

**Rule 3 — Effects attach to channels, not tools.** Each action channel carries defaults, so every
tool inherits preview/receipt/undo/verify from its channel: mediated filesystem mutations
(copy-on-first-write; coding tasks also get a git temp ref; APFS remains an optional proven-later
upgrade); browser (settle-diff = the receipt; browserActDecision = the class source);
AX/script (gateScript class → effect class; audit line + before/after capture = receipt; undo
honestly "none" where true); provider HTTP (idempotency + reconcile ONCE per provider client,
shared by its tools); connector writes (the only bespoke compensations, arriving one at a time via
M11). The sandboxed coding lane already has its own containment + git-snapshot story. Full
PREPARED→COMMIT_UNKNOWN→reconcile journaling applies ONLY where lost-response ambiguity exists
(remote commitments); local synchronous channels journal as audit + backup/diff refs. And
previews are SENTENCES, not modals — a voice agent's preview is phrasing: confirm-class speaks its
one-liner before; announce-class speaks the receipt after. A new tool costs what it cost in M7.

**Rule 4 — Provenance is a task source-set, checked at sinks.** No per-value labels plumbed through
model context. Each task keeps a monotone source-set of origins ingested (user | web:host |
screen:app | file:path | memory:sensitivity-class); disclosure sinks check it at the boundary, plus
a containment check that secret-class material read this task is not inside an outbound payload.
The sinks are cloud-model input, provider/search queries carrying task or personal data,
human-directed sends/posts, remote state-changing submissions, and navigation carrying task-derived
data. Returning a tool result to Realtime is a disclosure, so a connector read is governed by
the user's standing cloud-processing grant and minimized to the smallest projection or selected item
the request needs — never a whole collection by default. Tainted egress defaults to an INFORMED
CONFIRM ("this draft contains text from nytimes.com — send?"), not a deny. Precedence: hard limits
(secrets never egress unconfirmed; no payment authority; TCC untouched) sit above everything, and a
standing rule may LOOSEN a default but never cross a hard limit or unlock what the shell can't do;
between the hard limits and the defaults, the user's standing rules pre-approve his own recurring
flows (trusted recipients, known patterns), which is where the read-web→send tax goes to die.
Source-sets reset per task; creep is structurally impossible.

**Rule 5 — No silent negatives.** Any cheap filter (local-model triage, channel-indexed intention
triggers) degrades to a declared fallback, never to nothing: a local "uninteresting" still lands in
the observations table for a supported-channel sweep; every armed intention is rechecked against
the sources Gumbo named when it was armed, and stale promises surface before they silently expire.
Gumbo never claims it can catch cues from an unconnected or undeclared source. Coverage gaps are
stated at arm time, not discovered at the miss.

**The the user-moment test (the arc's build filter, binding like the rules above).** Before any
sub-item is built, name the concrete moment in the user's day it serves — "what did my sister text me",
"undo that", "what's this beeping", "stop asking about this". "A paper recommended it" / "the
field converged here" is context, never a reason. A sub-item that can't name its moment is
deferred until it can — that is how an arc generated by research passes stays a personal agent's
roadmap instead of a reviewer's checklist. Mechanisms whose real audience is a fleet, a team, or
an untrusted insider fail this test by construction: this system has none of those principals.

**Rejected generalizations (named so they stay rejected):** per-value label lattices in model
context (FIDES is multi-principal machinery; one principal, a few sinks here); per-tool EffectSpec
adapter interfaces (microservice Saga overhead imposed on local synchronous actions);
COMMIT_UNKNOWN journaling for local files (a network concept); confidence gates that ADD friction
under novelty (track record graduates autonomy — via standing-rule drafts the user approves — it
never manufactures new asks).

### M9 — Memory & the model of the user (specced 2026-07-19)

Gumbo keeps a complete sqlite event log and a memory table but never learns the user: preferences
stated by voice evaporate, finished tasks are stored but never distilled, and the event log is
replayed for session continuity yet never mined. M9 makes "personal" durable with a minimal FTS
path first; semantic recall and reflection add infrastructure only when their concrete moments need
it.

- **Core-memory blocks (self-editing) — but only the benign block is always in context.** A tiny
  always-present block holds low-sensitivity persona/preferences (how the user likes answers, aisle
  seats) and is injected into the realtime session instructions at connect. Sensitive classes —
  active people, projects, addresses — are **retrieved on demand** when a turn is actually about
  them, NOT pre-injected: because the cloud orchestrator is a disclosure sink (Rule 4), injecting
  people/projects into every session would make every task disclose personal memory and recreate the
  source-creep M10 exists to prevent. The orchestrator edits blocks with a daemon-side
  `remember`/`update_memory` realtime tool; retrieval of sensitive memory rides `search_memory`
  (below). MemGPT/Letta's self-editing memory ([arxiv 2310.08560](https://arxiv.org/abs/2310.08560))
  minus the server and paging. Blocks are small and human-readable — the user inspects and corrects
  them in the dashboard.
- **Sleep-time reflection as a scheduler consumer (`kind: 'reflection'`).** The generic scheduler
  `kind` seam ships its designed third consumer (reminder → routine → reflection), but only after a
  deterministic candidate check finds explicit memory changes, repeated mentions, or finished-task
  lessons worth consolidating — deciding whether to run never sends the whole day's log to a model.
  The job feeds only those candidates through the existing background sub-agent runner and emits
  consolidated memory rows plus proposed core-block deltas. An explicit statement the user asked
  Gumbo to remember stores immediately and `announce`s; only a model-INFERRED sensitive/high-impact
  belief remains an uncommitted dashboard candidate, without interrupting the user for confirmation.
  Every committed change is visible and undoable. **Consolidate, never blind-append** — mem0's
  extract→update/merge/supersede ([arxiv 2504.19413](https://arxiv.org/abs/2504.19413); sleep-time
  compute [2504.13171](https://arxiv.org/abs/2504.13171)). Reflection runs while Gumbo is idle, so
  interactive turns start pre-digested; no standing episodic day-summary artifact is created until a
  concrete recall or brief consumer needs one.
- **Always-alive lands here (amended 2026-07-21).** Sleep-time reflection and every later overnight
  consumer (M12's brief and watches) assume a daemon that survived sleep and reboot — so with this
  phase the daemon becomes a launchd agent and the shell a login item, and Gumbo is simply present
  at the first PTT after a restart, no terminal ritual. Dev keeps the foreground `npm run dev`
  path; both bind the same loopback port, so only one runs at a time.
- **Hybrid semantic recall.** FTS5 keyword recall fails on paraphrase ("that pergola thing" vs a
  stored "patio cover"). Two steps: (1) a `search_memory` realtime tool over the existing FTS5 — zero
  new infra, immediate voice-reachable recall; (2) sqlite-vec alongside FTS5 (node:sqlite loads
  extensions), embed rows + notes, fuse BM25 + vector with reciprocal-rank fusion, under the provider
  conventions (typed errors, one audit line per embedding call). **Privacy fork, resolved
  local-first (2026-07-21):** provider embeddings stay fine for search-derived rows (already
  provider-touched), but personal notes embed on-device — the proven M15 worker infrastructure (the
  LocalAI venv) makes a local embedding model near-free to add, so paraphrase recall over the user's
  own notes never ships them to a provider. Skip rerankers and graph RAG
  until hybrid demonstrably misses.
- **Claims, not just rows: source attribution + bitemporal validity + principled forgetting.**
  Memory rows gain `source` (user | web | screen | file + origin event id), `observed_at` vs
  `valid_from/valid_to` (the time a fact was
  *said* is not the period it is *true* — Temporal Semantic Memory, 2026; no arxiv id in the
  source reports), `supersedes` (corrections version, never
  silently overwrite — "works at X" doesn't delete "worked at Y"), and TTL/decay. Retrieval filters
  expired/superseded claims, surfaces unresolved contradictions explicitly, and can say "you told
  me" vs "I read this on the web" (the source column doubles as M10's integrity label — one signal,
  two consumers). Forgetting is principled, not learned: short TTL for logistics, reconfirmation for
  stale high-impact claims, archive-not-delete by default — but "forget this" is real deletion
  (source text + FTS + vectors + derived claims), leaves a content-free deletion receipt, and flags
  any procedure/rule derived from the deleted claim for review instead of leaving it silently
  intact. **Build note:** the memory table is INSERT-ONLY today, and `memory_fts` syncs via an
  AFTER-INSERT trigger alone — so M9's first DELETE/UPDATE path must add companion FTS triggers (or
  the recall index silently desyncs). Nightly reflection (above) is where decay and
  contradiction-resolution run — no new job.
  **Build order (the the user-moment test applied):** the COLUMNS land with the phase
  (cheap now, painful to retrofit), and the deletion receipt stays — its function is personal, not
  compliance: it lets Gumbo say "you asked me to forget that" instead of gaslighting. The curation
  LOGIC — per-class decay policy, reconfirmation of stale high-impact claims,
  contradiction-resolution — is grow-on-miss: built when recall actually serves the user something
  stale or contradictory, not up front as machinery awaiting a problem.

**Demo:** "remember I prefer aisle seats, and my sister just moved to Denver" → weeks later, "book
me a flight to see my sister" recalls both without being told; overnight, Gumbo consolidates a week of
scattered mentions into a two-line profile the user can read in the dashboard.

**Considered and rejected:** cloud memory platforms (hosted Letta/Mem0/Zep) — the *techniques* port to
local sqlite; the products move the user's user model off-device, against keys-stay-daemon-side.
Knowledge-graph RAG (GraphRAG/HippoRAG, and Zep-style standing temporal KGs) — a heavy standing index
for corpus-scale multi-hop QA; at n-of-1 scale hybrid BM25+vector wins on cost/simplicity. The
*bitemporal and source-attribution ideas* port as plain columns + two narrow lineage tables (claim
derivations, memory-usage-per-effect) — provenance edges, not a graph. The columns ship with the
phase; the two lineage tables
build only when "why do you believe this" is actually asked. Monolithic memory rewrites — ACE's
"context collapse" ([arxiv 2510.04618](https://arxiv.org/abs/2510.04618)); updates are always
deltas. A learned memory
gate (MemGate-class, 2026 preprint) as the *primary* admission boundary — deterministic
purpose/sensitivity/validity/supersession checks come first; a neural relevance ranker may later
order what survives them, never replace them.

### M10 — Provenance & taint-aware gating (specced 2026-07-19)

M10 closes the M7 literal-URL exfil residual with a rule instead of a host-allowlist regex and
hardens the computer-use + web surface before connector data can reach additional sinks.
The 2026 adaptive-attack results are decisive — deterministic out-of-band enforcement (reference
monitors, information-flow labels) held under defense-aware attack while in-band detectors broke at
>90% ([arxiv 2606.26479](https://arxiv.org/abs/2606.26479)). Gumbo's gates are already that family;
they're just missing provenance.

- **Taint as the task source-set, not a separate flag or an interpreter.** Every tool result already
  flows through the daemon — stamp each with a source class (`user | web:host | screen:app |
  file:path`) into the task's source-set (Rule 4). "Tainted" is the *derived fact* that the
  source-set holds an untrusted origin — there is NO separate boolean `tainted` field to keep in sync
  (the source-set already supplies it; a second representation would only drift). Biba-style
  integrity labeling grafted onto existing gates — days, not weeks — not a CaMeL-style plan
  interpreter.
- **Two AXES, carried by the task and checked at sinks.** FIDES-style label lattices
  ([arxiv 2505.23643](https://arxiv.org/abs/2505.23643)) — the right *idea* (confidentiality and
  integrity are different questions) in the wrong *shape* for n-of-1: per-value labels plumbed
  through model context are multi-principal machinery, and join-toward-restrictive converges on
  everything-untrusted within a week (the read-web→send tax). Gumbo instead keeps Rule 4's task
  source-set — integrity axis = the untrusted-origin entries of the source-set above
  (`web:host / screen:app / file:path`); confidentiality axis = which sensitivity
  classes it touched (from M9's columns) — and enforces at the disclosure sinks (Rule 4): tainted egress →
  informed confirm with the source banner; secret-class containment in an outbound payload → the
  immutable line; personal-sensitivity content in a web-search query → sink policy, same pattern.
  Releasing tainted/secret content past a sink stays an explicit recorded event (FIDES' capacity
  idea: a verified boolean or
  short enum releases where raw text does not), and the user's standing rules pre-approve his own
  recurring flows between the maxima and the defaults. Cross cases a single bit misses are still
  caught — web-derived data flowing into a Gmail send, a personal memory leaking into a search
  query — but at the boundary, with zero plumbing through the orchestrator. This is not a
  CaMeL/NOVA interpreter. M11's connector-specific projections are part of each connector; a
  generalized content broker remains deferred until a sink check demonstrably leaks.
- **the user's standing rules: user-authored rules compiled into the same policy table.** AgentSpec
  (ICSE 2026) showed the shape and its load-bearing caveat. Repeated
  corrections ("never do that without asking") become durable, inspectable standing rules instead
  of memories the model may or may not recall: a deliberately tiny rule DSL (trigger + predicates +
  action ∈ {deny, require_confirmation, allow_within_bounds}, optional expiry) that COMPILES into
  the pure policy table — at action time no LLM interprets policy. Precedence is fixed: immutable
  system denies → built-in effect policy → the user's standing rules → per-task mandate → one-time
  confirm; a user rule may tighten freely but can never override a hard deny or unlock what the
  shell can't do. The voice model may DRAFT a rule; activation is a separate shell-owned confirm —
  the **activation card** — showing the rule's plain meaning, two or three deterministic example
  outcomes (allow/block/confirm), the exact scope the user is activating, and a **lightweight replay**:
  the compiled predicate run against recent audit lines, so the card shows what this rule WOULD have
  done to the user's real past actions. That replay is the one part of the card a model-authored draft
  can't fake (plain-meaning text and examples are model-authored, so a draft from a tainted session
  could word them to look narrower than they are) — and it's cheap in v1: the predicate and the audit
  log both already exist at activation time, so it needs no normalized-fact infrastructure. No
  compiled-predicate dump or conflict matrix beyond that. The rule is versioned, diffed, receipted,
  and undoable. AgentSpec's LLM-generated rules hit high precision but ~71% recall, which is why
  drafts never self-activate.
- **Tainted tasks: taint is a FACT feeding `decide()`, not a separate gate (Rule 1).** A network
  send from a tainted task is a disclosure → informed confirm (Rule 4). But taint does NOT own an
  independent "confirm every command" gate: a `do shell script` action is priced by its effect, with
  taint breaking the tie only on the unknown case —
  - provably read-only → `auto`;
  - provably recoverable + receipted → `announce`, even when tainted (undo is the net);
  - irreversible or disclosing → normal `confirm` / `deny`;
  - **unclassified effect from a task that read untrusted sources → `confirm`.**

  That preserves the backstop exactly where it earns its keep — an effect the classifier couldn't
  read, shaped by content that may be hostile — without making "this task once read a webpage" a
  reason to confirm a harmless `ls`. Under Rule 2 an unclassified command has not yet earned the
  label "reversible," so this is not an exception to the friction economy.
- **URL navigation splits by PROVENANCE, structurally — not by scanning raw history.** A URL the
  tools observed as a link reference on a fetched page rides the normal gates (following links is the
  whole job of web research); a URL the *model constructed* that embeds content the task read is
  denied outright — the exfil shape (data smuggled through query params/subdomains, the M7 residual's
  fix; a confirm there is theater since the user can't inspect an encoded blob). Decide by the
  STRUCTURAL fact the browser/script tools already hold — did this URL come from an observed link, or
  was it built in-model? — NOT by byte-scanning the whole source-set for a substring, which is more
  expensive and misfires on coincidental matches. A structurally-provenanced link still gets its
  destination effect-classed before navigation — a literal link to a state-changing or capability
  endpoint (a one-click reset in an email, an unsubscribe-all) takes the informed confirm even though
  it crosses no exfil boundary. The notch confirm renders a "this task has read untrusted web/screen
  content" banner so the user's approval is *informed*, not blind.
- **Context minimization for the worst edge — evaluated, never assumed.** A quarantined
  summarize-to-facts pass over scrape/OCR bytes destined for an action-capable task (one of the six
  documented injection-defense patterns, [arxiv 2506.08837](https://arxiv.org/abs/2506.08837)) is
  defense-in-depth, NOT a boundary — it is itself an in-band, model-mediated transform that can omit
  a needed fact, preserve a disguised instruction, or be attacked, so the deterministic sink/effect
  gates stay the real protection. Ship it only if it earns its place against the offline injection
  corpus (the M13-relocated gate tests): measure BOTH attack reduction and legitimate-task
  degradation before enabling, enable narrowly for raw untrusted content entering an action context,
  and NEVER let passing the transform loosen a deterministic gate.

**Demo:** a research task that scraped an attacker-controlled page then tries to `open location` a URL
containing text it read → blocked with a spoken "that task read web content and is trying to open a URL
built from it — I've stopped it," where the M7 gate leaned on the host allowlist alone.

**Considered and rejected:** full CaMeL/NOVA plan interpreters — provable control-flow integrity costs
~43% of frontier capability on OSWorld and still leaks via Branch Steering
([arxiv 2601.09923](https://arxiv.org/abs/2601.09923)); capability-scoped gates + taint labels buy
most of the protection at none of the capability tax. In-band injection classifiers as the primary
gate — the class that broke under adaptive attack; acceptable only as a cheap advisory signal layered
on top, never as the boundary. Auto-activation of model-drafted standing rules (the AgentSpec
recall gap makes silent activation a coverage illusion). A full security-typed language / label
creep toward everything-untrusted — the DSL stays tiny and the escape hatch is an explicit,
recorded release, not a loosened default.

### M11 — Personal-data connectors (specced 2026-07-19)

"What did my sister text me?", "when's my dentist appointment?", and "summarize this morning's mail"
are core personal-agent moments Gumbo cannot answer today. Connectors ship read-first and one at a time,
with the shell owning local grants and the daemon minimizing what crosses to the cloud orchestrator.

- **Least disclosure is the architecture, not a footnote.** The cloud orchestrator is a disclosure
  sink (Rule 4): every connector result it reasons about reaches OpenAI. the user's standing decision
  (2026-07-21) is **cloud processing accepted** under a one-time per-connector/data-class grant — so
  the job is to send the SMALLEST projection sufficient for the turn, enforced by the daemon, not by
  trusting the model to be frugal. The connector layer is a minimizing projection over each source's
  query result, not a pipe:
  - **Scope at the source** — filters push down to `chat.db` SQL / the Gmail query (`from:`,
    `is:unread`, `after:`, `maxResults`); never fetch-all-then-filter, so the daemon holds less too.
  - **Project, don't dump** — the default return is a header projection (`{from, subject, date,
    snippet≤K, id}` for mail; `{sender, ts, snippet≤K}` for messages), never full bodies; drop fields
    the turn doesn't need.
  - **Progressive disclosure** — a full body is a second, explicit step via one shared `open_item(ref)`
    tool, only when the request needs the whole content ("read me the email").
  - **Daemon-enforced caps** — max records, max snippet chars, and an **unscoped query is an error**
    (a lookup with no sender/thread/query/date-window is rejected, never a full scan). The tool
    physically cannot return the inbox.
  - **Bulk asks cross only through the on-device reduce+redact pipeline (designed 2026-07-21).**
    The daemon forks every lookup mechanically: a query that names one contact/thread/message and
    resolves under a small config cap is FOCAL — its scoped projection crosses intact, because the
    content *is* the answer and Realtime speaks audio, so a placeholder could never be re-hydrated
    in speech. Anything wider is BULK and never crosses raw: (1) a deterministic redactor replaces
    structured PII — phone numbers, email addresses, card/account digits, verification codes,
    tracking numbers, street addresses — with stable per-task placeholders BEFORE any model sees
    the text; (2) the M15 worker triages the capped, already-redacted set into a digest +
    included/omitted manifest on-device; (3) a final deterministic sweep re-checks the digest, and
    only that projection crosses. The alias map (placeholder → value) lives in daemon memory for
    the task and re-hydrates only at local executors (a send draft, a dial/mac action), so the
    cloud can compose with a value it never received. Worker unavailable or over budget → the bulk
    ask degrades to capped, regex-redacted header snippets and says so (Rule 5) — never raw
    bodies, never silence. Redaction never dead-ends a turn: any digest line promotes to focal via
    `open_item`, and an unscoped query's error carries the narrowing hint, so the model recovers
    in-band.
  - **Content-light audit + provenance** — each fetch logs metadata only (query shape, count, fields
    — never bodies) and stamps the task source-set with the sensitivity class for Rule 4.

  The setup card states once, per class, what "processed by OpenAI" means, so the standing grant is
  informed. This is the OpenAI-recommended data-minimization posture made structural.
- **Mail = Gmail via MCP (the user uses Gmail, not Apple Mail).** The `mail_lookup` connector is a Gmail
  MCP server (e.g. the Google Workspace MCP), OAuth with **read-only Gmail scopes**, and the refresh
  token stored in macOS Keychain through the signed shell — not `.env`, because it is a dynamic,
  revocable user credential. The shell releases it only to the daemon's connector client when a
  refresh is required; short-lived access tokens stay in daemon memory. Neither credential is sent
  to Realtime, written to task workspaces, or exposed to spawned sessions.
  **New seam:** this is the first MCP the
  *voice/sub-agent* side consumes — today only the sandboxed Claude sessions speak MCP (via
  `config.claude.mcpServers`), so the daemon gains a small MCP-client path for the realtime/sub-agent
  tools (the alternative — a native Gmail API client under the provider conventions — is also viable
  and keeps zero MCP on the voice side; MCP is the user's stated preference). **Upside:** because Gmail is
  OAuth/API, mail needs **no Full Disk Access** — the FDA trade-off below shrinks to Messages only.
  Sends stay behind the notch gate (read-only scopes make a send impossible without a scope escalation
  the user explicitly approves). *Open build-time question:* if the user is Google-ecosystem for calendar
  too, `calendar_lookup` can ride the same Google MCP/OAuth instead of EventKit — pick ONE based on
  the user's actual calendar, never build both Google and EventKit speculatively.
- **The other connectors stay native, via the shell's TCC + node:sqlite.** Extend the M6 MacBridge with
  read actions: EventKit calendar read + Contacts-framework search (shell-side — it already owns
  Automation TCC); daemon-side read-only node:sqlite over Messages' `chat.db` (the documented recipe —
  JXA message reading is broken/too-slow on recent macOS, so a direct SQLite read is the field
  standard). Native tools keep the keys/TCC posture; only mail deliberately goes MCP because Gmail is
  not a local store.
- **Scoped lookup tools + one shared `open_item`, and ONE connector at a time.** Each connector
  exposes a scoped-projection lookup (query live, persist nothing new, auto-run — reads are
  reversible); `open_item(ref)` fetches one full body on demand across connectors, so the registry
  doesn't grow a headers-tool + bodies-tool per connector (the sole-orchestrator standing risk).
  **Contacts is primarily an internal resolver** (a spoken "my sister" or first name → handle,
  handle → name for display), used
  by the other lookups and for enrichment — a direct contacts tool is grow-on-need, built only when
  unresolved identifiers materially hurt answers. And the milestone is NOT "four connectors": ship
  the ONE the user wants most, prove its daily use, then add the next. **Every send stays behind the
  existing notch gates** (the M6 mail-send gate; a Gmail send, if ever added, is a gated write on an
  explicitly broadened scope).
- **The reply is part of the moment (amended 2026-07-21).** "What did my sister text me" is half a
  conversation; "text her back 'on my way'" is the other half. The first connector-adjacent WRITE
  is a Messages reply riding the existing M6 mac-channel send gate — a send is new disclosure, so
  it stays confirm-class — composed by the cloud from the redacted thread, with placeholders
  re-hydrated from the task's alias map at the executor, so a reply can carry a number the cloud
  never received. The connector credential itself stays read-only (the send rides the mac channel,
  not a broadened scope). Receipts and the undo ladder attach when M14 reaches this channel; until
  then the receipt is the audit line plus the confirm card, and a sent message is named honestly
  as irreversible.
- **The TCC + privacy trade-off, surfaced to the user up front.** With mail on Gmail/OAuth, the only
  connector needing **Full Disk Access** is Messages (`chat.db`) — still a powerful grant and the
  biggest local-privacy step in Gumbo's arc, but now scoped to one connector, and Gmail adds an OAuth
  token (a revocable, read-only-scoped credential) rather than whole-disk read. Minimal-first: one
  connector at a time, read-only, each new grant a deliberate decision — not slipped in.
- **Forward hooks (2026-07-20):** if/when a connector ever gains a write (a Gmail send on an
  explicitly broadened scope), that write is an M14 *effect* — receipted, idempotency-keyed,
  reconciled on timeout — not a bare API call; and connector reads are the event channels M12's
  intentions index against (a reply arriving, a confirmation mail appearing), so outcome closure
  gets its cues from here rather than from polling.

**Demo:** "what did my sister text me yesterday, did my landlord email about the lease, and am I free for
lunch Thursday?" — answered from Messages (native) + Gmail (MCP) + Calendar in one turn, names
resolved, nothing sent, and no connector CONTENT persisted — the OAuth credential, metadata-only
audit, and provenance facts remain. Only the scoped projections (the sister thread's snippets, the landlord
match's header, Thursday's free/busy), not the message DB or inbox, cross to the cloud under the user's
standing grant. A bulk ask ("anything important this morning?") crosses only as the
on-device-reduced, placeholder-redacted digest with its included/omitted manifest. Then "text her
back 'on my way'" composes from the redacted thread, re-hydrates any placeholder at the send
executor, and goes out through the mac channel's existing confirm.

**Considered and rejected:** a multi-channel chat gateway / device-node pairing / skills marketplace
(OpenClaw's growth surface) — every channel is an outward auth+exfil surface and multi-device pairing
is multi-tenant infra in disguise, against loopback-only/single-user. If remote reachability is ever
wanted, the minimal move is a single iMessage channel via this connector, flagged as a deliberate
posture change first.

### M12 — Proactive presence (specced 2026-07-19)

M12 makes Gumbo keep explicit promises without becoming a generic monitor: a brief the user configured,
a watch he armed, and deterministic etiquette about when to speak. The scheduler already exists;
connector-backed watches depend on M11, personalization can use M9, and every ingested source carries
M10 provenance.

- **Morning brief (`kind: 'brief'`), opt-in and the user-configured.** One scheduled task fans out over
  the sources THE USER chose — his calendar + mail via M11, and only the feeds he named. NO default
  X/news fan-out: a broad web sweep he didn't ask for pulls untrusted content into the brief and
  serves no named moment. Synthesizes, delivers as a notch card + an optional spoken summary at the
  *first PTT of the day* — never an unprompted cold monologue.
- **Watches are EXPLICIT, not a generic monitor (`kind: 'watch'`).** A watch starts only from an
  intention the user armed ("tell me if the landlord replies"); Gumbo does NOT run a generic
  "interesting signal" monitor that continuously decides what matters — that standing decider is the
  drift the whole arc rejects. The two-tier machinery (cheap poll into a sqlite `observations` table
  *without spawning sessions* → cheap-model triage → escalate to a sub-agent + notch *only* on genuine
  signal) is the SHAPE a costly watch takes, built when an actual watch is expensive enough to need
  it — not the default wrapper around every armed cue. Quiet hours and a per-day cost cap are
  first-class.
- **Interruption etiquette (deterministic, shell-side).** The "small always-on trigger" of the
  proactivity literature (PRISM's asymmetric speak-or-stay-silent cost,
  [arxiv 2602.01532](https://arxiv.org/abs/2602.01532)) reduced to zero-cost signals macOS already
  exposes: hold/queue non-urgent announcements while a realtime session is live, Focus/DND is on, or
  screen capture/sharing is active (the shell knows all three), and flush the queue at the next PTT
  press as a one-line "while you were away." No trigger model, no monitoring — pure Swift.
- **Intentions ledger with outcome closure.** PM-Bench's best config managed only ~65% macro-F1 and
  more monitoring bought false-positive actions, so Gumbo uses a compact ledger rather than a
  heartbeat agent. V1 stores the normalized intention, trigger kind (`time | event | absence`), due
  window, declared source channels, optional outcome ref, and one of THREE daemon-owned states:
  `ARMED → TRIGGERED → CLOSED`, with `closed_reason` ∈ satisfied | superseded | cancelled | expired |
  blocked. An explicit "watch / remind / tell me if" request arms the row immediately; casual
  language never creates a durable promise. Versioning, generic `state`/`dependency` predicates,
  and generalized completion expressions are grow-on-need.

  Triggers are indexed to the smallest declared event channel (an M11 connector delta, a task
  finishing, a deadline approaching) and checked when that channel changes. A cheap deterministic
  watch fires the trigger; a cheap model verifies a semantic condition only when one is actually
  needed; etiquette decides when the user hears; any resulting action rides the normal gates. Pending
  intentions are visible and one-tap cancellable, and low-value ones expire aggressively.

  **Task done ≠ outcome closed**, but receipt-based closure lands only with the relevant M14 channel:
  a submitted form without its confirmation mail, a sent invite never accepted, or a requested
  refund not yet posted can stay armed against an outcome ref and escalation deadline once the
  originating effect produced that receipt. Before then M12 ships ordinary read-only watches only.
  At arm time Gumbo names exactly what it will check ("I'll check mail for this — not your texts").
  A daily sweep rechecks each intention against those declared, connected sources and surfaces stale
  watches or missed deadlines; it never promises to discover cues outside them.

**Demo:** Gumbo stays silent through a screen-shared meeting, then at the first PTT after: "while you
were presenting — two things: your 3pm moved to 4, and the invoice you were watching for arrived."

**Considered and rejected:** always-on ambient activity sensing / a wake word for anticipatory
suggestions — the research pattern needs exactly the continuous capture PTT was chosen to avoid.
**PTT is Gumbo's consent boundary, not a limitation to engineer away.** (Wake word stays deferred as a
hands-free *input* convenience — a separate decision from proactivity.)

### M13 — Learning & regression discipline (cross-cutting; NOT a sequential milestone)

Learning from verified outcomes and protecting behavioral routing are cross-cutting engineering
discipline, not a standalone product feature. Each deliverable lives with the phase that owns it:

- **Failure lessons → M8 procedure memory.** On a VERIFIED correction or a REPEATED failure (not
  every abort — most aborts are noise), write a three-line "symptom / cause / try-instead" lesson
  keyed by task kind + target app/site (Reflexion, [arxiv 2303.11366](https://arxiv.org/abs/2303.11366));
  the next similar task retrieves it. No background model call after *every* failure — only on the
  signal.
- **Procedure promotion → M8.** A run becomes a procedure when the user TEACHES it, asks to SAVE it, or
  Gumbo sees repeated VERIFIED success and offers — never automatic promotion from arbitrary
  successful runs, which accumulates one-off paths and stale workarounds. Delta updates only, never
  wholesale rewrites (ACE's context-collapse, [arxiv 2510.04618](https://arxiv.org/abs/2510.04618));
  this keeps M8's procedure memory a living skill library
  (Voyager, [arxiv 2305.16291](https://arxiv.org/abs/2305.16291)).
- **Routing regression → realtime tool-registry tests.** A SMALL hand-curated set of
  `utterance → expected-tool-call` pairs, replayed by `node --test` against the registry, so "remind
  me Tuesday" still routes to the scheduler after an instruction tweak. Hand-curated, never
  auto-harvested — don't scrape a magic number of private event-log examples.
- **Injection corpus → M10/M14 gate tests.** The recorded M6/M7 bypass variants ride the gate tests
  as a periodic offline sweep (grow from the wild) — an offline check beside the gates it protects,
  never a continuous red-team service. This is also where the M10 quarantine pass earns (or fails to
  earn) its keep before shipping.
- **Claim/source verification → the research-task contract.** NOT a separate list-wise model pass
  before *every* announce — that adds latency and false assurance, and a second model pass doesn't
  guarantee truth. Instead: every research claim references fetched source IDs; the daemon
  DETERMINISTICALLY verifies those IDs were actually fetched (a free lookup against the existing
  audit log); a model-based semantic support check runs ONLY for source-dependent research reports;
  unsupported claims are removed or clearly qualified. A basic "your task finished" announce is never
  blocked on it.
- **Autonomy graduation → M10 standing rules + M14 `decide()`.** The model's self-reported confidence
  is not a boundary (RiskEval [arxiv 2601.07767](https://arxiv.org/abs/2601.07767): models "almost
  never abstain" even when optimal), so graduation is the user-approved, never self-asserted: "stop
  asking about this" (or Gumbo offering after repeated verified approvals) drafts a standing rule that
  activates through the M10 card, fed by M14's effect facts. Day one equals today's gates exactly;
  the deterministic inspect-first-on-unresolved-compensatable behavior ships with M14. The statistical
  calibrator stays **deferred-until-felt** — at one user's action volume it is unlikely to beat the
  direct manual path; build it only if hand-drafted graduations demonstrably lag the audit trail.

**Demo:** a computer-use task that failed on an AX-hostile pane last week succeeds this week because
the retrieved M8 lesson routed it straight to the vision lane; a routing-regression run in the
tool-registry tests catches that an instruction edit broke "set a timer."

**Considered and rejected:** trajectory→skill distillation into fine-tuning, LLM-judge eval panels,
reference-free trajectory scoring at scale (HAL/TRACE/AdaRubric) — real techniques, but eval
*infrastructure* for teams shipping to many users; at n-of-1 the lightweight lesson/regression loop is
the right weight. Debate/verifier panels — fixed-budget multi-agent synergy collapses via correlated
errors and measures *less* aligned than single agents
([arxiv 2601.17311](https://arxiv.org/abs/2601.17311)), the wrong direction for a machine-controlling
agent. A standalone self-improvement milestone — the deliverables are cross-cutting; a phase for them
is bookkeeping that implies a feature that isn't there.

### M14 — Transactional effects, receipts & honest undo (specced 2026-07-20)

Gumbo's gates answer *may this run*; M14 records what changed, whether a remote commitment landed,
and how the specific channel can recover or undo it. The layer arrives one channel at a time:
receipts and exact approvals land with the first effect in that channel; full journaling lands only
with a mutating remote client that has lost-response ambiguity; APFS remains a live-proven upgrade.
A later autonomy increase needs the relevant channel's effect story, not a universal substrate.

- **Effect classes emitted PER ACTION, not statically per tool.** `read | reversible | compensatable
  | irreversible`, decided for the specific operation — `browser_act` is read-only, reversible, or
  irreversible depending on the call (a scroll vs. a field edit vs. a submit), so a static per-tool
  label is wrong; the class comes from the action's facts (`browserActDecision`, `gateScript` class).
  A *compensatable* effect is further priced by its COMPENSATION cost, not its category (Rule 2):
  free/reliable/immediate compensation `announce`s; costly/uncertain/time-limited/disclosing
  `confirm`s. The class feeds `decide()`, the M13-relocated graduation, and the preview wording — one
  taxonomy, three consumers — with Rule 2's rider that *new disclosure is irreversible* regardless of
  local state.
- **Channel defaults, not per-tool adapters.** Effect behavior attaches to action channels:
  daemon-mediated filesystem writes copy the target on first mutation; coding tasks use a git temp
  ref; browser actions use settle-diff receipts and `browserActDecision`; AX/script actions use
  `gateScript` + before/after capture and say undo is "none" when Gumbo could not intercept the
  underlying write; mutating provider clients own idempotency/reconcile once; connector writes add
  bespoke compensation one at a time. A new tool inherits its channel's behavior.
- **A durable effect journal in sqlite — full journaling only where lost-response ambiguity
  exists (Rule 3): mutating provider/connector calls.** PREPARED (the minimum normalized arguments
  needed for recovery + arg hash + precondition capture + idempotency key) → COMMITTING → COMMITTED → VERIFIED,
  with an explicit **COMMIT_UNKNOWN** for lost responses. The iron rule: a COMMIT_UNKNOWN step is
  *reconciled* — reuse the provider idempotency key where one exists, else inspect external state,
  else stop for the user — **never blindly retried**. Sensitive bodies and secret material are not
  retained merely because an action occurred: store object IDs, hashes, and redacted recovery facts
  where sufficient; retain an exact payload only when that supported client's recovery truly needs
  it, under the protected db and the shortest useful lifetime. If safe recovery requires a payload
  Gumbo should not retain, record `unknown` and stop. A generic
  browser SUBMIT usually has no idempotency key and no reliable reconcile path, so on lost-response
  ambiguity it records `unknown` and stops for the user. Local synchronous channels journal as audit +
  backup/diff refs. Crash recovery resumes/reconciles only the remote-write clients that implement
  that contract and never re-executes their committed actions; an unknown browser submit remains
  stopped. Replay-for-debugging consumes recorded outputs only and categorically blocks live shell
  actions. The journal needs no
  tamper-evidence: the daemon is its only writer, and the sqlite `db/` dir is deliberately absent
  from the Seatbelt writable set so a sandboxed session can't rewrite it either — a plain journal
  recovers crashes just as well. (Build guard: never add `db/` to the sandbox writable set, or that
  single-writer invariant collapses.)
- **Single-use effect permits.** A confirm's approval binds to the exact argument hash and expires.
  For a confirm-class decision, the executor for EVERY channel — daemon file mutator/coding runner,
  shell TCC bridge, browser manager, provider client, or connector — consumes one matching permit
  immediately before the effect; no executor treats a UI confirmation alone as authority. The model
  cannot mint or reuse a permit, and "approve whatever is pending" is structurally impossible.
- **Receipts, and an honest undo ladder.** Receipts carry external object IDs, before/after
  captures, provider responses, and any cancellation/compensation deadline (UI actions: bundle id +
  element path + before/after snapshot hashes). Undo is tiered and never overpromises: exact
  inverse (move the file back) → compensation (cancel the reservation) → corrective follow-up
  (send the correction) → irreversible: preserve the record and name the next safe human action.
  Compensation always executes from receipts, never from a freshly generated plan; v1 is "undo the
  last effect / the last task" — dependency-ordered compensation across a multi-effect routine is
  deferred until a real routine needs it.
  And previews are SENTENCES, not modals (Rule 3): confirm-class speaks its one-liner before the
  act; announce-class acts and speaks the receipt after, "undo that" armed — zero added beats on
  the reversible majority of a voice-first agent's day.
- **Filesystem checkpoint: only intercepted writes promise undo.** A daemon-mediated file mutation
  copies its target on first write; a known batch operation backs up its explicit input set; coding
  tasks preserve dirty state on a git temp ref. Open-ended shell commands and saves performed inside
  arbitrary apps do NOT promise file restoration because Gumbo cannot know their future paths before
  they write — their receipt says undo is unavailable. APFS local snapshots (`tmutil localsnapshot`;
  selective restore by mounting a snapshot read-only) may extend that coverage only after snapshot
  creation, mount permissions, restore, and pruning are proven on this machine. Live full-volume
  rollback remains out of reach; this is always selective short-horizon restore.
- **"Why did you do that?" from the journal, not a provenance graph.** A short linear trace —
  originating request → applicable standing rule → task source-set → exact effect → gate result →
  receipt — rendered from the journal, never from hidden reasoning text and never a standing
  provenance graph.
- **Fault-injection as the test discipline.** A local command that kills the daemon (or drops the
  shell) after each state transition; recovery must come up clean from the journal every time.
  Chaos testing without CI, telemetry, or a VM fleet.

**Demo:** "add the usual court time to my private calendar, no invitations" → Gumbo creates the
free-to-remove event without a prompt and announces "added it — say undo that to remove it";
mid-commit the daemon is killed; on restart Gumbo reconciles the COMMIT_UNKNOWN insert (finds it
landed, does NOT duplicate it), then "undo that" removes exactly that event from its receipt. A
file-sort task gone wrong restores the 17 files the mediated batch backed up before moving them.

**Considered and rejected:** a full transaction-closure / verifiable-credential / portable-receipt
protocol (non-peer-reviewed, aimed at multi-party agent economies — Gumbo needs a local journal and
linear receipts, not ecosystem governance); speculative execution of *mutating* tools (PASTE-style
speculation stays quarantined-reads-only — an email cannot be un-sent from a quarantine, and
ACRFence shows replay-around-effects double-executes); promising full-volume rollback (entitlement
reality above); tamper-evident/hash-chained journaling (tamper-evidence defends against an
untrusted writer, and the daemon is this journal's only writer — a plain journal recovers crashes
just as well).

### M15 — Local worker tier (cost, latency & disclosure reduction) (specced 2026-07-20)

M15 adds one local worker when a measured job benefits from lower cost, latency, or cloud exposure.
The worker is **Ornith-1.0-35B-MLX-oQ4** (an agentic fine-tune of Qwen3.6-35B-A3B, OptiQ 4-bit,
already on disk under `~/Documents/LocalAI`), run through the LocalAI venv's `mlx_lm` with thinking
disabled and greedy decoding — chosen by a task-shaped bake-off on this machine (measured
2026-07-21): zero PII leaks and the most complete redaction map of four candidate quants, 852 tok/s
prefill / 86 tok/s decode / 21.6 GB peak, a full 14-item inbox digest in 13 s cold (~9 s warm) and
a thread redaction in 7 s — inside the voice budget. It runs subprocess-per-job (zero resident
memory between jobs; the ~4 s load tax is already inside those numbers); a resident `mlx_lm.server`
is a grow-on-need upgrade if job cadence ever makes the load tax felt. Realtime remains the sole
orchestrator, so local output still returns to the cloud and M15 is a disclosure REDUCER, never a
privacy boundary or offline conversational lane.

- **One local worker, one proven job at a time — no router fabric.** The daemon owns the worker
  (`daemon/src/local/`): it shells out to `mlx_lm` per job with a strict-JSON output contract,
  validates on parse, and falls back on any miss. Eligibility is deterministic and simple: a job is
  local-eligible if it is device-scale (summarization/extraction/classification/redaction — not
  world knowledge) AND non-final (verifiable, or it falls back). **No stage-two learned/bandit
  router** — a static choice suffices at one user's volume — and **no effect-based "strongest
  model" routing**: deterministic gates own safety, not model tier; the gate decides *may this run*
  independent of which model drafted it. The first job is M11's bulk reduce+redact stage (specced
  there; the deterministic redactor beneath it runs even when the worker is down); further jobs
  (watcher-triage cheap stage M12, semantic trigger verification M12, memory sensitivity tagging /
  PII redaction M9, the M9 privacy-fork embedding alternative, short summaries) are added only when
  a specific consumer needs one — never a battery built up front.
- **A local result is never silently final (Rule 5).** A local "uninteresting" still lands in
  observations for a supported-channel sweep; failed schema validation falls back to the cloud
  (accepted). A lossy digest accounts for every input item ID as included or omitted, returns total
  counts plus a small header manifest, and keeps the capped source snippets available through
  `open_item` follow-up. The answer says what it covered (for example, "12 messages reduced to 5
  items") rather than presenting three lines as complete inbox truth. An advisory injection pre-scan
  may layer on top only if M10's corpus shows it helps; it is never the boundary.
- **Honest degradation, named states.** The voice loop IS the cloud orchestrator, so cloud-down means
  the conversational agent is down — inherent to the design, stated plainly, not papered over with a
  fake offline mode. What survives cloud-down is only deterministic local action already in flight,
  resumed from a durable M14 boundary. Local worker unavailable → its job falls back to the cloud
  (accepted) or, if a consumer marked it must-stay-local, `BLOCKED_BY_MODEL`, said aloud. Rate limit →
  pause at a durable boundary, don't restart.

**Demo:** "summarize this morning's mail" fetches a scoped, capped set; the deterministic redactor
placeholders its structured PII, the worker marks five of 12 item IDs included and seven omitted,
and only the redacted three-line digest plus the content-light manifest crosses to the cloud — in
roughly ten seconds on the measured budget.

**Considered and rejected:** continuous per-user fine-tuning / Apple adapter training (retrained per
base-model update; structured memory + routing + policy get the personalization at none of the
maintenance risk); token-level speculative decoding (measured 2026-07-21: a trained DFlash draft
lands 0.96× on the deploy quant — a loss — and only 1.09× on its own training target); a learned
router (eligibility is deterministic, forever); a
local-private ORCHESTRATION lane that bypasses Realtime (it would be a second brain — §2 locks
sole-orchestrator — and the user accepted cloud processing, so the lane has no requirement to serve);
"inference fabric" as a platform (one worker for one job, grown on need).

### M16 — First-party semantic actions: App Intents + curated Shortcuts (specced 2026-07-20)

For an app the user actually uses, a typed system-brokered action can be more reliable than driving
pixels: no coordinate math, no injection-prone screen text, and structured parameters `decide()` can
inspect before execution. The semantic-action channel sits beside AX and the browser and uses the
same policy choke point. macOS 26 puts Shortcuts on Spotlight and gives personal automation triggers;
App Intents/App Schemas keep growing
([developer.apple.com/documentation/appintents](https://developer.apple.com/documentation/appintents)).

- **Outbound: intents and Shortcuts as adapters — ONE at a time, behind one lane.** Start with a
  SINGLE user-selected app intent or Shortcut the user actually uses, not an enumeration of every
  installed action. **Feasibility gate:** confirm on THIS macOS version that arbitrary third-party
  App Intents can be discovered and invoked, and whether a Shortcut definition can be exported,
  hashed, and change-detected, before treating those as phase assumptions. The realtime registry
  does NOT grow a tool per installed action — a small approved-action manifest sits behind ONE
  adapter tool.

  A typed App Intent emits its specific action facts before execution. An opaque Shortcut is
  different: Gumbo cannot gate internal sends/deletes after launch, so the WHOLE Shortcut is one
  pre-classified effect bound to its identity, input schema, and maximum declared consequence.
  `decide()` runs before launch; only a structurally proven read-only action skips approval. If
  definition hashing is feasible, a material change invalidates the standing approval; otherwise
  the manifest is explicitly curated by Shortcut identity. Unmanifested opaque Shortcuts take the
  conservative irreversible/disclosing default. Their output is untrusted after execution, but the
  spec never claims their internal side effects inherited Gumbo's gates or receipts. Prefer a typed
  intent over a Shortcut, and either over AX, when the target app exposes it.
- **Inbound, OS-local only — deferred until a use is named.** Gumbo's own App Intents (approve the
  exact pending preview by hash, undo last reversible effect, run an approved routine) are OS-local
  surfaces, not a network listener, and "approve whatever is pending" stays structurally impossible
  (M14 permits). But most of the tempting set — "ask Gumbo," "start PTT," "show tasks" — merely
  duplicates the notch and hotkey, so the inbound Spotlight/widget suite is DEFERRED until the user
  names a surface he actually wants (undo/cancel may eventually earn one). Remote approvals remain
  out of scope.
- **Boundaries.** Shortcuts never become a second scheduler, memory store, or orchestrator; Apple's
  "Use Model" action is not allowed to grow into one either. Gumbo owns routines, timing, policy,
  receipts.

**Demo:** "add this to Things" invokes the app's declared intent with typed fields — no window focus
stolen and no UI driving.

**Considered and rejected:** Gumbo as an MCP/A2A *server* and multi-device thin clients (the
rejected outward-surface line holds; see Deferred for the one recorded nuance); treating intent
coverage as universal (it isn't — AX/browser lanes remain the fallback for the long tail).

### M17 — Explicit physical-world perception (specced 2026-07-20)

M17 handles paper documents, objects, appliance indicators, and non-speech sound as an **explicit,
visible, task-scoped act the user initiates**, never ambient. It extends the M7 vision lane off-screen:
capture is a tool call with a question attached, media is ephemeral, and processing is local-first
(FastVLM, CVPR 2025, ships Apple-Silicon checkpoints;
SoundAnalysis classifies 300+ sounds on-device;
[developer.apple.com/videos/play/wwdc2021/10036](https://developer.apple.com/videos/play/wwdc2021/10036/)).

- **Two tools, bounded by construction.** `look_now(question, capture_mode)`: one still frame from
  a Mac or Continuity camera. `listen_now(question, max_seconds)`: a short clip (default ~10 s,
  extendable when an intermittent sound needs it — a default, not a hard cap) or a live SoundAnalysis
  pass that never retains the waveform. The shell owns the TCC prompts and shows a visible capture
  indicator both times.
- **Local-first processing ladder.** Deterministic Vision OCR / barcode / document-rectangle /
  SoundAnalysis first; local VLM (FastVLM / mlx-vlm, or the M15 on-device model's image input) only
  when semantic interpretation is needed; cloud vision only behind an explicit, per-task release
  (M10's explicit-release event). Returns a typed observation: images include a locally retained
  evidence crop + uncertainty flags; audio includes the source time span + classifier confidence,
  never the waveform. The full frame or audio clip is deleted unless the user says keep; the evidence
  crop lasts only as long as the answer/receipt that lets the user verify the claim. A capture hash is
  grow-on-need, only for a real dedup or recovery use.
- **Uses, and the honest cloud caveat.** Read a serial number, summarize a whiteboard, compare a
  paper form to its PDF, identify a cable/port, extract package tracking, classify a beep (timer vs
  doorbell vs alarm — *identify*, never auto-dismiss). v1 is scoped to these listed tasks; a
  consequential physical claim shows its source crop or asks the user to verify. No generalized
  identity/medical refusal taxonomy is built — covert or continuous capture is refused by
  construction (every capture has a visible indicator and an attached question), and the narrow
  cases are declined as they arise. **Honest caveat:** local extraction keeps the raw media
  on-device, but the extracted TEXT still flows back through Realtime to answer — "raw paper never
  uploaded" is not "its contents stayed local"; that disclosure rides the user's standing cloud grant
  (Rule 4). There is no PTT-time background audio-scene inference — it would break the
  capture-has-a-question boundary and serves no named moment.

**Demo:** "what's this beeping?" → one bounded listen → "likely your washer's end-of-cycle chime; I
can't safely rule out an alarm from one short clip, so check if you can't locate it"; "file this
receipt" → one still → typed fields extracted on-device, raw image never uploaded though the
extracted fields cross to Realtime under the user's standing grant.

**Considered and rejected:** always-on ambient sensing (capture remains bounded to an explicit
question); cloud-default vision (local-first is the point);
treating a confident local VLM read of small text as ground truth — consequential physical claims
show the source crop or ask the user to verify.

### Ongoing polish (field-borrowed, not phase-gated)

Small, high-value borrows to fold in opportunistically rather than as phases: coding-session
git-safety (snapshot dirty state to a temp ref before a Claude session; a "revert last coding task"
voice tool — Aider's discipline); per-computer-task trajectory JSONL + keep-last-N-image pruning in
the vision loop (Anthropic computer-use best-practices); a `validate(prompt)→bool` end-of-task
assertion (Skyvern); preferring non-focus AX actions so the agent doesn't steal the cursor (cua);
parallel Exa/Grok fan-out within a breadth-first research task (the one multi-agent win worth taking —
no new agents); prompt-cache discipline — stable system/tool/policy prefix first, volatile
observation last, no timestamp/task id before the cache break, prefix pinned across act→observe steps,
and cache-read tokens recorded in the relevant provider audit when the SDK exposes them.

**Deferred (post-M17):** wake word (a hands-free *input* convenience, unrelated to proactivity — PTT
stays the consent boundary); a full-duplex GPT-Live model swap (Moshi-class models trail frontier
models on reasoning/tool-use, and the production realtime stack is itself still half-duplex — revisit
when a frontier-quality full-duplex API ships); deeper agent self-organization;
**a local-only MCP boundary** (deferred until a concrete local client needs bounded Gumbo services;
if built: stdio/Unix-socket only, capability-leased, effect-proposal-only through the normal notch
flow, never a new safety principal, never remote); Live Activities-style progress on other devices
(a plausible local-only exception to the thin-client rejection — low priority).
**Firmly out of scope:** Behavior Best-of-N (needs resettable VMs; unsafe on a live Mac), cloud memory
platforms, knowledge-graph RAG at n-of-1, in-band injection classifiers as a primary gate,
multi-agent debate/organizations (measurably less aligned than single agents), any telemetry;
**agentic-commerce payment rails** (AP2/ACP/UCP/x402 — real and adopted, but wallet/identity/
merchant infrastructure is an outward auth+exfil surface against the local single-user posture;
borrow the *mandate + receipt concepts* into M14, connect no payment authority); **open-network A2A
delegation / agent marketplaces** (protocol threat models still immature; identity/exfil problems
immediate); **remote iPhone/Watch/Vision Pro control and remote approvals** (a new remote authority
boundary — OS-local App Intents surfaces in M16 deliver the value without it); **speculative
execution of mutating tools** (quarantine cannot contain an already-sent email; reads only);
**continuous per-user fine-tuning / Apple FM adapters** (retraining treadmill per base-model
update); **a learned memory gate or learned router as a primary boundary** (deterministic checks
first, learned rankers only behind them); **auto-activated model-written policy rules** (drafts
need the M10 activation card); **continuous red-team-as-a-service** (the M13 offline
injection-regression suite is the right weight).

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
