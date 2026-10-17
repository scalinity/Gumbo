import AppKit
import CoreGraphics

/// Listen-only input tap shared by the explicit Control–Shift–Escape stop shortcut
/// and demonstration recording. Ordinary typing, clicks and pointer movement leave
/// background tasks running. Synthetic events never trigger the shortcut or recorder.
final class KillSwitch {
    /// Fired once per arm, on the main thread, with the abort reason for the daemon.
    var onFire: ((String) -> Void)?

    /// Task mode listens only for the stop shortcut; record mode captures the demo.
    enum Mode { case abort, record }
    var mode: Mode = .abort

    /// Record-mode sink: a cheap scalar snapshot per untagged event. NO AX work may
    /// happen in this callback path — the tap callback lagging triggers
    /// tapDisabledByTimeout and events during the disabled window are silently lost;
    /// hit-testing runs on the recorder's own queue.
    var onRecordEvent: ((RecordedHID) -> Void)?

    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    /// Returns true if the listen-only tap was created. False means the PostEvent grant is
    /// missing — the caller MUST fail closed (refuse the task), never drive the machine
    /// without its explicit stop shortcut. Deliberately NOT @discardableResult: ignoring this
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
        // rides it), and modifiers alone cannot drive the machine. Record mode keeps the
        // exemption: keyDown events carry chord flags, so ⌘S is captured without it, and
        // the user can hold PTT mid-demo to say "done" without polluting the recording.
        if type == .flagsChanged { return }
        // M8 record mode: the user's input is the demonstration — forward, never abort.
        if mode == .record {
            switch type {
            case .keyUp, .mouseMoved: break // recorder noise (keyDown/drag/scroll carry the signal)
            default: onRecordEvent?(RecordedHID(type: type, event: event))
            }
            return
        }
        guard Self.isAbortShortcut(type: type, keyCode: event.getIntegerValueField(.keyboardEventKeycode), flags: event.flags) else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.tap != nil else { return } // one shot per arm
            NSLog("[kill-switch] explicit stop shortcut")
            self.disarm()
            self.onFire?("hotkey")
        }
    }

    static func isAbortShortcut(type: CGEventType, keyCode: Int64, flags: CGEventFlags) -> Bool {
        let modifiers = flags.intersection([.maskControl, .maskShift, .maskAlternate, .maskCommand])
        return type == .keyDown && keyCode == 53 && modifiers == [.maskControl, .maskShift]
    }
}
