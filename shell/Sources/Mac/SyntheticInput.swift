import AppKit
import CoreGraphics

/// M6 dispatch-ladder rungs 2 and 3: synthetic mouse/keyboard events, every one TAGGED so
/// the kill-switch tap can tell Gumbo's own input from the user's hand on the machine. The
/// research correction (2026-07-16): "any real-mouse movement aborts" self-triggers the
/// moment the global rung moves the real pointer — so we mark our events instead of
/// watching for motion. Untagged HID input = the user = abort (KillSwitch, Phase 3).
enum SyntheticInput {
    /// Stamped into `.eventSourceUserData` on every event we post. "GUMBO" in ASCII hex —
    /// a value real HID events never carry (the field defaults to 0 for hardware input).
    static let tag: Int64 = 0x47_55_4D_42_4F

    /// One reused source. `.privateState` keeps our synthetic modifier/key state from
    /// bleeding into the user's real keyboard state (a stuck ⌘ after a posted shortcut).
    static let source: CGEventSource? = {
        let src = CGEventSource(stateID: .privateState)
        src?.userData = tag // belt: source-level tag, mirrored per-event below
        return src
    }()

    private static func tagged(_ event: CGEvent?) -> CGEvent? {
        event?.setIntegerValueField(.eventSourceUserData, value: tag)
        return event
    }

    /// True if this event is one of ours — read by the kill-switch listen-only tap.
    static func isSynthetic(_ event: CGEvent) -> Bool {
        event.getIntegerValueField(.eventSourceUserData) == tag
    }

    // MARK: mouse (pid-targeted rung 2, global rung 3)

    /// Click at a screen point (top-left origin, matching AXPosition). A short move first
    /// primes hover state (Chromium wants it). pid != nil → rung 2 (CGEventPostToPid,
    /// background-safe, doesn't fight the user's pointer); pid == nil → rung 3 (global HID,
    /// the only rung that moves the real cursor — used for drags and stubborn widgets).
    /// clicks: 2 = a real double-click (each pair stamped with its click state — two
    /// independent single clicks do NOT register as a double).
    static func click(at point: CGPoint, pid: pid_t?, button: CGMouseButton = .left, clicks: Int = 1) {
        let (downType, upType): (CGEventType, CGEventType) = button == .right
            ? (.rightMouseDown, .rightMouseUp)
            : (.leftMouseDown, .leftMouseUp)
        let move = tagged(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button))
        post(move, pid: pid)
        for state in 1...max(1, clicks) {
            let down = tagged(CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: button))
            let up = tagged(CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: button))
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(state))
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(state))
            post(down, pid: pid)
            post(up, pid: pid)
        }
    }

    // MARK: keyboard

    /// Type a string into the focused element via per-character Unicode key events —
    /// the fallback for Electron/web fields, whose JS listeners ignore AXValue writes but
    /// fire on real key events.
    static func type(_ text: String, pid: pid_t?) {
        for scalar in text.unicodeScalars {
            let s = String(scalar)
            for keyDown in [true, false] {
                guard let event = tagged(CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: keyDown)) else { continue }
                let utf16 = Array(s.utf16)
                event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                post(event, pid: pid)
            }
        }
    }

    /// Post a keyboard shortcut like "cmd+n", "cmd+shift+t", "return", "escape". Unknown
    /// chords are a no-op (the caller surfaces it as a failed act via the empty diff).
    static func pressKey(_ chord: String, pid: pid_t?) -> Bool {
        var flags: CGEventFlags = []
        var keyName = chord
        let parts = chord.lowercased().split(separator: "+").map(String.init)
        if parts.count > 1 {
            for mod in parts.dropLast() {
                switch mod {
                case "cmd", "command", "⌘": flags.insert(.maskCommand)
                case "opt", "option", "alt", "⌥": flags.insert(.maskAlternate)
                case "ctrl", "control", "⌃": flags.insert(.maskControl)
                case "shift", "⇧": flags.insert(.maskShift)
                default: break
                }
            }
            keyName = parts.last ?? chord
        }
        guard let keyCode = keyCodes[keyName.lowercased()] else { return false }
        for keyDown in [true, false] {
            guard let event = tagged(CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: keyDown)) else { return false }
            event.flags = flags
            post(event, pid: pid)
        }
        return true
    }

    private static func post(_ event: CGEvent?, pid: pid_t?) {
        guard let event else { return }
        // Rung 2 = pid-targeted (background-safe, doesn't fight the user's pointer);
        // rung 3 = global HID.
        if let pid { event.postToPid(pid) } else { event.post(tap: .cghidEventTap) }
    }

    /// US-ANSI virtual keycodes — enough for the shortcuts the demos exercise (⌘N, ⌘L,
    /// ⌘T, return/tab/escape/arrows). Extend as procedures need more.
    private static let keyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
        "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31,
        "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
        "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    ]
}
