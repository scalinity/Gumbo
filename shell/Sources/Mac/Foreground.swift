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
