import Foundation

/// M6 script lane: osascript (Apple Events) and `shortcuts run` (the App Intents bridge),
/// executed by the SHELL so TCC attributes the Automation/Shortcuts grants to Gumbo's
/// stable bundle id (a tsx-watch daemon would inherit the terminal's identity). Every call
/// is HARD timeout-wrapped: Tahoe regressed Apple-Events timing — some apps hang to the
/// 2-min -1712 timeout, and a prompting shortcut hangs forever otherwise.
enum ScriptRunner {
    struct Output {
        let ok: Bool
        let text: String
        let errorKind: String? // nil | "timeout" | "script_error"
    }

    /// interpreter: "osascript" runs `script` as AppleScript; "shortcuts" runs it as a
    /// shortcut identifier via `shortcuts run <id>`.
    static func run(interpreter: String, script: String, timeoutMs: Int) -> Output {
        let process = Process()
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        switch interpreter {
        case "shortcuts":
            process.executableURL = URL(fileURLWithPath: "/usr/bin/shortcuts")
            process.arguments = ["run", script]
        default:
            process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            process.arguments = ["-e", script]
        }

        do {
            try process.run()
        } catch {
            return Output(ok: false, text: "Could not launch \(interpreter): \(error.localizedDescription)", errorKind: "script_error")
        }

        // Hard timeout on a background queue — terminate the child if it overruns, so a
        // hung Apple-Events call can never wedge the loop or the waiting voice turn.
        let deadline = DispatchTime.now() + .milliseconds(timeoutMs)
        let timedOut = DispatchQueue.global().asyncAfterCancellable(deadline: deadline) {
            if process.isRunning { process.terminate() }
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let wasTimeout = timedOut.wasFired()
        timedOut.cancel()

        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if wasTimeout {
            return Output(ok: false, text: "\(interpreter) timed out after \(timeoutMs) ms (terminated).", errorKind: "timeout")
        }
        if process.terminationStatus != 0 {
            return Output(ok: false, text: text.isEmpty ? "\(interpreter) exited \(process.terminationStatus)." : text, errorKind: "script_error")
        }
        return Output(ok: true, text: text, errorKind: nil)
    }
}

/// A cancellable delayed work item that also records whether it fired — used to
/// distinguish a script that finished from one the timeout killed.
private final class CancellableTimer {
    private let fired = NSLock()
    private var didFire = false
    private var work: DispatchWorkItem?

    func setWork(_ work: DispatchWorkItem) { self.work = work }
    func markFired() { fired.lock(); didFire = true; fired.unlock() }
    func wasFired() -> Bool { fired.lock(); defer { fired.unlock() }; return didFire }
    func cancel() { work?.cancel() }
}

private extension DispatchQueue {
    func asyncAfterCancellable(deadline: DispatchTime, _ block: @escaping () -> Void) -> CancellableTimer {
        let timer = CancellableTimer()
        let work = DispatchWorkItem { timer.markFired(); block() }
        timer.setWork(work)
        asyncAfter(deadline: deadline, execute: work)
        return timer
    }
}
