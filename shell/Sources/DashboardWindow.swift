import AppKit
import WebKit

/// The activity center: a plain window hosting the React dashboard. Loads exactly
/// http://localhost:5173 — never any subdomain — and survives close (hidden, re-shown).
final class DashboardWindow: NSObject, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var loadFailed = false
    private var retryTimer: Timer?
    // Deep-link that arrived before the page finished loading — fired from didFinish,
    // so a cold vite start can't eat the click (the retry loop alone gave up in ~3 s).
    private var pendingTaskId: String?

    func show(taskId: String? = nil) {
        if window == nil { build() }
        if loadFailed { reload() }
        // Visible-but-behind: macOS 26 won't raise an on-screen window of a background
        // app (the notch catcher is nonactivating, so Gumbo stays inactive when clicked),
        // and orderFrontRegardless is silently ignored. A window freshly ADDED to the
        // screen list IS still placed frontmost — so re-show it through that path.
        if let window, window.isVisible, !NSApp.isActive {
            window.orderOut(nil)
        }
        window?.makeKeyAndOrderFront(nil)
        // An LSUIElement app asked to activate from a click in a NONACTIVATING panel can
        // be refused by macOS — the window then orders behind the frontmost app and looks
        // like it never opened. Force the ordering regardless of activation.
        window?.orderFrontRegardless()
        // Deliberately NO NSApp.activate: on macOS 26 an accessory app can't cooperatively
        // become frontmost (it's decorative — see QuickTextController), and ASKING leaves
        // Gumbo half-active so the OS snaps frontmost back to the previous app (Terminal)
        // the instant the user touches the menu bar — which read as "the app backgrounds
        // itself." The orderOut/makeKey/orderFront path above raises the window without it;
        // the app stays a clean background app, like every other surface here.
        if let taskId {
            pendingTaskId = taskId
            selectTask(taskId, attempts: 5)
        }
    }

    /// Deep-link a bubble click into the loaded React app via the module-scope hook that
    /// dashboard/src/ws.ts installs (no React lifecycle involved). Retries briefly: right
    /// after the window is first built, the page may not have installed the hook yet.
    private func selectTask(_ taskId: String, attempts: Int) {
        guard taskId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { return }
        let js = "window.__gumboSelectTask ? (window.__gumboSelectTask('\(taskId)'), true) : false"
        webView?.evaluateJavaScript(js) { [weak self] result, _ in
            guard let self else { return }
            if (result as? Bool) == true {
                if self.pendingTaskId == taskId { self.pendingTaskId = nil }
            } else if attempts > 1 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    self.selectTask(taskId, attempts: attempts - 1)
                }
            }
        }
    }

    private func build() {
        let webView = WKWebView(frame: .zero)
        webView.navigationDelegate = self
        webView.load(URLRequest(url: URL(string: "http://localhost:5173")!))
        self.webView = webView

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 740),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Gumbo — Activity" // still named in Mission Control / app switcher
        // No gray titlebar strip — just traffic lights over the app. The window background
        // mirrors the dashboard's --bg (#191411, index.css) so the bar blends seamlessly.
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(srgbRed: 0x19 / 255, green: 0x14 / 255, blue: 0x11 / 255, alpha: 1)
        window.contentView = webView
        window.center()
        window.isReleasedWhenClosed = false // hide on close; reopened from the notch / status item
        window.delegate = self
        self.window = window
    }

    // MARK: dead-page healing — the dev servers restart freely (tsx/vite watch, session
    // handoffs); a load that failed must not leave the window on an error page forever.

    private func reload() {
        loadFailed = false
        webView?.load(URLRequest(url: URL(string: "http://localhost:5173")!))
    }

    private func scheduleRetry() {
        loadFailed = true
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
            self?.reload()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadFailed = false
        retryTimer?.invalidate()
        retryTimer = nil
        if let taskId = pendingTaskId {
            selectTask(taskId, attempts: 5) // page is up — land the deep-link that missed
        }
    }
}
