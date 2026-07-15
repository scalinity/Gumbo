import AppKit
import WebKit

/// The activity center: a plain window hosting the React dashboard. Loads exactly
/// http://localhost:5173 — never any subdomain — and survives close (hidden, re-shown).
final class DashboardWindow: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?

    func show(taskId: String? = nil) {
        if window == nil { build() }
        window?.makeKeyAndOrderFront(nil)
        if let taskId { selectTask(taskId, attempts: 5) }
    }

    /// Deep-link a bubble click into the loaded React app via the module-scope hook that
    /// dashboard/src/ws.ts installs (no React lifecycle involved). Retries briefly: right
    /// after the window is first built, the page may not have installed the hook yet.
    private func selectTask(_ taskId: String, attempts: Int) {
        guard taskId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { return }
        let js = "window.__gumboSelectTask ? (window.__gumboSelectTask('\(taskId)'), true) : false"
        webView?.evaluateJavaScript(js) { [weak self] result, _ in
            if (result as? Bool) != true, attempts > 1 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    self?.selectTask(taskId, attempts: attempts - 1)
                }
            }
        }
    }

    private func build() {
        let webView = WKWebView(frame: .zero)
        webView.load(URLRequest(url: URL(string: "http://localhost:5173")!))
        self.webView = webView

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
