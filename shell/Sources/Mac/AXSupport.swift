import AppKit
import ApplicationServices

/// A compacted interactive node — one line per element in the snapshot the model sees.
/// `element` is the live AX handle held shell-side (never crosses the wire); everything
/// else is the flat descriptor. `ref` is assigned when the node joins a snapshot generation.
struct AXNode {
    let element: AXUIElement
    let role: String
    let subrole: String?
    let name: String
    let value: String?
    let enabled: Bool
    let frame: CGRect?
    let identifier: String?
    var ref: String = ""

    /// Interactive-role filter, applied during traversal (SPEC §M6: actionable elements
    /// only — the full tree is never materialized then filtered). Static text is included
    /// too: the loop verifies STATES ("am I on the compose window?"), which needs visible
    /// labels, not just clickables.
    static func isInteractive(role: String, subrole: String?) -> Bool {
        switch role {
        case kAXButtonRole, kAXMenuButtonRole, kAXPopUpButtonRole, kAXMenuItemRole,
             kAXMenuBarItemRole, kAXCheckBoxRole, kAXRadioButtonRole, kAXTextFieldRole,
             kAXTextAreaRole, kAXComboBoxRole, kAXSliderRole, kAXIncrementorRole,
             kAXDisclosureTriangleRole, kAXTabGroupRole, kAXStaticTextRole,
             kAXCellRole, kAXRowRole:
            return true
        default:
            // These roles have no exported kAX*Role constant on this SDK — match strings.
            return role == "AXLink" || role == "AXSegmentedControl"
        }
    }

    /// Content images (a generated picture, a large thumbnail) are included in the snapshot so
    /// the loop can LOCATE them: an image isn't pressable by ref, so its line renders a precise
    /// center point (see `line()`) for a click_point/double-click. Small chrome icons (< 64pt on
    /// either side — send-button glyphs, avatars) stay filtered so the snapshot doesn't bloat.
    static func isContentImage(role: String, frame: CGRect?) -> Bool {
        guard role == kAXImageRole, let f = frame else { return false }
        return min(f.width, f.height) >= 64
    }

    /// Secure fields never expose their value in a snapshot line — the executor also hard-
    /// refuses acting on them, but redact here so a password never even reaches the model.
    private var safeValue: String? {
        subrole == "AXSecureTextField" ? "<secure>" : value
    }

    /// The snapshot line the model reads: ref, role, quoted name, value, #identifier, and
    /// a disabled marker. Compact and stable enough for the model to reference by ref.
    func line() -> String {
        var parts = ["[\(ref)]", shortRole]
        if !name.isEmpty { parts.append("\"\(clip(name))\"") }
        if let v = safeValue, !v.isEmpty { parts.append("value=\"\(clip(v))\"") }
        if let id = identifier, !id.isEmpty { parts.append("#\(id)") }
        // Images can't be pressed by ref — render their center so the loop can double-click the
        // exact point (precise AX geometry, not a vision guess).
        if role == kAXImageRole, let f = frame { parts.append("@(\(Int(f.midX)),\(Int(f.midY)))") }
        if !enabled { parts.append("(disabled)") }
        return parts.joined(separator: " ")
    }

    /// Ref-free descriptor for the act diff — comparing on identity+value, not on the ref
    /// (which changes every generation) so the diff reflects real UI change, not renumbering.
    func diffLine() -> String {
        var parts = [shortRole]
        if !name.isEmpty { parts.append("\"\(clip(name))\"") }
        if let v = safeValue, !v.isEmpty { parts.append("value=\"\(clip(v))\"") }
        if !enabled { parts.append("(disabled)") }
        return parts.joined(separator: " ")
    }

    private var shortRole: String {
        role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
    }

    private func clip(_ s: String, _ max: Int = 80) -> String {
        s.count <= max ? s : String(s.prefix(max)) + "…"
    }
}

extension AXUIElement {
    static let systemWide = AXUIElementCreateSystemWide()

    static func application(_ pid: pid_t) -> AXUIElement {
        AXUIElementCreateApplication(pid)
    }

    /// One hung app otherwise stalls the whole loop — cap every message to this element.
    func setMessagingTimeout(_ seconds: Float) {
        AXUIElementSetMessagingTimeout(self, seconds)
    }
}
