import AppKit
import CoreGraphics

/// M6 kill switch: while a computer-use task is active, a LISTEN-ONLY session event tap
/// watches all HID input. Every event Gumbo synthesizes carries the SyntheticInput tag;
/// anything UNTAGGED is the user touching the machine → instant abort. This replaces the
/// naive "any mouse movement aborts" design, which self-triggered the moment the dispatch
/// ladder's global rung moved the real pointer (research correction, 2026-07-16).
///
/// A dedicated abort hotkey is deliberately absent in v1: ANY untagged key press already
/// aborts, which subsumes it. M7 carves out exactly two things:
///  1. Pure-modifier events (.flagsChanged) never abort — the ⌃⌥ push-to-talk chord IS a
///     flagsChanged, and voice steering into a running task requires holding it. A
///     modifier alone can neither type nor click, so this gives up no takeover coverage.
///  2. Handoff mode: while the daemon says the user is performing a step HIMSELF (login,
///     dialog), his input is the handoff, not an abort.
final class KillSwitch {
    /// Fired once per arm, on the main thread, with the abort reason for the daemon.
    var onFire: ((String) -> Void)?

    /// M7 cooperative handoff — set on the main thread (MacBridge routes mac_handoff
    /// there), read on the tap's thread. A Bool read can't tear on arm64; the worst race
    /// is one event judged under the previous mode, which the daemon-side lifecycle
    /// (status flip before/after the notch confirm) makes harmless.
    var handoffActive = false

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
        // M7: pure-modifier presses never abort — ⌃⌥ is the PTT chord (voice steering
        // rides it), and modifiers alone cannot drive the machine.
        if type == .flagsChanged { return }
        // M7 handoff: the user is doing his step — his input is the point, not an abort.
        if handoffActive { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.tap != nil else { return } // one shot per arm
            self.disarm()
            self.onFire?("human_input")
        }
    }
}
