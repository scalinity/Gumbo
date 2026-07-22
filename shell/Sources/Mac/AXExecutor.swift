import AppKit
import ApplicationServices

/// M6 result of one executed step — mirrors the daemon's MacActionResult wire shape.
/// `output` is what the model reads; `errorKind`/`health` are the branchable metadata.
struct AXResult {
    var ok: Bool
    var output: String
    var errorKind: String?
    var health: String?
    /// act only: the settled before/after diff was empty. Structured so the daemon's stall
    /// detector never has to grep human-readable output (screen text could spoof it).
    var noChange: Bool = false

    func wire() -> [String: Any] {
        var dict: [String: Any] = ["ok": ok, "output": output]
        if let errorKind { dict["error_kind"] = errorKind }
        if let health { dict["health"] = health }
        if noChange { dict["no_change"] = true }
        return dict
    }

    static func failure(_ kind: String, _ output: String) -> AXResult {
        AXResult(ok: false, output: output, errorKind: kind, health: nil)
    }
}

/// M8: what the watch-me recorder captures about an element the user touched — structure
/// only (labels/roles/identifiers), never a value read, never coordinates. isSecure
/// (AXSecureTextField) is decided HERE, next to the other AX reads, so the recorder's
/// sensitivity gate uses the same truth as the executor's act-time hard refuse.
struct AXHitInfo {
    let appName: String
    let windowTitle: String?
    let role: String
    let subrole: String?
    let name: String?
    let identifier: String?
    let isSecure: Bool
}

/// The AX engine: owns the ref→element map (one generation per snapshot — live refs are
/// never cached across snapshots), reads compacted trees, drives the dispatch ladder, and
/// returns before/after diffs. All AX traffic runs on a private serial queue off the shell
/// main thread (dense-app traversal would jank the notch); AXUIElementSetMessagingTimeout
/// keeps one hung app from stalling the whole loop.
///
/// SPEC §M6: the FULL tree never enters LLM context. The shell holds it here; the daemon
/// gets a flat, compacted sample + a query RPC for more.
final class AXExecutor {
    private let queue = DispatchQueue(label: "ai.scalinity.gumbo.ax")

    /// Current snapshot generation: ref string → live element. Rebuilt every snapshot;
    /// a ref from a prior generation is a typed `stale_ref`, never a nearest-match guess.
    private var refs: [String: AXUIElement] = [:]
    private var generation = 0
    /// The full compacted node list of the current snapshot — what `query` greps. Held
    /// shell-side so a Slack-scale (~8k element) tree never crosses the wire into context.
    private var lastNodes: [AXNode] = []
    private var lastApp: (pid: pid_t, name: String)?

    /// Per-element AX messaging timeout (seconds). One hung Qt/Electron app otherwise
    /// stalls the loop indefinitely — the research pass flagged this as mandatory.
    private let messagingTimeout: Float = 2.0

    // MARK: entry point — runs one wire action, returns the wire result

    func perform(_ action: [String: Any]) -> [String: Any] {
        queue.sync {
            AXUIElement.systemWide.setMessagingTimeout(messagingTimeout)
            let kind = action["kind"] as? String ?? ""
            switch kind {
            case "health": return probeHealth().wire()
            case "snapshot":
                return snapshot(
                    app: action["app"] as? String,
                    maxElements: action["max_elements"] as? Int ?? 400
                ).wire()
            case "query":
                return query(
                    action["query"] as? String ?? "",
                    maxResults: action["max_results"] as? Int ?? 40
                ).wire()
            case "act": return act(action).wire()
            case "resolve":
                return resolve(
                    role: action["role"] as? String,
                    name: action["name"] as? String,
                    identifier: action["identifier"] as? String
                ).wire()
            case "document_state":
                return documentState(
                    app: action["app"] as? String,
                    identifier: action["identifier"] as? String,
                    role: action["role"] as? String
                ).wire()
            default: return AXResult.failure("out_of_scope", "Unknown action kind \"\(kind)\".").wire()
            }
        }
    }

    // MARK: permission health — a state machine, not a boolean

    /// AXIsProcessTrusted() has a documented stale-cache failure (returns true while every
    /// real call fails; persists on Tahoe). Probe LIVE: a listen-only event tap (tests
    /// kTCCServicePostEvent) plus a functional walk of Finder's tree (a guaranteed AX tree —
    /// tests kTCCServiceAccessibility). Two separate TCC services both shown under
    /// "Accessibility"; either being dead is a real, distinct failure.
    func probeHealth() -> AXResult {
        if !AXIsProcessTrusted() {
            return AXResult(ok: false, output: "Accessibility is not granted to Gumbo.", errorKind: "ax_unavailable", health: "not_granted")
        }
        // Functional AX walk against Finder — if this returns children, AX truly works.
        let axWorks = finderTreeReachable()
        // Listen-only tap — if this can't be created, CGEvent posting (rung 2/3) is dead.
        let postWorks = listenTapCreatable()
        if axWorks && postWorks {
            return AXResult(ok: true, output: "Accessibility healthy (AX walk + event tap both live).", errorKind: nil, health: "healthy")
        }
        if !axWorks {
            // Trusted flag true but Finder's tree is unreachable → the stale-cache state.
            return AXResult(ok: false, output: "Accessibility reports granted but AX calls fail (stale TCC cache) — relaunch Gumbo.", errorKind: "ax_unavailable", health: "stale_cache")
        }
        return AXResult(ok: false, output: "AX reads work but synthetic event posting is denied (Accessibility → PostEvent).", errorKind: "ax_unavailable", health: "ax_disabled")
    }

    private func finderTreeReachable() -> Bool {
        guard let finder = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first else {
            return true // Finder not running is not an AX failure — don't false-negative health
        }
        let app = AXUIElement.application(finder.processIdentifier)
        app.setMessagingTimeout(messagingTimeout)
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(app, kAXChildrenAttribute as CFString, &value)
        return err == .success
    }

    private func listenTapCreatable() -> Bool {
        // A listen-only tap needs the PostEvent grant; create then immediately invalidate.
        let mask = CGEventMask(1 << CGEventType.mouseMoved.rawValue)
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap,
            options: .listenOnly, eventsOfInterest: mask,
            callback: { _, _, event, _ in Unmanaged.passUnretained(event) }, userInfo: nil
        ) else { return false }
        CFMachPortInvalidate(tap)
        return true
    }

    // MARK: snapshot — compacted flat tree

    private func snapshot(app requestedApp: String?, maxElements: Int) -> AXResult {
        guard let target = resolveApp(requestedApp) else {
            return AXResult.failure("element_not_found", requestedApp.map { "No running app matches \"\($0)\"." } ?? "No frontmost application.")
        }
        let appElement = AXUIElement.application(target.pid)
        appElement.setMessagingTimeout(messagingTimeout)
        // Electron/Chrome onboarding: enabling this makes their renderer AX tree appear.
        // Tolerate the unsupported error (older Electron returns it while working anyway).
        AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)

        // Scope to the focused/main window when there is one — a whole-app walk is both
        // slower and noisier than the window the user is looking at.
        let root = focusedWindow(of: appElement) ?? appElement
        var nodes: [AXNode] = []
        var truncated = false
        walk(root, pid: target.pid, depth: 0, into: &nodes, cap: maxElements, truncated: &truncated)
        // Open menus (a popover's color menu, a context menu) attach to the APP element,
        // not the window — walk them too or their items can never be resolved/pressed.
        if root !== appElement {
            for child in axChildren(appElement) where stringAttr(child, kAXRoleAttribute) == "AXMenu" {
                walk(child, pid: target.pid, depth: 0, into: &nodes, cap: maxElements, truncated: &truncated)
            }
        }

        // New generation: mint fresh refs, drop the old map (old refs now stale by design).
        // The generation is ENCODED in the ref ("g3e12"), so a ref from a prior snapshot can
        // never collide with a same-index element in this one — it fails the map lookup and
        // returns stale_ref instead of silently rebinding to a different element.
        generation += 1
        refs = [:]
        for (i, _) in nodes.enumerated() {
            let ref = "g\(generation)e\(i)"
            nodes[i].ref = ref
            refs[ref] = nodes[i].element
        }
        lastNodes = nodes
        lastApp = target
        var output = render(nodes, app: target, truncated: truncated)
        // Formatting is INVISIBLE in element text — a checkpoint judging "the selected text
        // is blue" against a plain snapshot always fails and drops a CORRECT replay into
        // the fallback (which then "fixes" it). Append the focused selection's style
        // (AXAttributedStringForRange → AXStyleName) so observations can see formatting.
        // Read the TARGET APP's focused element, never the system-wide one — a snapshot
        // of app X must not leak whatever text happens to be selected in app Y.
        var focusedRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
           let fRaw = focusedRef, CFGetTypeID(fRaw) == AXUIElementGetTypeID() {
            let fEl = fRaw as! AXUIElement
            if !isSecureField(fEl), let sel = selectedRange(fEl), sel.length > 0 {
                let text = truncate(stringAttr(fEl, kAXSelectedTextAttribute) ?? "", 40)
                let style = selectionStyle(fEl)
                output += "\n(selected right now: \"\(text)\"\(style.map { " — style: \($0)" } ?? ""))"
            }
        }
        return AXResult(ok: true, output: output, errorKind: nil, health: nil)
    }

    /// BFS-ish DFS with a depth cap and an interactive-role filter applied DURING traversal
    /// (never materialize the whole tree, then filter). Batched attribute reads keep dense
    /// apps affordable. Element-valued attrs (children) don't batch — read separately.
    private func walk(_ element: AXUIElement, pid: pid_t, depth: Int, into nodes: inout [AXNode], cap: Int, truncated: inout Bool) {
        if nodes.count >= cap { truncated = true; return }
        if depth > 40 { return } // hard depth guard — pathological trees

        let attrs = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXValueAttribute,
                     kAXDescriptionAttribute, kAXEnabledAttribute, kAXPositionAttribute, kAXSizeAttribute,
                     kAXIdentifierAttribute] as CFArray
        var values: CFArray?
        let err = AXUIElementCopyMultipleAttributeValues(element, attrs, [], &values)
        guard err == .success, let raw = values as? [CFTypeRef] else { return }

        let role = string(raw, 0) ?? ""
        let subrole = string(raw, 1)
        let title = string(raw, 2)
        let value = string(raw, 3)
        let desc = string(raw, 4)
        let enabled = (raw[5] as? Bool) ?? true
        let frame = frameFrom(raw, posIndex: 6, sizeIndex: 7)
        let identifier = string(raw, 8)

        if AXNode.isInteractive(role: role, subrole: subrole) || AXNode.isContentImage(role: role, frame: frame) {
            nodes.append(AXNode(
                element: element, role: role, subrole: subrole,
                name: title ?? desc ?? "", value: value, enabled: enabled,
                frame: frame, identifier: identifier))
        }

        // Recurse into children (element-valued — read on its own, doesn't batch).
        var childrenRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
           let children = childrenRef as? [AXUIElement] {
            for child in children {
                if nodes.count >= cap { truncated = true; return }
                walk(child, pid: pid, depth: depth + 1, into: &nodes, cap: cap, truncated: &truncated)
            }
        }
    }

    // MARK: query — grep the shell-held full tree without re-crossing the wire

    private func query(_ needle: String, maxResults: Int) -> AXResult {
        guard !lastNodes.isEmpty else {
            return AXResult.failure("stale_ref", "No snapshot to query — take a snapshot first.")
        }
        let lc = needle.lowercased()
        let hits = lastNodes.filter {
            $0.name.lowercased().contains(lc) || ($0.value?.lowercased().contains(lc) ?? false)
                || $0.role.lowercased().contains(lc) || ($0.identifier?.lowercased().contains(lc) ?? false)
        }.prefix(maxResults)
        if hits.isEmpty { return AXResult(ok: true, output: "No elements match \"\(needle)\".", errorKind: nil, health: nil) }
        return AXResult(ok: true, output: hits.map { $0.line() }.joined(separator: "\n"), errorKind: nil, health: nil)
    }

    // MARK: act — dispatch ladder + settle + before/after diff

    /// Keyboard-built selections are linear in length (one shift+right per character on
    /// the serial AX queue, ~20 ms each) — beyond this bound the queue-hold outweighs the
    /// event-real benefit and the pure AX range write takes over.
    private let keyboardSelectionMaxChars = 120
    /// documentState walks a whole window tree at teach-stop — capped so a browser-sized
    /// tree cannot hold the serial queue past the daemon's RPC budget.
    private let documentScanNodeCap = 2500

    /// Set by a successful select_text, cleared by every other act (and key): the ONE case
    /// where an active selection is the intended operand of the next type (select-then-type
    /// = replace). Anything else typing over a leftover selection would silently destroy it
    /// (the deleted-entry replay bug) — performType collapses the selection first instead.
    private var lastSelectedElement: AXUIElement?

    private func act(_ action: [String: Any]) -> AXResult {
        let verb = action["verb"] as? String ?? ""
        let timeoutMs = action["timeout_ms"] as? Int ?? 5000

        // wait_for matches on role+name against fresh reads, not a ref — it exists for slow
        // transitions where the target didn't exist at snapshot time.
        if verb == "wait_for" {
            lastSelectedElement = nil // an intervening act (even an observing wait) ends the select-then-type replace intent
            return waitFor(role: action["role"] as? String, name: action["name"] as? String, timeoutMs: timeoutMs)
        }

        // key is a keyboard shortcut to the focused app — it has no element target (the tool
        // contract says ref is null for key), so it must be handled BEFORE the ref guard.
        if verb == "key" {
            lastSelectedElement = nil // a real key interacts with the selection natively
            return performKey(action["value"] as? String ?? "", timeoutMs: timeoutMs)
        }
        // menu_path drives the app's own menus by title — ref = an element (its CONTEXT menu,
        // via AXShowMenu), ref null = the app's MENU BAR. Handled before the ref guard because
        // the menu-bar form is targetless, and it returns directly because a formatting
        // change (highlight, color, bold) does not alter the element's text value — the diff
        // would misread success as "no observable change" (the select_text lesson).
        if verb == "menu_path" {
            lastSelectedElement = nil // the menu action consumes the selection context; a later type must not replace the leftover selection
            var target: AXUIElement?
            if let ref = action["ref"] as? String, !ref.isEmpty {
                guard let el = refs[ref] else {
                    return AXResult.failure("stale_ref", "Ref \(ref) is from a previous snapshot — re-snapshot and retry.")
                }
                if isSecureField(el) {
                    return AXResult.failure("secure_field", "That is a secure (password) field — Gumbo will not act on it. Ask the user.")
                }
                target = el
            }
            return performMenuPath(target, path: action["value"] as? String ?? "")
        }

        guard let ref = action["ref"] as? String else {
            return AXResult.failure("element_not_found", "\(verb) needs a ref.")
        }
        guard let element = refs[ref] else {
            return AXResult.failure("stale_ref", "Ref \(ref) is from a previous snapshot — re-snapshot and retry.")
        }
        // Secure fields: the executor hard-refuses read/type — policy lives here, never in
        // the model's prompt, so no instruction can talk it into leaking a password field.
        if isSecureField(element) {
            return AXResult.failure("secure_field", "That is a secure (password) field — Gumbo will not read or type into it. Ask the user to enter it.")
        }
        let pid = pidOf(element)
        let before = describe(element)
        // One ancestor walk, shared by the in-menu success report and performPress's
        // escalation decision. Read BEFORE acting: a chosen menu item vanishes with its menu.
        let inOpenMenu = (verb == "press" || verb == "show_menu") && insideOpenMenu(element)
        let inMenuName = (verb == "press" && inOpenMenu)
            ? (stringAttr(element, kAXTitleAttribute) ?? stringAttr(element, kAXDescriptionAttribute) ?? "the item")
            : nil

        let selectFlowElement = lastSelectedElement
        lastSelectedElement = nil

        var actErr: String?
        switch verb {
        case "press": actErr = performPress(element, pid: pid, inOpenMenu: inOpenMenu)
        case "focus": actErr = performFocus(element)
        case "set_value": actErr = performSetValue(element, value: action["value"] as? String ?? "")
        case "type":
            let replacing = selectFlowElement.map { CFEqual($0, element) } ?? false
            actErr = performType(element, text: action["value"] as? String ?? "", pid: pid, replacingSelection: replacing)
        case "show_menu": actErr = performShowMenu(element, pid: pid)
        case "select_text":
            actErr = performSelectText(element, text: action["value"] as? String ?? "", occurrence: action["occurrence"] as? Int ?? 0)
            if actErr == nil { lastSelectedElement = element }
        case "replace_text":
            return performReplaceText(element, replacement: action["value"] as? String ?? "")
        default: return AXResult.failure("out_of_scope", "Unknown verb \"\(verb)\".")
        }
        if let actErr {
            return AXResult.failure("ax_unavailable", "\(verb) failed: \(actErr)")
        }

        // select_text's effect is the SELECTION, which describe()/diff can't see — report it
        // directly (performSelectText already verified it via AXSelectedText) so an empty element
        // diff never reads as "no observable change" and misleads the loop into re-selecting.
        if verb == "select_text" {
            return AXResult(ok: true, output: "Selected \"\(truncate(action["value"] as? String ?? ""))\".", errorKind: nil, health: nil, noChange: false)
        }
        // A chosen menu item's success signal is the MENU CLOSING — the pressed element is
        // gone, so the element diff would read "(no observable change)" and the loop would
        // retry into a vanished menu (the Orange-swatch drift). Report the choice directly.
        if let inMenuName {
            return AXResult(ok: true, output: "Chose \"\(truncate(inMenuName))\" — the menu closed. Verify the EFFECT on the content (fresh snapshot / selection style), not the menu.", errorKind: nil, health: nil, noChange: false)
        }

        settle(element: element, timeoutMs: timeoutMs)
        let after = describe(element)
        // Verify by DIFF, never return code — AXPress false-passes on backgrounded/disabled
        // items. An empty diff is a real "no observable change" signal the model can act on.
        let diff = diffLines(before: before, after: after)
        let body = diff.isEmpty ? "(no observable change — the action may not have taken effect)" : diff
        return AXResult(ok: true, output: body, errorKind: nil, health: nil, noChange: diff.isEmpty)
    }

    /// key targets no element (a shortcut to the focused app). Diff the focused window
    /// before/after so the model still verifies by diff rather than assuming success.
    private func performKey(_ chord: String, timeoutMs: Int) -> AXResult {
        let appElement = lastApp.map { AXUIElement.application($0.pid) } ?? AXUIElement.systemWide
        let pid = lastApp?.pid ?? resolveApp(nil)?.pid
        let win = focusedWindow(of: appElement)
        let before = describe(nil)
        guard SyntheticInput.pressKey(chord, pid: pid) else {
            return AXResult.failure("out_of_scope", "Unknown key chord \"\(chord)\".")
        }
        settle(element: win ?? appElement, timeoutMs: timeoutMs)
        let after = describe(nil)
        let diff = diffLines(before: before, after: after)
        let body = diff.isEmpty ? "(sent \(chord); no observable change — snapshot to confirm)" : diff
        return AXResult(ok: true, output: body, errorKind: nil, health: nil, noChange: diff.isEmpty)
    }

    private func waitFor(role: String?, name: String?, timeoutMs: Int) -> AXResult {
        guard let app = lastApp else {
            return AXResult.failure("stale_ref", "No snapshot context to wait within — snapshot first.")
        }
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        let appElement = AXUIElement.application(app.pid)
        let wantName = name?.lowercased()
        repeat {
            var nodes: [AXNode] = []
            var truncated = false
            let root = focusedWindow(of: appElement) ?? appElement
            walk(root, pid: app.pid, depth: 0, into: &nodes, cap: 400, truncated: &truncated)
            if let match = nodes.first(where: {
                (role == nil || $0.role.caseInsensitiveCompare(role!) == .orderedSame)
                    && (wantName == nil || $0.name.lowercased().contains(wantName!))
            }) {
                return AXResult(ok: true, output: "Appeared: \(match.line())", errorKind: nil, health: nil)
            }
            Thread.sleep(forTimeInterval: 0.15)
        } while Date() < deadline
        // A bare "timeout" leaves the model blind — it guessed a role/name that never came
        // (live demo: 4 dead 30 s waits on slightly-wrong roles). Return what IS on screen so
        // it can re-target immediately. diffLine() (no refs — these nodes aren't registered;
        // a fresh ax_snapshot is required before acting on any of them).
        var current: [AXNode] = []
        var truncated = false
        walk(focusedWindow(of: appElement) ?? appElement, pid: app.pid, depth: 0, into: &current, cap: 40, truncated: &truncated)
        let context = current.isEmpty
            ? "The window shows no interactive elements."
            : "The window currently shows (take ax_snapshot for actionable refs):\n" + current.map { $0.diffLine() }.joined(separator: "\n")
        return AXResult.failure("timeout", "Waited \(timeoutMs) ms; no element matched role=\(role ?? "*") name=\(name ?? "*"). \(context)")
    }

    // MARK: dispatch ladder rungs

    /// Rung 1: AXPress (background-safe, works on occluded elements, never moves the
    /// pointer). Falls to rung 2 (pid-targeted synthetic click at the element's frame) when
    /// AXPress isn't supported/effective. The ghost cursor animates to the frame regardless.
    ///
    /// EXCEPTION — controls that only real input can operate (measured on Notes' Format
    /// popover, 2026-07-21): SwiftUI popover controls permanently report AXEnabled=false
    /// (a LIE — they track the live selection while claiming disabled) and AXPress on them
    /// false-passes or errors; items inside an OPEN tracking menu (a popover's color menu,
    /// a context menu) ignore AXPress/AXPick entirely. Both classes only respond to a
    /// GLOBAL HID click at their live frame — the same event path as click_point, tagged
    /// synthetic so the kill-switch ignores it, sanctioned during tasks by the same
    /// bracket. The frame is read fresh from the AX tree at act time, never recorded.
    private func performPress(_ element: AXUIElement, pid: pid_t, inOpenMenu: Bool = false) -> String? {
        let phantomDisabled = boolAttr(element, kAXEnabledAttribute) == false
        if phantomDisabled || inOpenMenu {
            guard let center = frameCenter(element) else {
                return "the control needs a real click but exposes no frame"
            }
            // Occlusion gate: a global click lands on whatever is TOPMOST at the point —
            // a notification banner or another app's window over the target would receive
            // it. Fire only when the hit-test at the point resolves back into the SAME
            // app; a hit-test ERROR is not proof of occlusion, so it does not block.
            var hitRef: AXUIElement?
            let hitErr = AXUIElementCopyElementAtPosition(AXUIElement.systemWide, Float(center.x), Float(center.y), &hitRef)
            if hitErr == .success, let hit = hitRef, pidOf(hit) != pid {
                return "the control is covered by another surface at its position — refusing to click blind (bring the app frontmost, or dismiss whatever is over it)"
            }
            SyntheticInput.click(at: center, pid: nil) // nil pid = global HID — the only path these controls hear
            return nil
        }
        let err = AXUIElementPerformAction(element, kAXPressAction as CFString)
        if err == .success { return nil }
        // Rung 2: pid-targeted synthetic click at the element center.
        if let center = frameCenter(element) {
            SyntheticInput.click(at: center, pid: pid)
            return nil
        }
        return "AXPress error \(err.rawValue) and no frame to click"
    }

    /// True when the element sits inside an open AXMenu (tracking menus swallow AX
    /// actions; only real clicks land). Menu-BAR items are excluded — their ancestor is
    /// AXMenuBar and AXPress fires their action reliably.
    private func insideOpenMenu(_ element: AXUIElement) -> Bool {
        var node: AXUIElement? = parentOf(element)
        var hops = 0
        while let n = node, hops < 20 {
            let role = stringAttr(n, kAXRoleAttribute)
            if role == "AXMenu" { return true }
            if role == "AXMenuBar" || role == "AXWindow" { return false }
            node = parentOf(n)
            hops += 1
        }
        return false
    }

    private func performFocus(_ element: AXUIElement) -> String? {
        let err = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        return err == .success ? nil : "AXFocused set error \(err.rawValue)"
    }

    /// Surgical text replacement: writes the CURRENT selection's text directly via
    /// AXSelectedText — zero keystrokes, so auto-capitalize/auto-format cannot alter it
    /// (typing "test" over a selection can land as "Test"; this cannot).
    private func performReplaceText(_ element: AXUIElement, replacement: String) -> AXResult {
        guard let sel = selectedRange(element), sel.length > 0 else {
            return AXResult.failure("element_not_found", "replace_text needs an active selection — select_text the target first.")
        }
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable)
        guard settable.boolValue else {
            return AXResult.failure("ax_unavailable", "this field does not support direct text replacement.")
        }
        let err = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, replacement as CFString)
        guard err == .success else {
            return AXResult.failure("ax_unavailable", "replace_text failed (AX error \(err.rawValue)).")
        }
        return AXResult(ok: true, output: "Replaced the selection with \"\(truncate(replacement))\".", errorKind: nil, health: nil, noChange: false)
    }

    /// Try the direct AXValue write first (fast, fires no key events); check settable first.
    private func performSetValue(_ element: AXUIElement, value: String) -> String? {
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        guard settable.boolValue else { return "AXValue is not settable — use the type verb instead" }
        let err = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
        return err == .success ? nil : "AXValue set error \(err.rawValue)"
    }

    /// Select a text range SEMANTICALLY, no coordinates: find the `occurrence`-th match of `text`
    /// in the element's value and set kAXSelectedTextRange to it — reproducing a drag/double-click
    /// highlight so a following format action (color, bold) applies to it. AX offsets are UTF-16.
    /// Verifies via AXSelectedText and returns an error (→ replay drifts, never colors the wrong
    /// text) when the app ignores the write or the text isn't present.
    private func performSelectText(_ element: AXUIElement, text: String, occurrence: Int) -> String? {
        guard !text.isEmpty else { return "select_text: empty target" }
        guard let full = stringAttr(element, kAXValueAttribute) else { return "select_text: the field exposes no text value" }
        let ns = full as NSString
        var from = 0, idx = 0
        var match = NSRange(location: NSNotFound, length: 0)
        while from <= ns.length {
            let r = ns.range(of: text, options: [], range: NSRange(location: from, length: ns.length - from))
            if r.location == NSNotFound { break }
            if idx == occurrence { match = r; break }
            idx += 1
            from = r.location + max(1, r.length)
        }
        if match.location == NSNotFound { match = ns.range(of: text) } // occurrence drifted → first match
        if match.location == NSNotFound { return "select_text: \"\(truncate(text))\" not found in the field" }

        // Verification is by RANGE, not by AXSelectedText: the range read is
        // focus-independent, while AXSelectedText reads EMPTY on an unfocused field even
        // when the range took (a live replay failed exactly there — a popover held key
        // focus and a correct selection "did not take"). Ladder:
        //   1. focus + caret + real shift+right keystrokes (event-driven UI hears it)
        //   2. pure AX range write (works without focus)
        //   3. Escape to dismiss whatever transient UI is eating focus/keys, then 2 again
        let want = NSRange(location: match.location, length: match.length)
        let tookRange = { [weak self] in self?.selectedRange(element) == want }
        let pid = pidOf(element)
        _ = performFocus(element)
        let charCount = ns.substring(with: match).count
        if charCount <= keyboardSelectionMaxChars {
            var caret = CFRange(location: match.location, length: 0)
            if let axCaret = AXValueCreate(.cfRange, &caret),
               AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axCaret) == .success {
                for _ in 0..<charCount {
                    guard SyntheticInput.pressKey("shift+right", pid: pid) else { break }
                    usleep(20_000)
                }
                usleep(150_000)
                if tookRange() { return nil }
            }
        }
        var range = CFRange(location: match.location, length: match.length)
        guard let axRange = AXValueCreate(.cfRange, &range) else { return "select_text: could not build range" }
        AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange)
        if tookRange() { return nil }
        // Rung 3: a popover/menu may be holding focus and swallowing the write — dismiss
        // it and retry once. Escape is safe in a text field (dismisses transient UI only).
        _ = SyntheticInput.pressKey("escape", pid: pid)
        usleep(250_000)
        _ = performFocus(element)
        AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange)
        if tookRange() { return nil }
        return "select_text: the selection did not take (this field may not support programmatic selection)"
    }

    /// Focus, then enter text — per character for a NATIVE field, by clipboard paste for a
    /// web/Electron one. The split matters: a native app's interactive auto-formatting only
    /// fires on real per-character keys (Notes turns a typed "- " into a bullet list and demotes
    /// the title style on the next line), whereas a bulk paste bypasses all of it — leaving a
    /// literal dash and the previous line's inherited style (the packing-list replay bug). But a
    /// web/Electron field (inside an AXWebArea) drops pid-targeted per-character keys into its
    /// renderer subprocess, so THOSE still need a paste through the app's Edit▸Paste path. Empty
    /// text is a no-op.
    private func performType(_ element: AXUIElement, text: String, pid: pid_t, replacingSelection: Bool = false) -> String? {
        _ = performFocus(element)
        guard !text.isEmpty else { return nil }
        // A live selection is silently REPLACED by the first keystroke (and by paste). That
        // is only ever intended straight after select_text (select-then-type = replace);
        // any OTHER leftover selection — e.g. one a formatting step made and never consumed
        // — gets collapsed to its end first, so typing inserts instead of destroying it.
        if !replacingSelection, let sel = selectedRange(element), sel.length > 0 {
            var caret = CFRange(location: sel.location + sel.length, length: 0)
            if let axCaret = AXValueCreate(.cfRange, &caret) {
                AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axCaret)
            }
        }
        if isWebHosted(element) {
            SyntheticInput.paste(text, pid: pid)
        } else {
            SyntheticInput.type(text, pid: pid)
        }
        return nil
    }

    /// True when the element sits inside a web view — a Chromium/Electron/WebKit field whose
    /// renderer subprocess drops pid-targeted synthetic keys (so it needs paste, not per-char).
    /// Walks up to an AXWebArea ancestor; the hop cap guards a pathological/cyclic tree.
    private func isWebHosted(_ element: AXUIElement) -> Bool {
        var node: AXUIElement? = element
        var hops = 0
        while let n = node, hops < 60 {
            if stringAttr(n, kAXRoleAttribute) == "AXWebArea" { return true }
            node = parentOf(n)
            hops += 1
        }
        return false
    }

    /// Right-click on Chromium is coerced to left, so use AXShowMenu where available;
    /// fall back to a pid-targeted right-click.
    private func performShowMenu(_ element: AXUIElement, pid: pid_t) -> String? {
        let err = AXUIElementPerformAction(element, "AXShowMenu" as CFString)
        if err == .success { return nil }
        if let center = frameCenter(element) {
            SyntheticInput.click(at: center, pid: pid, button: .right)
            return nil
        }
        return "AXShowMenu error \(err.rawValue) and no frame"
    }

    /// Drive a menu by TITLES — an element's CONTEXT menu (AXShowMenu first) or the app's
    /// MENU BAR (element nil). Menus are the most AX-reliable surface on macOS: items are
    /// plain NSMenu AXMenuItems whose enabled state validates LIVE against the responder
    /// chain, unlike popover/toolbar controls, which capture theirs at open and go stale
    /// under AX driving (Notes' Format popover: disabled with ANY ordering — the M8
    /// highlight-color bug; its CONTEXT menu carries Font ▸ Highlight ▸ <color>, enabled).
    /// Submenu contents are readable in the AX tree without visually opening them, and
    /// pressing the LEAF is the whole gesture. `path` is " > "-separated, matched
    /// case-insensitively (exact first, then containment; trailing "…" ignored).
    private func performMenuPath(_ element: AXUIElement?, path: String) -> AXResult {
        let parts = path.split(separator: ">").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !parts.isEmpty else {
            return AXResult.failure("out_of_scope", "menu_path needs a \" > \"-separated path, e.g. \"Font > Highlight > Pink\".")
        }
        let pid = element.map { pidOf($0) } ?? (lastApp?.pid ?? resolveApp(nil)?.pid ?? 0)
        guard pid != 0 else {
            return AXResult.failure("element_not_found", "no app context for the menu bar — take ax_snapshot first.")
        }
        let appEl = AXUIElement.application(pid)
        let isContext = element != nil
        // For a failed CONTEXT walk, the popped-up menu must not be left dangling.
        func bail(_ kind: String, _ message: String) -> AXResult {
            if isContext { _ = SyntheticInput.pressKey("escape", pid: pid) }
            return AXResult.failure(kind, message)
        }

        var current: AXUIElement
        if let element {
            let err = AXUIElementPerformAction(element, "AXShowMenu" as CFString)
            guard err == .success else {
                return AXResult.failure("ax_unavailable", "could not open the context menu (AXShowMenu error \(err.rawValue)).")
            }
            Thread.sleep(forTimeInterval: 0.5)
            guard let menu = findMenu(near: element, app: appEl) else {
                return bail("element_not_found", "the context menu did not appear.")
            }
            current = menu
        } else {
            var barRef: AnyObject?
            guard AXUIElementCopyAttributeValue(appEl, kAXMenuBarAttribute as CFString, &barRef) == .success,
                  let barObj = barRef else {
                return AXResult.failure("ax_unavailable", "the app exposes no menu bar.")
            }
            current = barObj as! AXUIElement
        }

        for (i, want) in parts.enumerated() {
            guard let item = matchMenuItem(in: current, title: want) else {
                let available = axChildren(current)
                    .flatMap { stringAttr($0, kAXRoleAttribute) == "AXMenu" ? axChildren($0) : [$0] }
                    .compactMap { stringAttr($0, kAXTitleAttribute) }.filter { !$0.isEmpty }
                return bail("element_not_found", "no menu item matches \"\(want)\". This level has: \(available.prefix(30).joined(separator: ", ")).")
            }
            if boolAttr(item, kAXEnabledAttribute) == false {
                return bail("element_disabled", "menu item \"\(want)\" is disabled — its action does not apply to the current selection/focus. Establish the selection (select_text) first, then retry.")
            }
            if i == parts.count - 1 {
                let err = AXUIElementPerformAction(item, kAXPressAction as CFString)
                guard err == .success else {
                    return bail("ax_unavailable", "could not press menu item \"\(want)\" (error \(err.rawValue)).")
                }
                Thread.sleep(forTimeInterval: 0.4)
                var out = "Chose \"\(parts.joined(separator: " > "))\" from the \(isContext ? "context menu" : "menu bar")."
                if let el = element, let style = selectionStyle(el) {
                    out += " Selection style now: \(style)."
                }
                return AXResult(ok: true, output: out, errorKind: nil, health: nil, noChange: false)
            }
            guard let submenu = axChildren(item).first(where: { stringAttr($0, kAXRoleAttribute) == "AXMenu" }) else {
                return bail("element_not_found", "\"\(want)\" has no submenu to descend into.")
            }
            current = submenu
        }
        return bail("ax_unavailable", "unreachable")
    }

    /// Locate the popped-up context menu: direct AXMenu child of the app, else a shallow
    /// search under the element itself (apps attach context menus in either place).
    private func findMenu(near element: AXUIElement, app: AXUIElement) -> AXUIElement? {
        if let m = axChildren(app).first(where: { stringAttr($0, kAXRoleAttribute) == "AXMenu" }) { return m }
        var frontier = axChildren(element)
        for _ in 0..<4 {
            if let m = frontier.first(where: { stringAttr($0, kAXRoleAttribute) == "AXMenu" }) { return m }
            frontier = frontier.flatMap { axChildren($0) }
            if frontier.count > 400 { break }
        }
        return nil
    }

    /// Match one path segment among a container's items. Menu-bar items and menu items both
    /// answer to AXTitle; a container that is a bar/menu holds items directly. Exact
    /// (case-insensitive, "…"-stripped) wins; a UNIQUE containment match is accepted;
    /// ambiguity is not-found (never guess between menu items).
    private func matchMenuItem(in container: AXUIElement, title want: String) -> AXUIElement? {
        let items = axChildren(container).flatMap { child -> [AXUIElement] in
            let role = stringAttr(child, kAXRoleAttribute)
            return (role == "AXMenu") ? axChildren(child) : [child]
        }
        func norm(_ s: String) -> String {
            s.replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "")
                .trimmingCharacters(in: .whitespaces).lowercased()
        }
        let wantN = norm(want)
        let titled = items.compactMap { item -> (AXUIElement, String)? in
            guard let t = stringAttr(item, kAXTitleAttribute), !t.isEmpty else { return nil }
            return (item, norm(t))
        }
        if let exact = titled.first(where: { $0.1 == wantN }) { return exact.0 }
        let contains = titled.filter { $0.1.contains(wantN) }
        return contains.count == 1 ? contains[0].0 : nil
    }

    /// The formatting feedback channel: Notes (and AppKit text views generally) expose the
    /// applied style of a range as a human-readable AXStyleName inside the attributed
    /// string — e.g. "Heading, Pink highlight, Contains paragraphs". Text-value diffs are
    /// blind to formatting; this read is how a highlight/color action becomes verifiable.
    private func selectionStyle(_ element: AXUIElement) -> String? {
        guard let sel = selectedRange(element), sel.length > 0 else { return nil }
        var range = CFRange(location: sel.location, length: sel.length)
        guard let axRange = AXValueCreate(.cfRange, &range) else { return nil }
        var out: AnyObject?
        guard AXUIElementCopyParameterizedAttributeValue(element, "AXAttributedStringForRange" as CFString, axRange, &out) == .success,
              let astr = out as? NSAttributedString else { return nil }
        var styles: Set<String> = []
        astr.enumerateAttribute(NSAttributedString.Key("AXStyleName"), in: NSRange(location: 0, length: astr.length)) { value, _, _ in
            if let s = value as? String { styles.insert(s) }
        }
        return styles.isEmpty ? nil : styles.sorted().joined(separator: " | ")
    }

    // MARK: settle — debounced AXObserver, wrapped by poll + timeout

    /// Wait for the UI to quiesce: poll the element's value/children signature until it's
    /// stable for a debounce window, or the timeout. AXObserver notifications are lossy on
    /// Sequoia/Tahoe (destroyed/changed drop silently), so a poll reconciliation is the
    /// reliable floor here rather than pure notification-driven settle.
    private func settle(element: AXUIElement, timeoutMs: Int) {
        let deadline = Date().addingTimeInterval(min(Double(timeoutMs) / 1000, 2.0))
        let debounce = 0.18
        var lastSig = signature(element)
        var stableSince = Date()
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
            let sig = signature(element)
            if sig != lastSig {
                lastSig = sig
                stableSince = Date()
            } else if Date().timeIntervalSince(stableSince) >= debounce {
                return
            }
        }
    }

    /// Cheap change signature for settle polling — value + child count of the acted element
    /// and its focused window. Not a full re-read; just enough to detect motion.
    private func signature(_ element: AXUIElement) -> String {
        var out = stringAttr(element, kAXValueAttribute) ?? ""
        var childrenRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
           let children = childrenRef as? [AXUIElement] {
            out += "#\(children.count)"
        }
        return out
    }

    // MARK: before/after diff

    /// A compact, human-readable descriptor of an optional target element + its focused
    /// window, so the diff shows what changed around the action (focus moved, value set, a
    /// sheet appeared). element == nil for verbs with no element target (key).
    /// Cost note: this walks the focused window (cap 60) once per call = twice per act. Fine
    /// for attended single-user use, bounded by the 2 s per-element messaging timeout; if act
    /// latency ever matters on dense apps, batch the reads (AXUIElementCopyMultipleAttributeValues).
    private func describe(_ element: AXUIElement?) -> [String] {
        var lines: [String] = []
        if let element, let role = stringAttr(element, kAXRoleAttribute) {
            let name = stringAttr(element, kAXTitleAttribute) ?? stringAttr(element, kAXDescriptionAttribute) ?? ""
            let value = stringAttr(element, kAXValueAttribute).map { " value=\"\(truncate($0))\"" } ?? ""
            let focused = (boolAttr(element, kAXFocusedAttribute) ?? false) ? " focused" : ""
            lines.append("target \(role) \"\(name)\"\(value)\(focused)")
        }
        // A small slice of the focused window's interactive children captures dialogs /
        // sheets / new rows appearing — the "state" the loop verifies against.
        if let app = lastApp {
            let appElement = AXUIElement.application(app.pid)
            if let win = focusedWindow(of: appElement) {
                var nodes: [AXNode] = []
                var truncated = false
                walk(win, pid: app.pid, depth: 0, into: &nodes, cap: 60, truncated: &truncated)
                for node in nodes.prefix(60) { lines.append(node.diffLine()) }
            }
        }
        return lines
    }

    /// Line-level +/−/~ diff via MULTISET counts (not a Set), so a duplicate row/button
    /// appearing (2→3 identical lines) is reported instead of being swallowed by set-dedup.
    /// Typical click = a handful of lines; empty = true no-op.
    private func diffLines(before: [String], after: [String]) -> String {
        var counts: [String: Int] = [:]
        for line in before { counts[line, default: 0] -= 1 }
        for line in after { counts[line, default: 0] += 1 }
        var out: [String] = []
        // Emit in `after` order for additions, `before` order for removals, honoring counts.
        for line in after where counts[line, default: 0] > 0 {
            out.append("+ \(line)")
            counts[line]! -= 1
        }
        for line in before where counts[line, default: 0] < 0 {
            out.append("- \(line)")
            counts[line]! += 1
        }
        return out.prefix(80).joined(separator: "\n")
    }

    // MARK: element helpers

    private func resolveApp(_ name: String?) -> (pid: pid_t, name: String)? {
        if let name, !name.isEmpty {
            let lc = name.lowercased()
            let apps = NSWorkspace.shared.runningApplications
            // Prefer an EXACT localizedName match across all apps before falling back to a
            // bundle-id substring — otherwise a short/common name can match an unrelated app
            // whose bundle id happens to contain it and appears earlier in the (unordered) list.
            if let exact = apps.first(where: { $0.localizedName?.lowercased() == lc }) {
                return (exact.processIdentifier, exact.localizedName ?? name)
            }
            if let fuzzy = apps.first(where: { $0.bundleIdentifier?.lowercased().contains(lc) ?? false }) {
                return (fuzzy.processIdentifier, fuzzy.localizedName ?? name)
            }
            return nil
        }
        guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
        return (front.processIdentifier, front.localizedName ?? "frontmost")
    }

    private func focusedWindow(of appElement: AXUIElement) -> AXUIElement? {
        var ref: CFTypeRef?
        if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &ref) == .success,
           let win = ref, CFGetTypeID(win) == AXUIElementGetTypeID() {
            return (win as! AXUIElement)
        }
        if AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &ref) == .success,
           let win = ref, CFGetTypeID(win) == AXUIElementGetTypeID() {
            return (win as! AXUIElement)
        }
        return nil
    }

    private func isSecureField(_ element: AXUIElement) -> Bool {
        stringAttr(element, kAXSubroleAttribute) == "AXSecureTextField"
    }

    private func pidOf(_ element: AXUIElement) -> pid_t {
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        return pid
    }

    private func frameCenter(_ element: AXUIElement) -> CGPoint? {
        guard let frame = frameOf(element) else { return nil }
        return CGPoint(x: frame.midX, y: frame.midY)
    }

    private func frameOf(_ element: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let pos = posRef, let sz = sizeRef,
              CFGetTypeID(pos) == AXValueGetTypeID(), CFGetTypeID(sz) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(pos as! AXValue, .cgPoint, &point)
        AXValueGetValue(sz as! AXValue, .cgSize, &size)
        return CGRect(origin: point, size: size)
    }

    /// The acted element's frame, for the ghost cursor to fly to (screen coords, top-left).
    func frame(ofRef ref: String) -> CGRect? {
        queue.sync {
            guard let element = refs[ref] else { return nil }
            return frameOf(element)
        }
    }

    // MARK: M8 replay resolution — taught target → live ref (read-only)

    /// Match a recorded target against the LAST snapshot's nodes: identifier exact →
    /// role+name exact → role+name contains → role-unique. Returns ONLY the ref string
    /// (no ambient screen text — the daemon-side engine makes deterministic decisions on
    /// it), a typed element_not_found otherwise. Ambiguity IS not-found: replay never
    /// guesses between two matches (adapt-or-bail, never act on the wrong element).
    private func resolve(role: String?, name: String?, identifier: String?) -> AXResult {
        guard !lastNodes.isEmpty else {
            return AXResult.failure("stale_ref", "No snapshot to resolve against — take ax_snapshot first.")
        }
        func norm(_ s: String?) -> String {
            var v = (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if v.hasPrefix("ax") { v = String(v.dropFirst(2)) }
            return v
        }
        let wantRole = norm(role)
        let wantName = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let wantId = (identifier ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wantId.isEmpty || !wantName.isEmpty || !wantRole.isEmpty else {
            return AXResult.failure("element_not_found", "resolve needs an identifier, a name, or a role.")
        }
        let pool = lastNodes.filter { wantRole.isEmpty || norm($0.role) == wantRole }
        // Rung 1: identifier exact — the only selector stable across runs when apps set it.
        if !wantId.isEmpty {
            let hits = pool.filter { $0.identifier == wantId }
            if hits.count == 1 { return AXResult(ok: true, output: hits[0].ref, errorKind: nil, health: nil) }
            if hits.count > 1 { return AXResult.failure("element_not_found", "ambiguous: \(hits.count) elements share that identifier.") }
        }
        if !wantName.isEmpty {
            // Rung 2: exact name.
            let exact = pool.filter { $0.name.lowercased() == wantName }
            if exact.count == 1 { return AXResult(ok: true, output: exact[0].ref, errorKind: nil, health: nil) }
            if exact.count > 1 { return AXResult.failure("element_not_found", "ambiguous: \(exact.count) elements named that.") }
            // Rung 3: containment (relaxed — labels drift with counts/dates).
            let contains = pool.filter { $0.name.lowercased().contains(wantName) }
            if contains.count == 1 { return AXResult(ok: true, output: contains[0].ref, errorKind: nil, health: nil) }
            if contains.count > 1 { return AXResult.failure("element_not_found", "ambiguous: \(contains.count) partial matches.") }
        }
        // Rung 4: role-unique. Recorded identifiers often embed per-document instance ids
        // (Notes: "Note[id=<uuid>]") that can NEVER match a fresh document, and unlabeled
        // text areas record no name — but when the role narrows the pool to EXACTLY one
        // live element, that is an unambiguous match. Two-plus stays not-found (never guess).
        if !wantRole.isEmpty && pool.count == 1 {
            return AXResult(ok: true, output: pool[0].ref, errorKind: nil, health: nil)
        }
        return AXResult.failure("element_not_found", "no element matches the recorded target in the current snapshot.")
    }

    // MARK: M8 teaching outcome — the document that resulted from a demonstration

    /// The dominant text document of an app: full text plus styled ranges from the
    /// attributed string (style names, underline, bold/italic font traits). Captured at
    /// teach-stop so the compiler builds CONTENT from the observed RESULT — corrections,
    /// undos, and caret wandering during the demonstration are already reflected in the
    /// final text, which keystroke archaeology can never reliably reconstruct.
    private func documentState(app requestedApp: String?, identifier: String? = nil, role targetRole: String? = nil) -> AXResult {
        guard let target = resolveApp(requestedApp) else {
            return AXResult.failure("element_not_found", requestedApp.map { "No running app matches \"\($0)\"." } ?? "No frontmost application.")
        }
        let appElement = AXUIElement.application(target.pid)
        appElement.setMessagingTimeout(messagingTimeout)
        let root = focusedWindow(of: appElement) ?? appElement
        // Prefer the DEMONSTRATED field (identifier from the last recorded text step) —
        // the capture's scope should match what the user actually typed in, never widen to
        // whatever text area happens to be biggest. Largest-area is the fallback only.
        // The walk is node-capped: a browser-sized tree must not hold the serial AX queue
        // past the daemon's RPC budget.
        var best: (el: AXUIElement, area: CGFloat)?
        var demonstrated: AXUIElement?
        var visited = 0
        let wantId = (identifier ?? "").trimmingCharacters(in: .whitespaces)
        func scan(_ el: AXUIElement, depth: Int) {
            if depth > 30 || visited >= documentScanNodeCap || demonstrated != nil { return }
            visited += 1
            let role = stringAttr(el, kAXRoleAttribute)
            if role == "AXTextArea" || role == "AXTextField", !isSecureField(el) {
                if !wantId.isEmpty, stringAttr(el, kAXIdentifierAttribute) == wantId {
                    demonstrated = el
                    return
                }
                if role == "AXTextArea" {
                    var pos = CGPoint.zero
                    var size = CGSize.zero
                    var pv: CFTypeRef?
                    var sv: CFTypeRef?
                    if AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &pv) == .success, let p = pv,
                       AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sv) == .success, let s = sv {
                        AXValueGetValue(p as! AXValue, .cgPoint, &pos)
                        AXValueGetValue(s as! AXValue, .cgSize, &size)
                    }
                    let area = size.width * size.height
                    if area > (best?.area ?? 0) { best = (el, area) }
                }
            }
            for c in axChildren(el) { scan(c, depth: depth + 1) }
        }
        scan(root, depth: 0)
        guard let doc = demonstrated ?? best?.el else {
            return AXResult.failure("element_not_found", "no text document found in \(target.name).")
        }
        guard let full = stringAttr(doc, kAXValueAttribute), !full.isEmpty else {
            return AXResult.failure("element_not_found", "the document is empty or exposes no text.")
        }
        let ns = full as NSString
        let cappedLen = min(ns.length, 20_000)
        var range = CFRange(location: 0, length: cappedLen)
        guard let axRange = AXValueCreate(.cfRange, &range) else {
            return AXResult.failure("ax_unavailable", "could not build the document range.")
        }
        var out: AnyObject?
        var runs: [String] = []
        if AXUIElementCopyParameterizedAttributeValue(doc, "AXAttributedStringForRange" as CFString, axRange, &out) == .success,
           let astr = out as? NSAttributedString {
            astr.enumerateAttributes(in: NSRange(location: 0, length: astr.length)) { attrs, r, _ in
                var flags: [String] = []
                if let style = attrs[NSAttributedString.Key("AXStyleName")] as? String { flags.append(style) }
                // Paragraph STRUCTURE — a list's dash/bullet is formatting, not characters:
                // the plain text reads back WITHOUT it, so without these keys a replay
                // silently produces unstructured lines (the dashed-list demo bug).
                if let prefix = attrs[NSAttributedString.Key("AXListItemPrefix")] {
                    let d = String(describing: prefix).lowercased()
                    let kind = d.contains("dash") ? "dashed"
                        : d.contains("bullet") ? "bulleted"
                        : d.contains("number") || d.contains("decimal") ? "numbered"
                        : d.contains("check") ? "checklist" : "list"
                    let level = (attrs[NSAttributedString.Key("AXListItemLevel")] as? NSNumber)?.intValue ?? 0
                    flags.append("\(kind) list item\(level > 0 ? " (level \(level))" : "")")
                }
                if let u = attrs[NSAttributedString.Key("AXUnderline")] as? NSNumber, u.intValue != 0 { flags.append("underlined") }
                if let font = attrs[NSAttributedString.Key("AXFont")] as? [String: Any],
                   let fname = (font["AXFontName"] as? String)?.lowercased() {
                    if fname.contains("bold") { flags.append("bold") }
                    if fname.contains("italic") || fname.contains("oblique") { flags.append("italic") }
                }
                guard !flags.isEmpty else { return }
                let snippet = (astr.string as NSString).substring(with: r).replacingOccurrences(of: "\n", with: "⏎")
                runs.append("[\(r.location)-\(r.location + r.length)] \"\(truncate(snippet, 60))\": \(flags.joined(separator: ", "))")
            }
        }
        var body = "=== final document (app \"\(target.name)\") ===\n\(ns.substring(to: cappedLen))"
        if ns.length > cappedLen { body += "\n…(truncated)" }
        body += "\n=== styled ranges (character offsets into the text above) ===\n"
        body += runs.isEmpty ? "(no styling readable)" : runs.joined(separator: "\n")
        return AXResult(ok: true, output: body, errorKind: nil, health: nil)
    }

    // MARK: M8 recorder support — element-at-point + focused element (read-only)

    /// The element under a screen point (global top-left coords, same space as
    /// AXPosition and the tap's event.location), climbed to the nearest interactive
    /// ancestor. Nil when nothing resolvable is there (the recorder degrades to a
    /// low-fidelity step, never an error).
    func hitTest(at point: CGPoint) -> AXHitInfo? {
        queue.sync {
            AXUIElement.systemWide.setMessagingTimeout(messagingTimeout)
            var found: AXUIElement?
            let err = AXUIElementCopyElementAtPosition(AXUIElement.systemWide, Float(point.x), Float(point.y), &found)
            guard err == .success, let hit = found else { return nil }
            return hitInfo(for: climbToInteractive(hit))
        }
    }

    /// The text a drag/double-click just highlighted in the focused element, WHICH occurrence of it
    /// (so two identical strings disambiguate), and that field's semantic info — lets the recorder
    /// store a spatial highlight as a SEMANTIC select_text step instead of a lost, un-replayable
    /// drag. Nil when nothing is selected. AX offsets are UTF-16.
    func focusedSelection() -> (text: String, occurrence: Int, field: AXHitInfo)? {
        queue.sync { () -> (text: String, occurrence: Int, field: AXHitInfo)? in
            AXUIElement.systemWide.setMessagingTimeout(messagingTimeout)
            var ref: CFTypeRef?
            guard AXUIElementCopyAttributeValue(AXUIElement.systemWide, kAXFocusedUIElementAttribute as CFString, &ref) == .success,
                  let f = ref, CFGetTypeID(f) == AXUIElementGetTypeID()
            else { return nil }
            let el = (f as! AXUIElement)
            let sel = stringAttr(el, kAXSelectedTextAttribute) ?? ""
            guard !sel.isEmpty else { return nil }
            var occurrence = 0
            if let range = selectedRange(el), let full = stringAttr(el, kAXValueAttribute) {
                let ns = full as NSString
                var from = 0, idx = 0
                while from <= ns.length {
                    let r = ns.range(of: sel, options: [], range: NSRange(location: from, length: ns.length - from))
                    if r.location == NSNotFound { break }
                    if r.location == range.location { occurrence = idx; break }
                    idx += 1
                    from = r.location + max(1, r.length)
                }
            }
            guard let field = hitInfo(for: el) else { return nil }
            return (sel, occurrence, field)
        }
    }

    /// The focused element's current selection range (UTF-16), or nil.
    private func selectedRange(_ element: AXUIElement) -> NSRange? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &ref) == .success,
              let v = ref, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue((v as! AXValue), .cfRange, &range) else { return nil }
        return NSRange(location: range.location, length: range.length)
    }

    /// The focused UI element — what a typing burst lands in. Read at burst START so the
    /// secure-field decision is made before any content exists to mishandle.
    func focusedFieldInfo() -> AXHitInfo? {
        queue.sync {
            AXUIElement.systemWide.setMessagingTimeout(messagingTimeout)
            var ref: CFTypeRef?
            guard AXUIElementCopyAttributeValue(AXUIElement.systemWide, kAXFocusedUIElementAttribute as CFString, &ref) == .success,
                  let f = ref, CFGetTypeID(f) == AXUIElementGetTypeID()
            else { return nil }
            return hitInfo(for: (f as! AXUIElement))
        }
    }

    /// Hit-tests land on leaves (the label INSIDE the button); climb to the control that
    /// means something. A real control beats static text; static text (an interactive
    /// role for state-verification reasons) is only the fallback when no control encloses it.
    private func climbToInteractive(_ element: AXUIElement) -> AXUIElement {
        var current = element
        var textFallback: AXUIElement?
        for _ in 0..<8 {
            let role = stringAttr(current, kAXRoleAttribute) ?? ""
            let subrole = stringAttr(current, kAXSubroleAttribute)
            if AXNode.isInteractive(role: role, subrole: subrole) {
                if role != kAXStaticTextRole { return current }
                if textFallback == nil { textFallback = current }
            }
            guard let parent = parentOf(current) else { break }
            current = parent
        }
        return textFallback ?? element
    }

    /// Structure-only descriptor for the recorder: labels, roles, identifiers — NEVER a
    /// value read (recording captures what the user touched, not what it contained).
    private func hitInfo(for element: AXUIElement) -> AXHitInfo? {
        element.setMessagingTimeout(messagingTimeout)
        let role = stringAttr(element, kAXRoleAttribute) ?? ""
        guard !role.isEmpty else { return nil }
        let subrole = stringAttr(element, kAXSubroleAttribute)
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        return AXHitInfo(
            appName: NSRunningApplication(processIdentifier: pid)?.localizedName ?? "",
            windowTitle: windowTitle(of: element),
            role: role,
            subrole: subrole,
            name: stringAttr(element, kAXTitleAttribute) ?? stringAttr(element, kAXDescriptionAttribute),
            identifier: stringAttr(element, kAXIdentifierAttribute),
            isSecure: subrole == "AXSecureTextField"
        )
    }

    private func windowTitle(of element: AXUIElement) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &ref) == .success,
              let w = ref, CFGetTypeID(w) == AXUIElementGetTypeID()
        else { return nil }
        return stringAttr((w as! AXUIElement), kAXTitleAttribute)
    }

    private func parentOf(_ element: AXUIElement) -> AXUIElement? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &ref) == .success,
              let p = ref, CFGetTypeID(p) == AXUIElementGetTypeID()
        else { return nil }
        return (p as! AXUIElement)
    }

    // MARK: raw attribute reads

    private func stringAttr(_ element: AXUIElement, _ attr: String) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success else { return nil }
        if let s = ref as? String { return s }
        if let n = ref as? NSNumber { return n.stringValue }
        return nil
    }

    private func boolAttr(_ element: AXUIElement, _ attr: String) -> Bool? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success else { return nil }
        return ref as? Bool
    }

    private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &ref) == .success else { return [] }
        return (ref as? [AXUIElement]) ?? []
    }

    private func string(_ raw: [CFTypeRef], _ index: Int) -> String? {
        guard index < raw.count else { return nil }
        let v = raw[index]
        if let s = v as? String, !s.isEmpty { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    private func frameFrom(_ raw: [CFTypeRef], posIndex: Int, sizeIndex: Int) -> CGRect? {
        guard posIndex < raw.count, sizeIndex < raw.count else { return nil }
        guard CFGetTypeID(raw[posIndex]) == AXValueGetTypeID(), CFGetTypeID(raw[sizeIndex]) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(raw[posIndex] as! AXValue, .cgPoint, &point)
        AXValueGetValue(raw[sizeIndex] as! AXValue, .cgSize, &size)
        return CGRect(origin: point, size: size)
    }

    private func truncate(_ s: String, _ max: Int = 80) -> String {
        s.count <= max ? s : String(s.prefix(max)) + "…"
    }

    // MARK: rendering the compacted snapshot

    private func render(_ nodes: [AXNode], app: (pid: pid_t, name: String), truncated: Bool) -> String {
        var out = "app \"\(app.name)\" — \(nodes.count) interactive element\(nodes.count == 1 ? "" : "s")"
        if truncated { out += " (truncated; use query to find more)" }
        out += "\n" + nodes.map { $0.line() }.joined(separator: "\n")
        return out
    }
}
