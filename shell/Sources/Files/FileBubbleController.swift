import AppKit
import SwiftUI

/// A file the voice agent presented (file_present) — a spec, doc, or report a task
/// produced. One document card per file in the same top-right column as the task orbs
/// and image thumbnails, stacked beneath the images (each layer reports its stack
/// bottom). Clicking a card opens the file in Gumbo's own renderer (FileViewer) — never
/// a system text editor.
struct PresentedFile {
    let title: String
    let file: String // filename, drives markdown-vs-code rendering by extension
    let path: String // where it lives on disk (shown as the card/viewer subtitle)
    let content: String
}

final class FileBubbleController {
    var onOpen: ((PresentedFile) -> Void)?

    static let cardSize = NSSize(width: 148, height: 58)
    private static let lingerSeconds: TimeInterval = 600
    private static let maxCards = 3

    private struct Card {
        let panel: NSPanel
        let doc: PresentedFile
        var expiry: DispatchWorkItem?
    }

    private var cards: [String: Card] = [:] // keyed by path
    private var order: [String] = [] // stacking order, newest on top
    private var stackBottom: CGFloat? // y just below the image-thumb stack
    private let margin: CGFloat = 10
    private let gap: CGFloat = 10

    /// From ImageBubbleController via GumboController: the stack above moved — restack.
    func setStackBottom(_ y: CGFloat) {
        stackBottom = y
        layout()
    }

    /// A presented file. Re-presenting the same path replaces the card in place (fresh
    /// content, fresh linger) rather than stacking a duplicate.
    func present(_ doc: PresentedFile) {
        if let slot = order.firstIndex(of: doc.path) {
            removeCard(doc.path)
            insert(doc, at: min(slot, order.count))
        } else {
            insert(doc, at: 0)
        }
        while order.count > Self.maxCards, let oldest = order.last {
            removeCard(oldest)
        }
    }

    private func insert(_ doc: PresentedFile, at index: Int) {
        let panel = makePanel(doc: doc)
        cards[doc.path] = Card(panel: panel, doc: doc)
        order.insert(doc.path, at: index)
        panel.setFrame(NSRect(origin: origin(forIndex: index), size: Self.cardSize), display: false)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        panel.animator().alphaValue = 1
        scheduleExpiry(doc.path)
        layout()
    }

    private func removeCard(_ path: String) {
        guard let card = cards.removeValue(forKey: path) else { return }
        card.expiry?.cancel()
        order.removeAll { $0 == path }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.3
            card.panel.animator().alphaValue = 0
        }, completionHandler: {
            card.panel.orderOut(nil)
            card.panel.close()
        })
        layout()
    }

    private func scheduleExpiry(_ path: String) {
        cards[path]?.expiry?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.removeCard(path) }
        cards[path]?.expiry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.lingerSeconds, execute: work)
    }

    private func makePanel(doc: PresentedFile) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.cardSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.contentView = FirstMouseHostingView(
            rootView: FileCardView(
                doc: doc,
                onOpen: { [weak self] in self?.onOpen?(doc) },
                onDismiss: { [weak self] in self?.removeCard(doc.path) }))
        return panel
    }

    private func origin(forIndex index: Int) -> NSPoint {
        guard let screen = NSScreen.gumboHome else { return .zero }
        let visible = screen.visibleFrame
        let top = (stackBottom ?? visible.maxY - margin) - CGFloat(index) * (Self.cardSize.height + gap)
        return NSPoint(x: visible.maxX - Self.cardSize.width - margin, y: top - Self.cardSize.height)
    }

    private func layout() {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.26
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            for (index, path) in order.enumerated() {
                guard let card = cards[path] else { continue }
                card.panel.animator().setFrame(
                    NSRect(origin: origin(forIndex: index), size: Self.cardSize), display: true)
            }
        }
    }
}

private struct FileCardView: View {
    let doc: PresentedFile
    let onOpen: () -> Void
    let onDismiss: () -> Void
    @State private var hovering = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            HStack(spacing: 8) {
                Image(systemName: "doc.text")
                    .font(.system(size: 15))
                    .foregroundStyle(Tokens.gold)
                VStack(alignment: .leading, spacing: 1) {
                    Text(doc.title)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.9))
                        .lineLimit(2)
                    Text(doc.file)
                        .font(.system(size: 8.5, design: .monospaced))
                        .foregroundStyle(Tokens.faint)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(width: Self.inner.width, height: Self.inner.height)
            .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.surface))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(hovering ? Tokens.ember : Tokens.line, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .onTapGesture(perform: onOpen)
            .pointingCursor()

            if hovering {
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.85), .black.opacity(0.55))
                }
                .buttonStyle(.plain)
                .padding(4)
                .pointingCursor()
            }
        }
        .frame(width: FileBubbleController.cardSize.width,
               height: FileBubbleController.cardSize.height)
        .onHover { hovering = $0 }
    }

    private static let inner = NSSize(width: FileBubbleController.cardSize.width - 8,
                                      height: FileBubbleController.cardSize.height - 8)
}
