import AppKit
import ApplicationServices

/// Bring an app to the front RELIABLY, even on a system where plain `open`/`activate` are
/// suppressed (the user's Mac does not auto-foreground opened apps — a persistent, pre-beta
/// system behavior). Gumbo holds Accessibility + Automation, so the AX path
/// (kAXFrontmostAttribute + kAXRaiseAction) — the same technique window managers use —
/// raises the window where Cocoa activation alone is ignored. Every rung is attempted; the
/// AX rung is the workhorse.
///
/// This exists because the computer-use lanes MUST drive the window that is actually
/// frontmost: the vision lane captures a window and then click_point clicks GLOBAL
/// coordinates, so if the target is occluded the click lands on whatever is on top (it was
/// clicking Terminal). Raising the target first makes the capture + the click land on it.
enum Foreground {
    /// Find a running app by exact localized name, then loose name, then bundle-id substring
    /// (mirrors the AX executor's app matching).
    static func runningApp(named name: String) -> NSRunningApplication? {
        let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy != .prohibited }
        return running.first { $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame }
            ?? running.first { $0.localizedName?.range(of: name, options: .caseInsensitive) != nil }
            ?? running.first { $0.bundleIdentifier?.range(of: name, options: .caseInsensitive) != nil }
    }

    /// Bring the named app to the front. Returns false only if the app isn't running (the
    /// caller launches it first). Best-effort: a true return is "we asked every way we can,"
    /// not a guarantee the WindowServer honored it.
    @discardableResult
    static func bringToFront(app name: String) -> Bool {
        guard let proc = runningApp(named: name) else { return false }
        raise(proc)
        return true
    }

    /// An INSTALLED app whose name best matches a spoken/approximate query — exact, then
    /// prefix, then the SHORTEST substring match (closest fit). Scans the standard app
    /// dirs. This is why "ChatGPT" resolves to the installed "ChatGPT Classic": raw
    /// `tell application "ChatGPT"` / `open -a ChatGPT` need a near-exact name, but the user
    /// says the everyday name.
    static func installedApp(named query: String) -> URL? {
        let fm = FileManager.default
        let home = NSHomeDirectory()
        let dirs = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", "\(home)/Applications"]
        var candidates: [(name: String, url: URL)] = []
        for dir in dirs {
            guard let items = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            for item in items where item.hasSuffix(".app") {
                candidates.append(((item as NSString).deletingPathExtension, URL(fileURLWithPath: dir).appendingPathComponent(item)))
            }
        }
        let q = query.lowercased()
        return candidates.first { $0.name.lowercased() == q }?.url
            ?? candidates.first { $0.name.lowercased().hasPrefix(q) }?.url
            ?? candidates.sorted { $0.name.count < $1.name.count }.first { $0.name.lowercased().contains(q) }?.url
    }

    /// Open OR focus an app by (possibly approximate) name: front it if already running,
    /// else launch the best-matching installed app and front it once it's up. Returns the
    /// RESOLVED app name (so the model learns what actually opened), or nil if nothing —
    /// running or installed — matches. Launch is async (openApplication's completion
    /// raises it), so this returns immediately and never blocks the main thread.
    static func openOrFront(app name: String) -> String? {
        if let proc = runningApp(named: name) {
            raise(proc)
            return proc.localizedName ?? name
        }
        guard let url = installedApp(named: name) else { return nil }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true // ask for foreground on launch…
        NSWorkspace.shared.openApplication(at: url, configuration: config) { app, _ in
            // …and raise it ourselves when it's up (the user's Mac doesn't auto-foreground
            // launched apps — the reason this whole file exists).
            if let app { DispatchQueue.main.async { raise(app) } }
        }
        return url.deletingPathExtension().lastPathComponent
    }

    /// Raise an already-resolved running app.
    static func raise(_ proc: NSRunningApplication) {
        // Rung 1 — Cocoa activation. On Sonoma+ a background app's activate() is often
        // ignored, but it's cheap and correct when allowed; activateAllWindows unminiaturizes.
        proc.activate(options: [.activateAllWindows])
        // Rung 2 — AX frontmost + raise the main window. Works with the Accessibility grant
        // even when rung 1 is suppressed (the window-manager path).
        let axApp = AXUIElementCreateApplication(proc.processIdentifier)
        AXUIElementSetAttributeValue(axApp, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        for attr in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(axApp, attr as CFString, &value) == .success,
               let win = value, CFGetTypeID(win) == AXUIElementGetTypeID() {
                let window = win as! AXUIElement
                AXUIElementPerformAction(window, kAXRaiseAction as CFString)
                AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
                break
            }
        }
    }
}
