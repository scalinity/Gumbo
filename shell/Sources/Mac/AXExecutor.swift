import AppKit
import ApplicationServices

/// M6 result of one executed step — mirrors the daemon's MacActionResult wire shape.
/// `output` is what the model reads; `errorKind`/`health` are the branchable metadata.
struct AXResult {
    var ok: Bool
    var output: String
    var errorKind: String?
    var health: String?

    func wire() -> [String: Any] {
        var dict: [String: Any] = ["ok": ok, "output": output]
        if let errorKind { dict["error_kind"] = errorKind }
        if let health { dict["health"] = health }
        return dict
    }

    static func failure(_ kind: String, _ output: String) -> AXResult {
        AXResult(ok: false, output: output, errorKind: kind, health: nil)
    }
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

        // New generation: mint fresh refs, drop the old map (old refs now stale by design).
        generation += 1
        refs = [:]
        for (i, _) in nodes.enumerated() {
            let ref = "e\(i)"
            nodes[i].ref = ref
            refs[ref] = nodes[i].element
        }
        lastNodes = nodes
        lastApp = target
        return AXResult(ok: true, output: render(nodes, app: target, truncated: truncated), errorKind: nil, health: nil)
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

        if AXNode.isInteractive(role: role, subrole: subrole) {
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

    private func act(_ action: [String: Any]) -> AXResult {
        let verb = action["verb"] as? String ?? ""
        let timeoutMs = action["timeout_ms"] as? Int ?? 5000

        // wait_for matches on role+name against fresh reads, not a ref — it exists for slow
        // transitions where the target didn't exist at snapshot time.
        if verb == "wait_for" {
            return waitFor(role: action["role"] as? String, name: action["name"] as? String, timeoutMs: timeoutMs)
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

        var actErr: String?
        switch verb {
        case "press": actErr = performPress(element, pid: pid)
        case "focus": actErr = performFocus(element)
        case "set_value": actErr = performSetValue(element, value: action["value"] as? String ?? "")
        case "type": actErr = performType(element, text: action["value"] as? String ?? "", pid: pid)
        case "key": actErr = SyntheticInput.pressKey(action["value"] as? String ?? "", pid: pid) ? nil : "unknown key chord"
        case "show_menu": actErr = performShowMenu(element, pid: pid)
        default: return AXResult.failure("out_of_scope", "Unknown verb \"\(verb)\".")
        }
        if let actErr {
            return AXResult.failure("ax_unavailable", "\(verb) failed: \(actErr)")
        }

        settle(element: element, timeoutMs: timeoutMs)
        let after = describe(element)
        // Verify by DIFF, never return code — AXPress false-passes on backgrounded/disabled
        // items. An empty diff is a real "no observable change" signal the model can act on.
        let diff = diffLines(before: before, after: after)
        let body = diff.isEmpty ? "(no observable change — the action may not have taken effect)" : diff
        return AXResult(ok: true, output: body, errorKind: nil, health: nil)
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
        return AXResult.failure("timeout", "Waited \(timeoutMs) ms; no element matched role=\(role ?? "*") name=\(name ?? "*").")
    }

    // MARK: dispatch ladder rungs

    /// Rung 1: AXPress (background-safe, works on occluded elements, never moves the
    /// pointer). Falls to rung 2 (pid-targeted synthetic click at the element's frame) when
    /// AXPress isn't supported/effective. The ghost cursor animates to the frame regardless.
    private func performPress(_ element: AXUIElement, pid: pid_t) -> String? {
        let err = AXUIElementPerformAction(element, kAXPressAction as CFString)
        if err == .success { return nil }
        // Rung 2: pid-targeted synthetic click at the element center.
        if let center = frameCenter(element) {
            SyntheticInput.click(at: center, pid: pid)
            return nil
        }
        return "AXPress error \(err.rawValue) and no frame to click"
    }

    private func performFocus(_ element: AXUIElement) -> String? {
        let err = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        return err == .success ? nil : "AXFocused set error \(err.rawValue)"
    }

    /// Try the direct AXValue write first (fast, fires no key events); check settable first.
    private func performSetValue(_ element: AXUIElement, value: String) -> String? {
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        guard settable.boolValue else { return "AXValue is not settable — use the type verb instead" }
        let err = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
        return err == .success ? nil : "AXValue set error \(err.rawValue)"
    }

    /// Focus, then real key events — Electron/web fields ignore AXValue writes but fire
    /// their JS listeners on synthetic key events.
    private func performType(_ element: AXUIElement, text: String, pid: pid_t) -> String? {
        _ = performFocus(element)
        SyntheticInput.type(text, pid: pid)
        return nil
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

    /// A compact, human-readable descriptor of the element + its focused window, so the
    /// diff shows what changed around the action (focus moved, value set, a sheet appeared).
    private func describe(_ element: AXUIElement) -> [String] {
        var lines: [String] = []
        if let role = stringAttr(element, kAXRoleAttribute) {
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

    /// Line-level +/−/~ diff (volatile fields already stripped by describe's truncation).
    /// Typical click = a handful of lines; empty = true no-op.
    private func diffLines(before: [String], after: [String]) -> String {
        let beforeSet = Set(before)
        let afterSet = Set(after)
        var out: [String] = []
        for line in after where !beforeSet.contains(line) { out.append("+ \(line)") }
        for line in before where !afterSet.contains(line) { out.append("- \(line)") }
        return out.prefix(80).joined(separator: "\n")
    }

    // MARK: element helpers

    private func resolveApp(_ name: String?) -> (pid: pid_t, name: String)? {
        if let name, !name.isEmpty {
            let lc = name.lowercased()
            if let match = NSWorkspace.shared.runningApplications.first(where: {
                ($0.localizedName?.lowercased() == lc) || ($0.bundleIdentifier?.lowercased().contains(lc) ?? false)
            }) {
                return (match.processIdentifier, match.localizedName ?? name)
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
