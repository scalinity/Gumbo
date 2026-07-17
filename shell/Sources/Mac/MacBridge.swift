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
            self?.onReply?(["type": "mac_abort", "reason": reason])
        }
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
            if kind == "script" {
                result = self.runScript(action)
            } else {
                // For an act, fly the ghost cursor to the target frame first (pure
                // visualization — the AX/pid rungs don't move the real pointer).
                if kind == "act", let ref = action["ref"] as? String, let frame = self.executor.frame(ofRef: ref) {
                    DispatchQueue.main.async { self.ghost.move(to: frame) }
                }
                result = self.executor.perform(action)
            }
            self.onReply?(["type": "mac_action_result", "id": id, "result": result])
        }
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

    private func armSession() {
        ghost.show()
        killSwitch.arm()
    }

    private func disarmSession() {
        killSwitch.disarm()
        ghost.hide()
    }
}
