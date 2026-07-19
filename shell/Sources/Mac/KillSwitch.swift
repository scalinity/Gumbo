import AppKit
import CoreGraphics

/// M6 kill switch: while a computer-use task is active, a LISTEN-ONLY session event tap
/// watches all HID input. Every event Gumbo synthesizes carries the SyntheticInput tag;
/// anything UNTAGGED is the user touching the machine → instant abort. This replaces the
/// naive "any mouse movement aborts" design, which self-triggered the moment the dispatch
/// ladder's global rung moved the real pointer (research correction, 2026-07-16).
///
/// A dedicated abort hotkey is deliberately absent in v1: ANY untagged key press already
/// aborts, which subsumes it (cooperative pause-and-resume is M7).
final class KillSwitch {
    /// Fired once per arm, on the main thread, with the abort reason for the daemon.
    var onFire: ((String) -> Void)?

    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    /// Returns true if the listen-only tap was created. False means the PostEvent grant is
    /// missing — the caller MUST fail closed (refuse the task), never drive the machine
    /// without a human-input abort. Deliberately NOT @discardableResult: ignoring this
    /// Bool is exactly the fail-open bug the review caught, so make it a compiler warning.
    func arm() -> Bool {
        guard tap == nil else { return true }
        let types: [CGEventType] = [
            .keyDown, .keyUp, .flagsChanged,
            .mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
            .leftMouseDragged, .rightMouseDragged, .otherMouseDown, .otherMouseUp, .scrollWheel,
        ]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly, // observe, never block — the user's input must always win
            eventsOfInterest: mask,
            callback: { _, type, event, userInfo in
                guard let userInfo else { return Unmanaged.passUnretained(event) }
                let killSwitch = Unmanaged<KillSwitch>.fromOpaque(userInfo).takeUnretainedValue()
                killSwitch.consider(type: type, event: event)
                return Unmanaged.passUnretained(event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            NSLog("KillSwitch: could not create event tap — PostEvent permission missing?")
            return false
        }
        self.tap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    func disarm() {
        guard let tap else { return }
        CGEvent.tapEnable(tap: tap, enable: false)
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        CFMachPortInvalidate(tap)
        self.tap = nil
        runLoopSource = nil
    }

    private func consider(type: CGEventType, event: CGEvent) {
        // The OS disables a tap whose callback lags (or on user-input pressure for
        // non-listen taps) — re-enable rather than silently going blind mid-task.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        // Gumbo's own synthetic events (tagged) pass; untagged input is the user.
        if SyntheticInput.isSynthetic(event) { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.tap != nil else { return } // one shot per arm
            self.disarm()
            self.onFire?("human_input")
        }
    }
}
