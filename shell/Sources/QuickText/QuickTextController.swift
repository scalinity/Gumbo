import AppKit
import SwiftUI

/// Quick text input: ⌃Space opens a single-line, Spotlight-style pill to message Gumbo by text.
/// The typed text is sent as `debug_text` — the same daemon path a voice turn takes — so a pasted
/// prompt drives the orchestrator (and spawns tasks) exactly like speech. Gumbo replies on its
/// normal channels (voice + notch transcript); the box just closes, not a chat log.
///
/// Focus WITHOUT activation: on macOS 26 a background/accessory app can't steal frontmost
/// (cooperative activation refuses it — verified: every activate() left isActive=false while
/// Terminal stayed frontmost). So the box is a `.nonactivatingPanel` + `canBecomeKey` override — it
/// becomes the KEY window and takes keystrokes while the previously-active app stays frontmost. No
/// app activation ⇒ no Dock-icon flash. A global click-away monitor or Esc dismisses it.
final class QuickTextController {
    var onSubmit: ((String) -> Void)?

    private var panel: KeyablePanel?
    private var currentModel: QuickTextModel?
    private var clickMonitor: Any?

    /// ⌃Space toggles: open if closed, close if already showing.
    func toggle() {
        if panel != nil { close() } else { open() }
    }

    private func open() {
        let model = QuickTextModel()
        model.onSend = { [weak self] in
            guard let self, let model = self.currentModel else { return }
            let text = model.text.trimmingCharacters(in: .whitespacesAndNewlines)
            self.close()
            if !text.isEmpty { self.onSubmit?(text) }
        }
        model.onCancel = { [weak self] in self?.close() }
        currentModel = model

        let panel = KeyablePanel(
            contentRect: NSRect(origin: .zero, size: QuickTextView.size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.contentView = NSHostingView(rootView: QuickTextView(model: model))
        position(panel)
        self.panel = panel

        // A .nonactivatingPanel becomes the KEY window and receives keystrokes WITHOUT its owning
        // app becoming frontmost — the escape hatch from macOS 26 cooperative activation, which
        // refuses to let a background/accessory app steal frontmost (diagnostic: every activate()
        // left isActive=false, frontmost=Terminal). So we never activate; we order the panel front
        // (Regardless, since the app is inactive) and make it key directly. No activation ⇒ no flash.
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        panel.makeKey()
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            panel.alphaValue = 1
        } else {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.14
                panel.animator().alphaValue = 1
            }
        }
        // Make the text view first responder. `SendingTextView.viewDidMoveToWindow` is the primary,
        // deterministic handoff; these two passes are cheap idempotent backup in case the SwiftUI
        // representable mounts on a later tick (makeNSView registers `requestFocus`).
        DispatchQueue.main.async { [weak self] in self?.currentModel?.requestFocus?() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.currentModel?.requestFocus?() }
        // Click-away closes — a global mouse-down monitor fires only for clicks in OTHER apps
        // (clicks inside the panel are local events it never sees). Precise, unlike resignKey, which
        // also fired on menubar hover / Spaces changes and dismissed the box out from under the user.
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.close()
        }
    }

    private func close() {
        guard let panel else { return }
        self.panel = nil
        currentModel = nil
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
        panel.orderOut(nil)
    }

    /// Centered horizontally, upper third of the notch display — the Spotlight resting spot.
    private func position(_ panel: NSPanel) {
        guard let screen = NSScreen.gumboHome else { return }
        let size = QuickTextView.size
        let x = screen.frame.midX - size.width / 2
        let y = screen.frame.minY + screen.frame.height * 0.62
        panel.setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: true)
    }
}

/// Borderless panels return `canBecomeKey == false` by default, which would make the text field
/// unfocusable. Overriding it — together with the `.nonactivatingPanel` style — is what lets the
/// panel take keyboard focus without the app becoming active.
private final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class QuickTextModel: ObservableObject {
    @Published var text: String = ""
    var onSend: (() -> Void)?
    var onCancel: (() -> Void)?
    var requestFocus: (() -> Void)? // set by the editor; makes its NSTextView first responder
    func send() { onSend?() }
    func cancel() { onCancel?() }
}

/// Single-line, Spotlight-style pill — one text row, black fill, fully rounded ends (Capsule),
/// thin line border. No key-hint row (the shortcuts are self-evident) and no growth: long/multi-
/// line pastes scroll rather than resize the box. The editor fills the pill's height and the single
/// line is centered *inside* the NSTextView (vertical textContainerInset); the placeholder is drawn
/// there too (see `SendingTextView`), so caret, text, and placeholder share one centered origin.
struct QuickTextView: View {
    static let size = NSSize(width: 360, height: 48)

    let model: QuickTextModel

    var body: some View {
        QuickTextEditor(model: model)
            .padding(.horizontal, 22)
            .frame(width: Self.size.width, height: Self.size.height)
            .background(
                Capsule()
                    .fill(Color.black)
                    .overlay(Capsule().strokeBorder(Tokens.line, lineWidth: 1))
            )
            .clipShape(Capsule())
    }
}

/// A raw `NSTextView` (not SwiftUI `TextEditor`) is what buys exact key control: ⏎ sends,
/// ⇧⏎ inserts a newline, Esc cancels. Paste never triggers a Return keystroke, so multi-line
/// prompts paste in whole and only a real ⏎ press submits. `lineFragmentPadding = 0` makes the
/// caret, typed text, and the drawn placeholder all start at the same x (default is 5px).
private struct QuickTextEditor: NSViewRepresentable {
    @ObservedObject var model: QuickTextModel

    func makeNSView(context: Context) -> NSScrollView {
        let textView = SendingTextView()
        textView.onSend = { [weak model] in model?.send() }
        textView.onCancel = { [weak model] in model?.cancel() }
        textView.placeholder = "Message Gumbo…"
        textView.delegate = context.coordinator
        textView.font = .systemFont(ofSize: 15)
        textView.textColor = NSColor.white.withAlphaComponent(0.95)
        textView.insertionPointColor = NSColor(Tokens.ember)
        textView.drawsBackground = false
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.allowsUndo = true
        textView.textContainer?.lineFragmentPadding = 0
        // Vertically center the single line in the pill: inset top (and bottom) by half the slack
        // between the box height and one line. The caret and placeholder both key off this inset,
        // so they center together — the horizontal midline bisects the caret.
        let lineHeight = textView.layoutManager?.defaultLineHeight(for: textView.font ?? .systemFont(ofSize: 15)) ?? 18
        let vInset = max(0, (QuickTextView.size.height - lineHeight) / 2)
        textView.textContainerInset = NSSize(width: 0, height: vInset)
        // Single visual line, horizontal scroll (no wrap) so a long line slides like Spotlight
        // instead of wrapping into the clipped area below.
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = true
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.size = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)

        // Let the controller focus us once we're in a key window (SwiftUI's own focus pass is
        // unreliable for an NSViewRepresentable inside a borderless panel).
        model.requestFocus = { [weak textView] in
            guard let textView, let window = textView.window else { return }
            window.makeFirstResponder(textView)
        }

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.documentView = textView
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        private let model: QuickTextModel
        init(model: QuickTextModel) { self.model = model }
        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            model.text = tv.string
        }
    }
}

private final class SendingTextView: NSTextView {
    var onSend: (() -> Void)?
    var onCancel: (() -> Void)?
    var placeholder = ""

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36 || event.keyCode == 76 // Return / keypad Enter
        if isReturn && !event.modifierFlags.contains(.shift) {
            onSend?()
            return
        }
        if event.keyCode == 53 { // Escape
            onCancel?()
            return
        }
        super.keyDown(with: event) // ⇧⏎ newline, typing, ⌘V paste
    }

    // Grab first responder the moment we're placed in the (already-key) window — a deterministic
    // post-mount hook, unlike the controller's requestFocus which can fire before makeNSView runs.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.window?.makeFirstResponder(self)
        }
    }

    // Toggle the placeholder as content empties/fills.
    override func didChangeText() {
        super.didChangeText()
        needsDisplay = true
    }

    // Draw the placeholder in the text view's own coordinate space, at the exact origin the caret
    // and typed text use (the vertical textContainerInset that centers the line, plus the zeroed
    // lineFragmentPadding), so it can never drift from the caret the way a separate overlay did.
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 15),
            .foregroundColor: NSColor(Tokens.faint),
        ]
        let x = textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0)
        placeholder.draw(at: NSPoint(x: x, y: textContainerInset.height), withAttributes: attrs)
    }
}
