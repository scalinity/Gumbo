import AppKit
import WebKit

/// The activity center: a plain window hosting the React dashboard. Loads exactly
/// http://localhost:5173 — never any subdomain — and survives close (hidden, re-shown).
final class DashboardWindow: NSObject, NSWindowDelegate {
    private var window: NSWindow?

    func show() {
        if window == nil { build() }
        window?.makeKeyAndOrderFront(nil)
    }

    private func build() {
        let webView = WKWebView(frame: .zero)
        webView.load(URLRequest(url: URL(string: "http://localhost:5173")!))

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 740),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Gumbo — Activity"
        window.contentView = webView
        window.center()
        window.isReleasedWhenClosed = false // hide on close; reopened from the notch / status item
        window.delegate = self
        self.window = window
    }
}
