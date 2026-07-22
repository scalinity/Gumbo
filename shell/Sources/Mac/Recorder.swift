import AppKit
import CoreGraphics

/// A cheap scalar snapshot of one untagged HID event, extracted IN the tap callback
/// (CGEvent field reads only — the event object itself never crosses threads, and no AX
/// call may run on the tap thread: a lagging callback triggers tapDisabledByTimeout and
/// events during the disabled window are silently lost).
struct RecordedHID {
    let type: CGEventType
    let location: CGPoint
    let keyCode: Int64
    let flags: CGEventFlags
    let chars: String
    let clickState: Int64

    init(type: CGEventType, event: CGEvent) {
        self.type = type
        self.location = event.location
        self.keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        self.flags = event.flags
        self.clickState = event.getIntegerValueField(.mouseEventClickState)
        if type == .keyDown {
            var length = 0
            var buffer = [UniChar](repeating: 0, count: 4)
            event.keyboardGetUnicodeString(maxStringLength: 4, actualStringLength: &length, unicodeString: &buffer)
            self.chars = length > 0 ? String(utf16CodeUnits: buffer, count: length) : ""
        } else {
            self.chars = ""
        }
    }
}

/// M8 watch-me recorder: turns the user's raw demonstration input into SEMANTIC steps —
/// the AX role/label/identifier of every element he touches, never coordinates (a pixel
/// recording is stale by the next window resize). Steps stream to the daemon one
/// teach_event at a time, at event time (the UI changes right after a click, so the
/// element must be resolved immediately).
///
/// SECRETS (hard requirement, SPEC §M8): keystrokes into a secure field (subrole
/// AXSecureTextField) or a credential-labeled field NEVER leave this process — not even
/// to the daemon. The burst is emitted as a semantic `secure_input` step ("the user
/// authenticated") with no content; the daemon compiles it into a handoff step.
final class Recorder {
    /// One semantic step, ready to ride the wire as teach_event. Called on the recorder
    /// queue; the receiver funnels to the socket thread itself.
    var onStep: (([String: Any]) -> Void)?

    private let executor: AXExecutor
    // All state lives on this queue. AX hit-testing happens here too — synchronously
    // into the executor's own serial queue (a chain, never a cycle: the executor never
    // calls back into the recorder or the main thread).
    private let queue = DispatchQueue(label: "ai.scalinity.gumbo.recorder")
    private var active = false

    /// A typing burst: consecutive keystrokes into one focused field. The field is
    /// RE-RESOLVED on every keystroke (the frozen-at-start decision was the review's 🔴:
    /// programmatic focus moves leaked content under the old field's sensitivity): a
    /// resolved focus change flushes and re-decides; an unresolvable read drops that
    /// keystroke's content without touching the burst. isSecure only ever reflects a
    /// RESOLVED field, and content of a secure burst is never accumulated at all.
    private struct Burst {
        var text: String
        let isSecure: Bool
        let field: AXHitInfo?
        var lastAt: CFAbsoluteTime
    }
    private var burst: Burst?
    private var dragging = false
    private var lastSelection: String? // dedup key (text#occurrence) — a click that didn't change the selection isn't re-emitted
    private var lastScrollAt: CFAbsoluteTime = 0
    private var lastScrollApp = ""

    private static let burstIdleSeconds: CFAbsoluteTime = 2.0

    /// Credential-shaped field labels (web OTP inputs, custom login forms) that must be
    /// treated as secure even without the AXSecureTextField subrole. Mirrored in the
    /// daemon's tasks/teach.ts as the belt; this is the primary gate.
    private static let secretLabel = try! NSRegularExpression(
        pattern: "passw|passcode|passphrase\\b|\\botp\\b|2fa|verification|secret|token|\\bpin\\b|cvv|security code|credential",
        options: [.caseInsensitive]
    )

    init(executor: AXExecutor) {
        self.executor = executor
    }

    func start() {
        queue.sync {
            active = true
            burst = nil
            dragging = false
            lastScrollApp = ""
            lastScrollAt = 0
        }
    }

    /// Synchronous flush-then-stop: every pending step is emitted BEFORE this returns,
    /// so the daemon receives the final typing burst before the record_stop ack (the
    /// ordering the daemon's stopTeaching relies on).
    func stop() {
        queue.sync {
            flushBurst()
            active = false
        }
    }

    /// Tap-thread entry: enqueue only. The heavy lifting (AX hit-tests) happens on the
    /// recorder queue so the tap callback never lags into tapDisabledByTimeout.
    func ingest(_ raw: RecordedHID) {
        queue.async { [weak self] in self?.process(raw) }
    }

    // MARK: processing (queue-confined)

    private func process(_ raw: RecordedHID) {
        guard active else { return }
        switch raw.type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            flushBurst()
            dragging = false
            // Capture any PENDING selection BEFORE emitting this click: AX can publish a
            // double-click's selection late, in which case it is first observable at the
            // NEXT mousedown — capturing after emitClick would then record the steps in
            // inverted order ([click Format][select]) and mislead the compiler's
            // drop-the-gesture rule. The selection always predates this click; dedup
            // makes the call a no-op when nothing new is selected.
            captureSelectionIfAny()
            emitClick(executor.hitTest(at: raw.location), raw)
            captureSelectionIfAny() // a double/triple-click that highlighted a word/line
        case .leftMouseDragged, .rightMouseDragged:
            dragging = true
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            if dragging {
                dragging = false
                // A drag that HIGHLIGHTED text is a semantic selection — capture the selected
                // string (replay re-selects it by setting AXSelectedTextRange, no coordinates). A
                // drag that selected nothing (scroll-drag, drag-drop) stays a low-fidelity marker.
                if !captureSelectionIfAny() { emit(["kind": "drag", "app": frontAppName()]) }
            }
        case .scrollWheel:
            let app = frontAppName()
            let now = CFAbsoluteTimeGetCurrent()
            // Coalesce a scroll flurry into one step per app per pause.
            if app != lastScrollApp || now - lastScrollAt > 2.0 {
                flushBurst()
                emit(["kind": "scroll", "app": app])
            }
            lastScrollApp = app
            lastScrollAt = now
        case .keyDown:
            handleKey(raw)
        default:
            break
        }
    }

    private func handleKey(_ raw: RecordedHID) {
        // Command/control chords are discrete actions (⌘S, ⌃⇥) — never burst text.
        if raw.flags.contains(.maskCommand) || raw.flags.contains(.maskControl) {
            flushBurst()
            // A selection made just before a chord (double-click word → ⌘B) has no
            // intervening mouse event to capture it — grab it here so the chord's operand
            // is recorded before the chord itself.
            captureSelectionIfAny()
            emit(["kind": "key", "app": frontAppName(), "value": chordLabel(raw)])
            return
        }
        // Structural keys end the burst and are recorded discretely (Enter submits, Tab
        // moves focus — the NEXT keystroke re-resolves the focused field).
        if let structural = Self.structuralKeys[CGKeyCode(raw.keyCode)] {
            let app = burst?.field?.appName ?? frontAppName()
            flushBurst()
            emit(["kind": "key", "app": app, "value": structural])
            return
        }
        let now = CFAbsoluteTimeGetCurrent()
        // Re-resolve the focused field on EVERY keystroke (review 🔴, corroborated): a
        // burst-start-only decision failed open when focus moved programmatically
        // mid-burst — auto-advancing forms (card number → CVV) shift focus with no
        // click/Tab/idle, so keystrokes kept accumulating under the ORIGINAL field's
        // sensitivity and label.
        let field = executor.focusedFieldInfo()
        // nil = UNCERTAIN, not "secure" (fix-delta review 🟡, corroborated): treating a
        // transiently failed AX read as a secure field fragmented ordinary sentences and
        // minted a phantom secure_input → a bogus handoff on replay. Content still fails
        // CLOSED — this keystroke is dropped — but burst identity and sensitivity only
        // ever change on a RESOLVED field. Residual (accepted): an app whose focus NEVER
        // resolves records no typing at all — an honest gap in the demonstration, never
        // a leak (its clicks/scrolls still record).
        guard let field else {
            if burst != nil { burst!.lastAt = now } // keep the burst alive; the char is dropped
            return
        }
        let secureNow = field.isSecure || Self.isSecretLabel(field.name)
        let idle = burst == nil || now - (burst?.lastAt ?? 0) > Self.burstIdleSeconds
        let moved = burst != nil && !Self.sameField(burst!.field, field)
        let escalated = burst != nil && secureNow && !burst!.isSecure
        if idle || moved || escalated {
            flushBurst() // emit what the PREVIOUS field legitimately received…
            burst = Burst(text: "", isSecure: secureNow, field: field, lastAt: now) // …then re-decide
            scheduleIdleFlush()
        }
        burst?.lastAt = now
        guard var b = burst, !b.isSecure else { return } // secure: content is never accumulated
        if raw.keyCode == 51 { // backspace edits the burst instead of recording a key…
            if !b.text.isEmpty {
                b.text.removeLast()
            } else {
                // …but with nothing buffered it is deleting ALREADY-FLUSHED text — record it
                // discretely so the compiler can see the correction (a swallowed backspace
                // left a deleted "d" in a compiled procedure: the "dTEST" replay bug).
                emit(["kind": "key", "app": field.appName, "value": "delete"])
            }
        } else if !raw.chars.isEmpty {
            // Belt for keys not in structuralKeys: control characters (0x00–0x1F) and the
            // 0xF700 function-key private-use area are KEY PRESSES, never typed content.
            b.text += raw.chars.filter { ch in
                guard let scalar = ch.unicodeScalars.first else { return false }
                return scalar.value >= 0x20 && !(0xF700...0xF8FF).contains(scalar.value)
            }
        }
        burst = b
    }

    /// Field identity for the mid-burst focus-move check. Descriptor equality is the
    /// best AX offers (element refs aren't stable identities across reads). Two ADJACENT
    /// identical-descriptor fields merge bursts — safe, because identical descriptors
    /// necessarily share sensitivity (it derives from subrole+name, both compared here).
    /// That same fact makes `escalated` fire only alongside `moved` today; it stays as a
    /// belt in case this comparison is ever loosened.
    private static func sameField(_ a: AXHitInfo?, _ b: AXHitInfo?) -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        return a.appName == b.appName && a.windowTitle == b.windowTitle && a.role == b.role
            && a.subrole == b.subrole && a.identifier == b.identifier && a.name == b.name
    }

    /// Emit the pending typing burst as one step. Secure bursts become a content-free
    /// `secure_input`; ordinary bursts carry their text (replay needs it).
    private func flushBurst() {
        guard let b = burst else { return }
        burst = nil
        if b.isSecure {
            var step: [String: Any] = ["kind": "secure_input", "app": b.field?.appName ?? frontAppName()]
            fill(&step, from: b.field)
            emit(step)
        } else if !b.text.isEmpty {
            var step: [String: Any] = ["kind": "type", "app": b.field?.appName ?? frontAppName(), "value": b.text]
            fill(&step, from: b.field)
            emit(step)
        }
    }

    private func emitClick(_ hit: AXHitInfo?, _ raw: RecordedHID) {
        var step: [String: Any] = ["kind": "click", "app": hit?.appName ?? frontAppName()]
        step["value"] = raw.type == .rightMouseDown ? "right_click" : (raw.clickState >= 2 ? "double_click" : "click")
        fill(&step, from: hit)
        emit(step)
    }

    /// If a text selection is currently active (a drag/double-click just highlighted a word or
    /// range), record it as a SEMANTIC select_text step — the selected string + which occurrence —
    /// so replay re-selects it by setting AXSelectedTextRange, with no coordinates. Deduped so an
    /// unchanged selection isn't re-emitted. Returns true when it emitted a step.
    @discardableResult
    private func captureSelectionIfAny() -> Bool {
        guard let sel = executor.focusedSelection() else { lastSelection = nil; return false }
        let key = "\(sel.text)#\(sel.occurrence)"
        guard key != lastSelection else { return false }
        lastSelection = key
        var step: [String: Any] = ["kind": "select_text", "app": sel.field.appName, "value": sel.text, "occurrence": sel.occurrence]
        fill(&step, from: sel.field)
        emit(step)
        return true
    }

    /// Common element descriptor fields. Structure only — labels and roles, never a
    /// value read (the recorder records WHAT was touched, not what it contained).
    private func fill(_ step: inout [String: Any], from hit: AXHitInfo?) {
        guard let hit else { return }
        step["role"] = hit.role
        if let s = hit.subrole { step["subrole"] = s }
        if let n = hit.name, !n.isEmpty { step["name"] = n }
        if let i = hit.identifier, !i.isEmpty { step["identifier"] = i }
        if let w = hit.windowTitle, !w.isEmpty { step["window"] = w }
    }

    private func emit(_ step: [String: Any]) {
        onStep?(step)
    }

    private func scheduleIdleFlush() {
        queue.asyncAfter(deadline: .now() + Self.burstIdleSeconds + 0.1) { [weak self] in
            guard let self, self.active, let b = self.burst else { return }
            if CFAbsoluteTimeGetCurrent() - b.lastAt > Self.burstIdleSeconds {
                self.flushBurst()
            } else {
                self.scheduleIdleFlush()
            }
        }
    }

    // MARK: helpers

    private func frontAppName() -> String {
        NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
    }

    private static func isSecretLabel(_ name: String?) -> Bool {
        guard let name, !name.isEmpty else { return false }
        let range = NSRange(name.startIndex..., in: name)
        return secretLabel.firstMatch(in: name, range: range) != nil
    }

    private func chordLabel(_ raw: RecordedHID) -> String {
        var parts: [String] = []
        if raw.flags.contains(.maskCommand) { parts.append("cmd") }
        if raw.flags.contains(.maskControl) { parts.append("ctrl") }
        if raw.flags.contains(.maskAlternate) { parts.append("opt") }
        if raw.flags.contains(.maskShift) { parts.append("shift") }
        let key = Self.keyNames[CGKeyCode(raw.keyCode)] ?? raw.chars.lowercased()
        parts.append(key.isEmpty ? "key\(raw.keyCode)" : key)
        return parts.joined(separator: "+")
    }

    // Arrows are structural too: keyboardGetUnicodeString renders them as ASCII control
    // characters (0x1C–0x1F), which a typing burst would swallow as literal text — a
    // recorded demo then compiled "type \u{1C}\u{1C}…" and the replay typed garbage into
    // the note. As discrete key steps they replay through pressKey and the compiler can
    // fold them as navigation.
    private static let structuralKeys: [CGKeyCode: String] = [
        36: "return", 48: "tab", 53: "escape",
        123: "left", 124: "right", 125: "down", 126: "up",
    ]

    /// Reverse of SyntheticInput.keyCodes (aliases collapse alphabetically — "enter"
    /// over "return" etc.; every alias replays identically through pressKey).
    private static let keyNames: [CGKeyCode: String] = {
        var out: [CGKeyCode: String] = [:]
        for name in SyntheticInput.keyCodes.keys.sorted() {
            let code = SyntheticInput.keyCodes[name]!
            if out[code] == nil { out[code] = name }
        }
        return out
    }()
}
