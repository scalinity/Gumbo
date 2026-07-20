# Gumbo — Specification

> Gumbo is a personal, always-alive voice agent for macOS. Talk to it; it orchestrates work by
> spawning background sub-agents, runs and supervises interactive Claude Code sessions, generates
> images, and drives the Mac itself. It lives in the MacBook notch, shows background work as
> screen-corner bubbles, and surfaces everything in a clean "activity center" dashboard.
>
> **Personal use only. Local machine only. Single user (the user).** No auth, analytics, telemetry,
> CI/CD, or deployment infra beyond what local development needs.

This is the source-of-truth spec. It is organized by build phase (M1–M13; M1–M8 built, M9–M13 are
the SOTA-completeness arc specced from a 2026-07-19 research pass). A companion running log lives in
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
  sessions; a burned live profile is unacceptable blast radius). Auth = capture-once-replay:
  the user logs in interactively once per site; storage state (cookies + localStorage) is persisted
  and injected into fresh contexts — no stored passwords, ever. Tools mirror the AX contracts
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

## M9–M13 — SOTA completeness arc (specced 2026-07-19 from two research passes)

M1–M8 built a voice agent that *acts* — on the web, the Mac, and code — under strong containment.
Two parallel Fable research passes (one on frontier techniques/papers, one on the OSS/product
landscape) independently mapped what separates Gumbo from a *complete* state-of-the-art personal
agent, and they converged. The control/containment stack is already at or ahead of the field:
deterministic out-of-band gating (policy table + Seatbelt + egress proxy + confirms) is the exact
defense family that survived 2026's adaptive-attack evaluations while in-band detectors/classifiers
fell ([arxiv 2606.26479](https://arxiv.org/abs/2606.26479)); the flat act→observe loop with a coding
lane is what Agent S3 reached by *ablating* its own manager-worker hierarchy
([simular.ai/articles/agent-s3](https://www.simular.ai/articles/agent-s3)); orchestrator-worker with
tool-description routing matches Anthropic's production research architecture. The real gaps are all
*accumulation and knowing the user*: Gumbo keeps a full event log but never learns from it, can't read
his mail or calendar, speaks only when pushed-to-talk or on a timer, and doesn't track when its own
context has been touched by untrusted content. These five phases add each capability, and — the
load-bearing constraint — **every one reuses an existing seam** (the scheduler `kind`, the event log,
the policy table, sqlite/FTS5, the MacBridge) rather than new infrastructure. Full gap analyses,
citations, and the "already-SOTA / anti-recommendations" lists are in IMPLEMENTATION_NOTES
§"M9–M13 gap analysis". Sequenced by dependency: memory first (it personalizes the rest); provenance
before more private data lands; connectors before the proactive layer that reads them.

### M9 — Memory & the model of the user (specced 2026-07-19)

Both research passes ranked this the #1 missing capability. Gumbo keeps a complete sqlite event log
and a memory table but never *learns the user*: preferences stated by voice evaporate, finished tasks
are stored but never distilled, and the event log is replayed for session continuity yet never
mined. This is the phase that makes "personal" true — and it introduces no new infrastructure.

- **Core-memory blocks (self-editing, always in context).** 3–5 pinned rows in the memory table — a
  user profile, durable preferences, active projects/people — that the orchestrator edits with a new
  daemon-side `remember`/`update_memory` realtime tool and that are injected into the realtime session
  instructions at connect (the session-rebuild-from-event-log path is exactly where they belong).
  MemGPT/Letta's self-editing memory ([arxiv 2310.08560](https://arxiv.org/abs/2310.08560)) minus the
  server and paging. The blocks are small and human-readable — the user inspects and corrects them in
  the dashboard.
- **Sleep-time reflection as a scheduler consumer (`kind: 'reflection'`).** The generic scheduler
  `kind` seam ships its designed third consumer (reminder → routine → reflection): a nightly job feeds
  the day's event log + finished-task reports through the existing background sub-agent runner (cheap
  model) and emits (a) consolidated memory rows, (b) core-block updates, (c) a one-paragraph episodic
  day summary. **Consolidate, never blind-append** — mem0's extract→update/merge/supersede
  ([arxiv 2504.19413](https://arxiv.org/abs/2504.19413); sleep-time compute
  [2504.13171](https://arxiv.org/abs/2504.13171)). Reflection runs while Gumbo is idle, so interactive
  turns start pre-digested.
- **Hybrid semantic recall.** FTS5 keyword recall fails on paraphrase ("that pergola thing" vs a
  stored "patio cover"). Two steps: (1) a `search_memory` realtime tool over the existing FTS5 — zero
  new infra, immediate voice-reachable recall; (2) sqlite-vec alongside FTS5 (node:sqlite loads
  extensions), embed rows + notes, fuse BM25 + vector with reciprocal-rank fusion, under the provider
  conventions (typed errors, one audit line per embedding call). **Privacy fork to decide at build:**
  embedding text via the OpenAI key sends it to a provider — fine for search-derived rows (already
  provider-touched), a real decision for personal notes; the privacy-clean alternative is an on-device
  embedding model at the cost of new infra. Skip rerankers and graph RAG until hybrid demonstrably
  misses.

**Demo:** "remember I prefer aisle seats and my sister's name is Mara" → weeks later, "book me a
flight to see my sister" recalls both without being told; overnight, Gumbo consolidates a week of
scattered mentions into a two-line profile the user can read in the dashboard.

**Considered and rejected:** cloud memory platforms (hosted Letta/Mem0/Zep) — the *techniques* port to
local sqlite; the products move the user's user model off-device, against keys-stay-daemon-side.
Knowledge-graph RAG (GraphRAG/HippoRAG) — a heavy standing index for corpus-scale multi-hop QA; at
n-of-1 scale hybrid BM25+vector wins on cost/simplicity. Monolithic memory rewrites — ACE's "context
collapse" ([arxiv 2510.04618](https://arxiv.org/abs/2510.04618)); updates are always deltas.

### M10 — Provenance & taint-aware gating (specced 2026-07-19)

The most *principled* thing Gumbo can add, and the technique pass's #2: it closes the M7 literal-URL
exfil residual (the one the review flow kept circling) with a rule instead of a host-allowlist regex,
and it hardens the whole computer-use + web surface before M11 adds a pile of private data to protect.
The 2026 adaptive-attack evidence is decisive — deterministic out-of-band enforcement (reference
monitors, information-flow labels) held under defense-aware attack while in-band detectors broke at
>90% ([arxiv 2606.26479](https://arxiv.org/abs/2606.26479)). Gumbo's gates are already that family;
they're just missing provenance.

- **Taint as a task-level bit, not an interpreter.** Every tool result already flows through the
  daemon — stamp each with a source class (`user | web | screen | file`) in the event log. The first
  `web`/`screen` ingestion flips the task's `tainted` flag. Biba-style integrity labeling grafted onto
  existing gates — days, not weeks — not a CaMeL-style plan interpreter.
- **A stricter lane for tainted tasks in `gateScript` / the policy table.** Once tainted: network
  sends and `do shell script` escalate unconditionally; literal-URL navigation is blocked outright
  (this *is* the M7 residual's principled fix — a task that has read untrusted content may not open a
  URL built from it, allowlist or no); and the notch confirm renders a "this task has read untrusted
  web/screen content" banner so the user's approval is *informed*, not blind.
- **Context minimization for the worst edge (optional).** Scrape/OCR results destined for a
  computer-use task pass through a quarantined summarize-to-facts call first (one of the six documented
  injection-defense patterns, [arxiv 2506.08837](https://arxiv.org/abs/2506.08837)) — the model acts on
  extracted facts, never the raw attacker-controlled bytes.

**Demo:** a research task that scraped an attacker-controlled page then tries to `open location` a URL
containing text it read → blocked with a spoken "that task read web content and is trying to open a URL
built from it — I've stopped it," where the M7 gate leaned on the host allowlist alone.

**Considered and rejected:** full CaMeL/NOVA plan interpreters — provable control-flow integrity costs
~43% of frontier capability on OSWorld and still leaks via Branch Steering
([arxiv 2601.09923](https://arxiv.org/abs/2601.09923)); capability-scoped gates + taint labels buy
most of the protection at none of the capability tax. In-band injection classifiers as the primary
gate — the class that broke under adaptive attack; acceptable only as a cheap advisory signal layered
on top, never as the boundary.

### M11 — Personal-data connectors (specced 2026-07-19)

The OSS/product pass's #1: the defining capability of every shipped personal agent (OpenClaw, POHA,
Aitne, Khoj all lead with it) and Gumbo's single largest gap versus the field. "What did Mara text
me?", "when's my dentist appointment?", "summarize this morning's mail" are the queries a *personal*
agent actually gets, and Gumbo can answer none today. The access recipes are fully documented and the
shell-owns-TCC architecture is already the correct shape (independently validated by iMCP, which uses
the exact GUI-owns-grants + bridge split).

- **Read tools via the shell's TCC + node:sqlite — native, not third-party MCP servers.** Extend the
  M6 MacBridge with read actions: EventKit calendar read + Contacts-framework search (shell-side, it
  already owns Automation TCC); daemon-side read-only node:sqlite over Messages' `chat.db` and Mail's
  Envelope Index (the documented recipe — JXA message/mail reading is broken/too-slow on recent macOS,
  so direct SQLite reads are the field standard). Native tools keep the keys/TCC posture; third-party
  MCP servers would not.
- **Four realtime tools, read-only auto-allow.** `calendar_lookup`, `messages_lookup`, `mail_lookup`,
  `contacts_lookup` — query live, persist nothing new, auto-run (reads are reversible). **Every send
  stays behind the existing notch gates** (the M6 mail-send gate already exists). A contacts-enrichment
  cache resolves numbers/emails to names so "who texted me" reads like a person would say it.
- **The TCC + privacy trade-off, surfaced to the user up front.** Reading `chat.db` and the Mail index
  needs **Full Disk Access** — a new, powerful grant and the biggest privacy-footprint increase in
  Gumbo's arc. Minimal-first: one connector at a time, read-only, and FDA is presented as a deliberate
  decision, not slipped in.

**Demo:** "what did Mara text me yesterday, and am I free for lunch Thursday?" — answered from Messages
+ Calendar in one turn, names resolved, nothing sent, nothing stored.

**Considered and rejected:** a multi-channel chat gateway / device-node pairing / skills marketplace
(OpenClaw's growth surface) — every channel is an outward auth+exfil surface and multi-device pairing
is multi-tenant infra in disguise, against loopback-only/single-user. If remote reachability is ever
wanted, the minimal move is a single iMessage channel via this connector, flagged as a deliberate
posture change first.

### M12 — Proactive presence (specced 2026-07-19)

Both passes converged here from different angles — the OSS pass on *what* (morning brief + watchers,
the POHA/Aitne/Khoj pattern), the technique pass on *how to be polite about it* (calibrated
proactivity / interruption etiquette). The scheduler — the hard part — already exists; this ships its
proactive consumers plus the etiquette that keeps them from being an annoyance. Depends on M11
(watchers read the connectors), reads best after M9 (the brief is personalized) and M10
(watcher-ingested content is tainted).

- **Morning brief (`kind: 'brief'`).** One scheduled task fans out to sub-agents (calendar + mail via
  M11, overnight X/news via the existing Grok/Exa tools), synthesizes, and delivers as a notch card +
  an optional spoken summary at the *first PTT of the day* — never an unprompted cold monologue.
- **Watchers with two-tier triage (`kind: 'watch'`).** Aitne's cost-and-attention-protecting pattern:
  cheap polling of connectors/search into a sqlite `observations` table *without spawning sessions*; a
  scheduled cheap-model triage pass; escalation to a real sub-agent + a notch notification *only* on
  genuine signal. Quiet hours and a per-day cost cap are first-class.
- **Interruption etiquette (deterministic, shell-side).** The "small always-on trigger" of the
  proactivity literature (PRISM's asymmetric speak-or-stay-silent cost,
  [arxiv 2602.01532](https://arxiv.org/abs/2602.01532)) reduced to zero-cost signals macOS already
  exposes: hold/queue non-urgent announcements while a realtime session is live, Focus/DND is on, or
  screen capture/sharing is active (the shell knows all three), and flush the queue at the next PTT
  press as a one-line "while you were away." No trigger model, no monitoring — pure Swift.

**Demo:** Gumbo stays silent through a screen-shared meeting, then at the first PTT after: "while you
were presenting — two things: your 3pm moved to 4, and the invoice you were watching for arrived."

**Considered and rejected:** always-on ambient activity sensing / a wake word for anticipatory
suggestions — the research pattern needs exactly the continuous capture PTT was chosen to avoid.
**PTT is Gumbo's consent boundary, not a limitation to engineer away.** (Wake word stays deferred as a
hands-free *input* convenience — a separate decision from proactivity.)

### M13 — Self-improvement & evaluation (specced 2026-07-19)

The capstone: Gumbo's traces are write-only today — nothing distills a successful run into reusable
procedure, nothing learns from a failure, and there's no regression check on the *behavioral* layer.
This closes the loop, deliberately reusing M9's nightly reflection job as the single curator (one
mechanism, not a parallel learning system).

- **Reflexion-lite (learn from failure).** On a task failure/abort, one extra background call writes a
  three-line "symptom / cause / try-instead" lesson to the memory table, keyed by task kind + target
  app/site (Reflexion, [arxiv 2303.11366](https://arxiv.org/abs/2303.11366)). The next similar task
  retrieves and prepends it — one API call per failure, one FTS query per spawn.
- **Procedure promotion feeding M8.** The nightly reflection job is the curator that promotes
  *successful* multi-step runs into M8 procedures and *failed* ones into lessons. **Delta updates
  only** — procedures are small structured entries amended incrementally, never wholesale rewritten
  (ACE's context-collapse mode, [arxiv 2510.04618](https://arxiv.org/abs/2510.04618)). This makes M8's
  procedure memory a living skill library (Voyager, [arxiv 2305.16291](https://arxiv.org/abs/2305.16291))
  rather than a static macro store.
- **A behavioral regression harness.** ~20 recorded `utterance → expected-tool-call` pairs harvested
  from the event log, replayed by `node --test` against the realtime tool registry — so "remind me
  Tuesday" still routes to the scheduler after an orchestrator-instruction tweak. The unit suite covers
  code; this covers *routing*, the design's weakest link.
- **Pre-announce claim check.** A cheap list-wise self-check on research reports before they're
  announced — each claim must have a fetched source behind it (list-wise verification,
  [arxiv 2506.12928](https://arxiv.org/abs/2506.12928)) — so a finished-task announce doesn't
  confidently read out an unsupported claim.

**Demo:** a computer-use task that failed on an AX-hostile pane last week silently succeeds this week
because the retrieved lesson routed it straight to the vision lane; a routing-regression run catches
that an instruction edit broke "set a timer."

**Considered and rejected:** trajectory→skill distillation into fine-tuning, LLM-judge eval panels,
reference-free trajectory scoring at scale (HAL/TRACE/AdaRubric) — real techniques, but eval
*infrastructure* for teams shipping to many users; at n-of-1 the lightweight lesson/regression loop is
the right weight. Debate/verifier panels — fixed-budget multi-agent synergy collapses via correlated
errors and measures *less* aligned than single agents
([arxiv 2601.17311](https://arxiv.org/abs/2601.17311)), the wrong direction for a machine-controlling
agent.

### Ongoing polish (field-borrowed, not phase-gated)

Small, high-value borrows to fold in opportunistically rather than as phases: coding-session
git-safety (snapshot dirty state to a temp ref before a Claude session; a "revert last coding task"
voice tool — Aider's discipline); per-computer-task trajectory JSONL + keep-last-N-image pruning in
the vision loop (Anthropic computer-use best-practices); a `validate(prompt)→bool` end-of-task
assertion (Skyvern); preferring non-focus AX actions so the agent doesn't steal the cursor (cua);
parallel Exa/Grok fan-out within a breadth-first research task (the one multi-agent win worth taking —
no new agents).

**Deferred (post-M13):** wake word (a hands-free *input* convenience, unrelated to proactivity — PTT
stays the consent boundary); a full-duplex GPT-Live model swap (Moshi-class models trail frontier
models on reasoning/tool-use, and the production realtime stack is itself still half-duplex — revisit
when a frontier-quality full-duplex API ships); launchd auto-start; deeper agent self-organization.
**Firmly out of scope, re-validated by the 2026 research:** Behavior Best-of-N (needs resettable VMs;
unsafe on a live Mac), cloud memory platforms, knowledge-graph RAG at n-of-1, in-band injection
classifiers as a primary gate, multi-agent debate/organizations (measurably less aligned than single
agents), and any telemetry.

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
