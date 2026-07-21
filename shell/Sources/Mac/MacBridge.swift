import AppKit

/// M6 shell-side dispatcher: receives `mac_action` from the daemon, runs it (AX via
/// AXExecutor off the main thread, or a script via ScriptRunner), and replies
/// `mac_action_result` with the same correlation id. Also owns the `mac_task` lifecycle —
/// arming the kill switch + ghost cursor while a computer-use task drives the machine.
///
/// The shell is the hands because it holds the TCC grants; the daemon is the brain. Same
/// split as reminders (RemindersBridge) and confirms — this is the third such client.
final class MacBridge {
    /// Send a JSON frame back to the daemon (wired to WSClient.sendJSON in App.swift).
    var onReply: (([String: Any]) -> Void)?

    /// M8: the notch shows a persistent "Watching…" while the recorder is live (SPEC:
    /// recording must be visibly indicated the whole time). Wired in App.swift.
    var onRecordingChanged: ((Bool) -> Void)?
    /// M8: the teaching task's id while recording (from mac_teach) — App routes a click on THAT
    /// task's orb to "finish teaching" instead of opening the dashboard. Main-thread only.
    private(set) var teachingTaskId: String?
    /// Fires (on main) when teachingTaskId changes, so App can tell BubbleController which orb ends
    /// the demonstration on click. Carries nil when teaching stops.
    var onTeachingTaskChanged: ((String?) -> Void)?

    private let executor = AXExecutor()
    private let ghost = GhostCursor()
    private let killSwitch = KillSwitch()
    private lazy var recorder = Recorder(executor: executor)
    /// Main-thread only, like sessionArmed.
    private var recordingActive = false
    // AX + scripts run off the main thread (dense traversal / a blocking child process
    // would jank the notch). Serial so the ref-map generation stays coherent.
    private let work = DispatchQueue(label: "ai.scalinity.gumbo.mac.bridge")

    init() {
        // Kill switch fires on the main thread; forward it to the daemon so it cancels the
        // running computer-use task(s), and stop the ghost cursor immediately.
        killSwitch.onFire = { [weak self] reason in
            self?.ghost.hide()
            self?.reply(["type": "mac_abort", "reason": reason])
        }
        // M8: each semantic step the recorder resolves rides the wire immediately —
        // fire-and-forget like mac_abort; the daemon sanitizes and buffers.
        recorder.onStep = { [weak self] step in
            self?.reply(["type": "teach_event", "step": step])
        }
    }

    /// All replies to the daemon go out on the MAIN thread — action results are produced on
    /// the `work` queue while aborts fire on main, and every other App.swift sender posts
    /// from main, so funnel through one thread to keep ordering unambiguous.
    private func reply(_ json: [String: Any]) {
        if Thread.isMainThread { onReply?(json) } else { DispatchQueue.main.async { self.onReply?(json) } }
    }

    /// Route one inbound daemon message. Returns true if it was a mac_* message we handled.
    func handle(_ msg: [String: Any]) -> Bool {
        switch msg["type"] as? String {
        case "mac_action":
            guard let id = msg["id"] as? String, let action = msg["action"] as? [String: Any] else { return true }
            dispatch(id: id, action: action)
            return true
        case "mac_task":
            let active = msg["active"] as? Bool ?? false
            DispatchQueue.main.async { active ? self.armSession() : self.disarmSession() }
            // NOTE: the clipboard safety-net restore is driven by the DAEMON on genuine task
            // end (manager.finish → clipboard_restore), NOT here — an unattended park also
            // sends mac_task active:false (refcount 1→0→1) and restoring here would evict a
            // just-copied image mid-save.
            return true
        case "mac_handoff":
            // M7: the user is doing a step himself — stand the kill switch down and hide
            // the ghost (his real cursor is the one that matters right now).
            let active = msg["active"] as? Bool ?? false
            DispatchQueue.main.async {
                self.killSwitch.handoffActive = active
                if active {
                    self.ghost.hide()
                } else if self.sessionArmed {
                    self.ghost.show()
                }
            }
            return true
        case "mac_teach":
            // M8 resync: a shell that (re)connected mid-teach re-arms its recorder;
            // active:false stops a recorder whose daemon-side session died (restart,
            // cancel, disconnect). Broadcast — no correlation id to answer.
            let active = msg["active"] as? Bool ?? false
            let taskId = msg["task_id"] as? String
            DispatchQueue.main.async {
                self.teachingTaskId = active ? taskId : nil
                self.onTeachingTaskChanged?(self.teachingTaskId)
                if active { self.resumeRecording() } else { self.stopRecordingLocal() }
            }
            return true
        default:
            return false
        }
    }

    // MARK: action dispatch

    private func dispatch(id: String, action: [String: Any]) {
        work.async { [weak self] in
            guard let self else { return }
            let kind = action["kind"] as? String ?? ""
            let result: [String: Any]
            switch kind {
            case "script":
                result = self.runScript(action)
            case "ocr", "screenshot":
                // M7 vision lane — ScreenCaptureKit + Vision, blocking-bridged on this
                // serial queue (never main). First use triggers the Screen Recording prompt.
                result = ScreenVision.perform(action)
            case "point":
                result = self.performPoint(action)
            case "record_start":
                // M8: arm the tap in record mode. Main-thread (tap runloop + UI flag),
                // synchronously from this worker so the ack carries the real outcome.
                result = DispatchQueue.main.sync { self.startRecording() }
            case "record_stop":
                // Flushes the pending typing burst BEFORE this ack goes out — the daemon
                // counts on that ordering to have every step when the ack resolves.
                result = DispatchQueue.main.sync { () -> [String: Any] in
                    self.stopRecordingLocal()
                    return AXResult(ok: true, output: "stopped", errorKind: nil, health: nil).wire()
                }
            case "activate":
                // Open OR focus an app by (approximate) name — fuzzy-resolve against
                // installed apps ("ChatGPT" → "ChatGPT Classic") and launch if not
                // running. Runs on main (AppKit/AX foregrounding is main-thread work).
                let app = action["app"] as? String ?? ""
                let resolved = DispatchQueue.main.sync { app.isEmpty ? nil : Foreground.openOrFront(app: app) }
                result = resolved != nil
                    ? AXResult(ok: true, output: "Opened \"\(resolved!)\".", errorKind: nil, health: nil).wire()
                    : AXResult.failure("element_not_found", "No running or installed app matches \"\(app)\".").wire()
            case "clipboard_snapshot":
                // M8 image-save: preserve the user's clipboard before a "Copy Image" clobbers
                // it. Main-thread (AppKit pasteboard), synchronous so the ack is truthful.
                result = DispatchQueue.main.sync {
                    PasteboardSnapshot.snapshot()
                    return AXResult(ok: true, output: "clipboard saved", errorKind: nil, health: nil).wire()
                }
            case "clipboard_restore":
                result = DispatchQueue.main.sync {
                    PasteboardSnapshot.restore()
                    return AXResult(ok: true, output: "clipboard restored", errorKind: nil, health: nil).wire()
                }
            case "cursor_to":
                // M7 browser-lane cursor continuity: in-page acts happen over CDP (no HID
                // at all), so the ghost is their only visible trace. Fire-and-forget.
                if let x = (action["x"] as? NSNumber)?.doubleValue, let y = (action["y"] as? NSNumber)?.doubleValue {
                    DispatchQueue.main.async { self.ghost.move(to: CGRect(x: x - 2, y: y - 2, width: 4, height: 4)) }
                }
                result = AXResult(ok: true, output: "", errorKind: nil, health: nil).wire()
            default:
                // For an act, fly the ghost cursor to the target frame first (pure
                // visualization — the AX/pid rungs don't move the real pointer).
                if kind == "act", let ref = action["ref"] as? String, let frame = self.executor.frame(ofRef: ref) {
                    DispatchQueue.main.async { self.ghost.move(to: frame) }
                }
                result = self.executor.perform(action)
            }
            self.reply(["type": "mac_action_result", "id": id, "result": result])
        }
    }

    /// M7 vision-lane act: click at global point coords (from screen_ocr). The ghost flies
    /// first and gets a beat to arrive (the AX path's double walk gives that delay
    /// naturally; a point click would otherwise fire before the bloom lands). Global rung
    /// by design — this lane exists precisely where per-element targeting failed.
    private func performPoint(_ action: [String: Any]) -> [String: Any] {
        guard let x = (action["x"] as? NSNumber)?.doubleValue, let y = (action["y"] as? NSNumber)?.doubleValue else {
            return AXResult.failure("out_of_scope", "point needs x and y.").wire()
        }
        let verb = action["verb"] as? String ?? "click"
        let point = CGPoint(x: x, y: y)
        DispatchQueue.main.async { self.ghost.move(to: CGRect(x: point.x - 2, y: point.y - 2, width: 4, height: 4)) }
        usleep(150_000)
        switch verb {
        case "right_click": SyntheticInput.click(at: point, pid: nil, button: .right)
        case "double_click": SyntheticInput.click(at: point, pid: nil, clicks: 2)
        default: SyntheticInput.click(at: point, pid: nil)
        }
        return AXResult(ok: true, output: "\(verb) at (\(Int(x)),\(Int(y))). No diff for point acts — verify with screen_ocr or ax_snapshot.", errorKind: nil, health: nil).wire()
    }

    private func runScript(_ action: [String: Any]) -> [String: Any] {
        let interpreter = action["interpreter"] as? String ?? "osascript"
        let script = action["script"] as? String ?? ""
        let timeoutMs = action["timeout_ms"] as? Int ?? 60_000
        let out = ScriptRunner.run(interpreter: interpreter, script: script, timeoutMs: timeoutMs)
        var result: [String: Any] = ["ok": out.ok, "output": out.text]
        if let kind = out.errorKind { result["error_kind"] = kind }
        return result
    }

    // MARK: session lifecycle (main thread)

    /// Whether a computer-use session is armed — the handoff-end path only re-shows the
    /// ghost while a task is actually driving (main-thread only, like arm/disarm).
    private var sessionArmed = false

    private func armSession() {
        // M8 defensive: the daemon guarantees teaching and tasks never coexist — if a
        // mac_task still arrives mid-recording, refuse rather than convert the recorder
        // into an abort tap under the user's demonstrating hands.
        guard killSwitch.mode != .record else {
            NSLog("MacBridge: refusing to arm a task session while recording")
            return
        }
        // Fail CLOSED: if the kill switch can't arm (PostEvent grant missing), we must not
        // let the task drive the machine with no human-input abort — tell the daemon to
        // cancel it, and don't show the ghost cursor (nothing will be driving).
        // Ordering assumption: the abort races the task's FIRST action, but that action
        // needs a full model turn (seconds) while this abort is one loopback frame — the
        // daemon cancels long before any act arrives. Attended use makes the residual moot.
        guard killSwitch.arm() else {
            reply(["type": "mac_abort", "reason": "kill_switch_unavailable"])
            return
        }
        sessionArmed = true
        ghost.show()
    }

    private func disarmSession() {
        sessionArmed = false
        killSwitch.handoffActive = false // a task ending mid-handoff must not leave the tap soft
        // M8: recording owns the tap — resync broadcasts a mac_task active:false on every
        // shell hello, and that must not tear down an active recording mid-teach.
        if killSwitch.mode != .record { killSwitch.disarm() }
        ghost.hide()
    }

    // MARK: M8 recording lifecycle (main thread)

    private func startRecording() -> [String: Any] {
        guard !sessionArmed else {
            return AXResult.failure("out_of_scope", "A computer task is driving the Mac — cannot record now.").wire()
        }
        guard !recordingActive else {
            return AXResult(ok: true, output: "already recording", errorKind: nil, health: nil).wire()
        }
        killSwitch.mode = .record
        killSwitch.onRecordEvent = { [weak self] raw in self?.recorder.ingest(raw) }
        // Fail CLOSED, like armSession: teaching without a live tap would be a silently
        // un-recorded "recording" — the daemon fails the teach session on this ack.
        guard killSwitch.arm() else {
            killSwitch.mode = .abort
            killSwitch.onRecordEvent = nil
            return AXResult.failure("ax_unavailable", "The event tap could not be created (PostEvent grant missing) — cannot record.").wire()
        }
        recorder.start()
        recordingActive = true
        onRecordingChanged?(true)
        return AXResult(ok: true, output: "recording", errorKind: nil, health: nil).wire()
    }

    private func stopRecordingLocal() {
        guard recordingActive else { return }
        recorder.stop() // synchronous flush — final burst lands before any stop ack
        killSwitch.disarm()
        killSwitch.mode = .abort
        killSwitch.onRecordEvent = nil
        recordingActive = false
        onRecordingChanged?(false)
    }

    private func resumeRecording() {
        guard !recordingActive else { return }
        let result = startRecording()
        // A resync re-arm that fails must be LOUD: the daemon believes it's teaching.
        // mac_abort cancels every kind:'computer' task — the teach session included —
        // which is exactly the honest failure.
        if (result["ok"] as? Bool) != true {
            reply(["type": "mac_abort", "reason": "kill_switch_unavailable"])
        }
    }

    /// The daemon is gone (socket dropped): an active recording has nowhere to stream —
    /// stop it and clear the indicator. Daemon-side, the teach session dies on its own
    /// socket-close handler; a reconnect gets the truth re-stated via mac_teach resync.
    func handleSocketDropped() {
        DispatchQueue.main.async { self.stopRecordingLocal() }
    }
}
