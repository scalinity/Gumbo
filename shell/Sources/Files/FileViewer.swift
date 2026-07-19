import AppKit
import SwiftUI
import WebKit

/// Gumbo's own file renderer: a presented file opens here — markdown prettified, code
/// and plain text in clean monospace — instead of bouncing the user out to TextEdit or an
/// IDE. Editable: a composer at the bottom lets the user PROMPT the agent to change the
/// document (typed here, or spoken via ⌃⌥ — the viewer arms a `file_context` so a voice
/// edit_file needs no path). Each edit rewrites in place and refreshes here. Still a
/// WKWebView over locally generated HTML (no network, no scripts), one panel reused.
final class FileViewerController {
    /// WS sender, wired to WSClient by GumboController (file_context / file_edit_request).
    var onSend: (([String: Any]) -> Void)?

    private var panel: NSPanel?
    private let model = FileViewerModel()

    func open(_ doc: PresentedFile) {
        model.doc = doc
        model.busy = false
        model.notice = nil
        sendContext()
        showPanel()
    }

    func close() {
        model.doc = nil
        onSend?(["type": "file_context", "path": NSNull()])
        panel?.orderOut(nil)
    }

    /// file_present from the daemon: the present_file tool, the auto-present of a finished
    /// deliverable, or the refresh after an edit. If it's the document we have open (same
    /// path), swap the content in place and leave the busy state; otherwise ignore (the
    /// document card handles first-time opens).
    func handlePresented(_ doc: PresentedFile) {
        guard model.doc?.path == doc.path else { return }
        model.doc = doc
        model.busy = false
        model.notice = nil
    }

    /// file.edit_failed from the event fan-out: leave the busy state with an honest notice.
    func handleEditFailed(path: String) {
        guard model.doc?.path == path else { return }
        model.busy = false
        model.notice = "Edit failed — try again"
    }

    /// WS (re)connected: the daemon's in-memory file_context died with it — re-arm so a
    /// voice edit keeps targeting the open document (mirrors the image viewer).
    func resendContext() {
        guard model.doc != nil else { return }
        sendContext()
    }

    private func sendContext() {
        onSend?(["type": "file_context", "path": model.doc?.path ?? NSNull()])
    }

    private func submitEdit() {
        guard let doc = model.doc else { return }
        let prompt = model.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        model.draft = ""
        model.busy = true
        model.notice = nil
        onSend?(["type": "file_edit_request", "path": doc.path, "prompt": prompt])
    }

    private func showPanel() {
        if panel == nil {
            let panel = NSPanel(
                contentRect: NSRect(origin: .zero, size: NSSize(width: 700, height: 600)),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered, defer: false)
            panel.level = .statusBar
            panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = true
            panel.isMovable = true
            panel.isMovableByWindowBackground = true
            panel.hidesOnDeactivate = false
            panel.isReleasedWhenClosed = false
            panel.animationBehavior = .none
            panel.becomesKeyOnlyIfNeeded = true // key arrives when the composer is clicked
            panel.contentView = FirstMouseHostingView(
                rootView: FileViewerView(
                    model: model,
                    onSubmitEdit: { [weak self] in self?.submitEdit() },
                    onClose: { [weak self] in self?.close() }))
            self.panel = panel
        }
        position()
        panel?.orderFrontRegardless()
    }

    /// Anchored toward the top-right — it expands out of the document-card column.
    private func position() {
        guard let screen = NSScreen.gumboHome, let panel else { return }
        let visible = screen.visibleFrame
        let size = NSSize(width: min(720, visible.width * 0.5), height: visible.height * 0.82)
        panel.setFrame(
            NSRect(x: visible.maxX - size.width - 10, y: visible.maxY - size.height - 10,
                   width: size.width, height: size.height),
            display: true)
    }
}

final class FileViewerModel: ObservableObject {
    @Published var doc: PresentedFile?
    @Published var draft = "" // the composer's in-progress edit prompt
    @Published var busy = false // an edit is running; the doc will refresh on completion
    @Published var notice: String? // e.g. "Edit failed — try again"
}

private struct FileViewerView: View {
    @ObservedObject var model: FileViewerModel
    let onSubmitEdit: () -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Tokens.line).frame(height: 1)
            ZStack {
                if let doc = model.doc {
                    FileWebView(html: MarkdownHTML.page(for: doc))
                } else {
                    Spacer()
                }
                if model.busy {
                    // Dim + spinner while the agent rewrites the document.
                    Color.black.opacity(0.35)
                    VStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Editing…").font(.system(size: 11)).foregroundStyle(.white.opacity(0.8))
                    }
                }
            }
            Rectangle().fill(Tokens.line).frame(height: 1)
            composer
        }
        .background(Tokens.roux)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Tokens.line, lineWidth: 1))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.text")
                .font(.system(size: 12))
                .foregroundStyle(Tokens.gold)
            VStack(alignment: .leading, spacing: 0) {
                Text(model.doc?.title ?? "")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(1)
                Text(model.doc?.path ?? "")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(Tokens.faint)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 4)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Tokens.faint)
            }
            .buttonStyle(.plain)
            .pointingCursor()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Tokens.surface)
    }

    /// Prompt-to-edit composer — the user types (or speaks via ⌃⌥) a change; the agent
    /// rewrites the document and it refreshes above.
    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Ask for an edit — “fix fact 5”, “add a summary”…", text: $model.draft)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.92))
                .disabled(model.busy)
                .onSubmit(onSubmitEdit)
            if let notice = model.notice {
                Text(notice)
                    .font(.system(size: 9.5))
                    .foregroundStyle(Tokens.alarm.opacity(0.9))
                    .lineLimit(1)
            }
            Button(action: onSubmitEdit) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(model.draft.trimmingCharacters(in: .whitespaces).isEmpty || model.busy ? Tokens.faint : Tokens.ember)
            }
            .buttonStyle(.plain)
            .disabled(model.draft.trimmingCharacters(in: .whitespaces).isEmpty || model.busy)
            .pointingCursor()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Tokens.surface)
    }
}

/// WKWebView over locally generated HTML. No scripts run (none are emitted) and link
/// clicks open in the default browser instead of navigating the panel.
private struct FileWebView: NSViewRepresentable {
    let html: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        view.navigationDelegate = context.coordinator
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loadedHTML != html else { return } // SwiftUI re-renders ≫ content changes
        context.coordinator.loadedHTML = html
        view.loadHTMLString(html, baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedHTML: String?

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }
    }
}

/// Minimal markdown → HTML for agent-written documents: headings, fenced code, lists,
/// blockquotes, rules, paragraphs; bold / italic / inline code / links. Deliberately not
/// a spec-complete parser — a clean dark reading view, escaped-first so content can never
/// inject markup. Non-markdown files render whole as a code block.
enum MarkdownHTML {
    static func page(for doc: PresentedFile) -> String {
        let lower = doc.file.lowercased()
        let isMarkdown = lower.hasSuffix(".md") || lower.hasSuffix(".markdown") || lower.hasSuffix(".mdx")
        let body = isMarkdown ? render(doc.content) : "<pre><code>\(escape(doc.content))</code></pre>"
        return """
        <!DOCTYPE html><html><head><meta charset="utf-8"><style>\(css)</style></head>\
        <body><article>\(body)</article></body></html>
        """
    }

    static func escape(_ s: String) -> String {
        // Quotes must be escaped too: inline() builds <a href="$2"> from this output, and
        // the URL class [^)\s]+ admits a quote — unescaped, it breaks out of the attribute.
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }

    static func render(_ markdown: String) -> String {
        var html: [String] = []
        var paragraph: [String] = []
        var listTag: String? = nil // "ul" | "ol"
        var inCode = false
        var codeLines: [String] = []

        func closeParagraph() {
            if !paragraph.isEmpty {
                html.append("<p>\(inline(paragraph.joined(separator: " ")))</p>")
                paragraph = []
            }
        }
        func closeList() {
            if let tag = listTag {
                html.append("</\(tag)>")
                listTag = nil
            }
        }
        func openList(_ tag: String) {
            if listTag != tag {
                closeList()
                html.append("<\(tag)>")
                listTag = tag
            }
        }

        for rawLine in markdown.components(separatedBy: "\n") {
            if inCode {
                if rawLine.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    html.append("<pre><code>\(codeLines.joined(separator: "\n"))</code></pre>")
                    codeLines = []
                    inCode = false
                } else {
                    codeLines.append(escape(rawLine))
                }
                continue
            }
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                closeParagraph(); closeList()
                inCode = true
                continue
            }
            if line.isEmpty {
                closeParagraph(); closeList()
                continue
            }
            if line == "---" || line == "***" || line == "___" {
                closeParagraph(); closeList()
                html.append("<hr>")
                continue
            }
            let hashes = line.prefix(while: { $0 == "#" }).count
            if hashes >= 1, hashes <= 6, line.dropFirst(hashes).hasPrefix(" ") {
                closeParagraph(); closeList()
                html.append("<h\(hashes)>\(inline(String(line.dropFirst(hashes + 1))))</h\(hashes)>")
                continue
            }
            if line.hasPrefix("> ") || line == ">" {
                closeParagraph(); closeList()
                html.append("<blockquote><p>\(inline(String(line.dropFirst(min(2, line.count)))))</p></blockquote>")
                continue
            }
            if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
                closeParagraph()
                openList("ul")
                html.append("<li>\(inline(String(line.dropFirst(2))))</li>")
                continue
            }
            if let match = line.range(of: #"^\d{1,3}[.)] "#, options: .regularExpression) {
                closeParagraph()
                openList("ol")
                html.append("<li>\(inline(String(line[match.upperBound...])))</li>")
                continue
            }
            paragraph.append(line)
        }
        if inCode { html.append("<pre><code>\(codeLines.joined(separator: "\n"))</code></pre>") }
        closeParagraph()
        closeList()
        return html.joined(separator: "\n")
    }

    /// Inline spans, applied AFTER escaping (code first, so its contents win over emphasis).
    private static func inline(_ text: String) -> String {
        var s = escape(text)
        s = s.replacingOccurrences(of: #"`([^`]+)`"#, with: "<code>$1</code>", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\*\*([^*]+)\*\*"#, with: "<strong>$1</strong>", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\*([^*]+)\*"#, with: "<em>$1</em>", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\[([^\]]+)\]\((https?://[^)\s]+)\)"#, with: "<a href=\"$2\">$1</a>", options: .regularExpression)
        return s
    }

    /// Dark reading theme in the dashboard's design tokens (DesignTokens.swift hexes).
    private static let css = """
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #191411; color: rgba(255,255,255,.85); \
    font: 13px/1.65 -apple-system, 'SF Pro Text', sans-serif; -webkit-font-smoothing: antialiased; }
    article { max-width: 660px; margin: 0 auto; padding: 26px 30px 48px; word-wrap: break-word; }
    h1, h2, h3, h4, h5, h6 { color: #fff; line-height: 1.3; margin: 1.5em 0 .5em; }
    h1 { font-size: 21px; margin-top: .4em; } h2 { font-size: 17px; border-bottom: 1px solid #322A23; padding-bottom: 6px; }
    h3 { font-size: 14.5px; } h4, h5, h6 { font-size: 13px; }
    p { margin: .55em 0; }
    a { color: #FF7A48; text-decoration: none; }
    code { font: 11.5px ui-monospace, 'SF Mono', monospace; background: #201A15; \
    border: 1px solid #322A23; border-radius: 4px; padding: 1px 5px; color: #E0B45A; }
    pre { background: #201A15; border: 1px solid #322A23; border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
    pre code { background: none; border: none; padding: 0; color: rgba(255,255,255,.8); }
    blockquote { margin: .8em 0; padding: 2px 14px; border-left: 3px solid #FF7A48; color: rgba(255,255,255,.6); }
    blockquote p { margin: .3em 0; }
    ul, ol { padding-left: 22px; margin: .55em 0; } li { margin: .25em 0; }
    hr { border: none; border-top: 1px solid #322A23; margin: 1.6em 0; }
    """
}
