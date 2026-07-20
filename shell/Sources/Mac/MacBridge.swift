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

    private let executor = AXExecutor()
    private let ghost = GhostCursor()
    private let killSwitch = KillSwitch()
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
            case "activate":
                // Bring an app to the front via the AX grant (the system suppresses plain
                // open/activate). Runs on main (AppKit/AX foregrounding is main-thread work).
                let app = action["app"] as? String ?? ""
                let found = DispatchQueue.main.sync { app.isEmpty ? false : Foreground.bringToFront(app: app) }
                result = found
                    ? AXResult(ok: true, output: "brought \"\(app)\" to the front", errorKind: nil, health: nil).wire()
                    : AXResult.failure("element_not_found", "\"\(app)\" is not running — launch it first (run_script: tell application \"\(app)\" to launch).").wire()
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
        killSwitch.disarm()
        ghost.hide()
    }
}
