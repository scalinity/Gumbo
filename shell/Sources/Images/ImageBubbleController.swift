import AppKit
import SwiftUI

/// M5.5: incoming generated images surface as thumbnail bubbles in the same top-right
/// column as the task orbs — stacked directly beneath them (BubbleController reports its
/// stack bottom after every layout). Click a thumbnail to open the full-resolution
/// viewer/editor. An edited version REPLACES its parent's thumbnail in place, so an edit
/// loop doesn't grow a tower; thumbs expire after a linger (the dashboard gallery is the
/// durable home) or via the hover ✕.
final class ImageBubbleController {
    var onOpen: ((String) -> Void)?

    static let thumbSize = NSSize(width: 148, height: 104)
    private static let lingerSeconds: TimeInterval = 600
    private static let maxThumbs = 3

    private struct Thumb {
        let panel: NSPanel
        let model: ThumbModel
        var expiry: DispatchWorkItem?
    }

    private var thumbs: [String: Thumb] = [:] // keyed by image filename
    private var order: [String] = [] // stacking order, newest on top
    private var stackBottom: CGFloat? // y just below the task-orb stack
    private let margin: CGFloat = 10
    private let gap: CGFloat = 10

    /// From BubbleController via GumboController: the orb stack moved — restack under it.
    func setStackBottom(_ y: CGFloat) {
        stackBottom = y
        layout()
    }

    /// A new image landed (image.created). An edit takes its parent's slot; a fresh
    /// image stacks on top. Oldest thumbs beyond the cap fade out.
    func present(file: String, editedFrom: String?) {
        if let parent = editedFrom, let slot = order.firstIndex(of: parent) {
            removeThumb(parent)
            insert(file: file, at: min(slot, order.count))
        } else if thumbs[file] == nil {
            insert(file: file, at: 0)
        }
        while order.count > Self.maxThumbs, let oldest = order.last {
            removeThumb(oldest)
        }
    }

    func dismiss(file: String) {
        removeThumb(file)
    }

    private func insert(file: String, at index: Int) {
        let model = ThumbModel(file: file)
        let panel = makePanel(model: model, file: file)
        thumbs[file] = Thumb(panel: panel, model: model)
        order.insert(file, at: index)
        panel.setFrame(NSRect(origin: origin(forIndex: index), size: Self.thumbSize), display: false)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        panel.animator().alphaValue = 1
        ImageFetch.load(file: file) { image in model.image = image }
        scheduleExpiry(file)
        layout()
    }

    private func removeThumb(_ file: String) {
        guard let thumb = thumbs.removeValue(forKey: file) else { return }
        thumb.expiry?.cancel()
        order.removeAll { $0 == file }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.3
            thumb.panel.animator().alphaValue = 0
        }, completionHandler: {
            thumb.panel.orderOut(nil)
            thumb.panel.close()
        })
        layout()
    }

    private func scheduleExpiry(_ file: String) {
        thumbs[file]?.expiry?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.removeThumb(file) }
        thumbs[file]?.expiry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.lingerSeconds, execute: work)
    }

    private func makePanel(model: ThumbModel, file: String) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.thumbSize),
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
            rootView: ImageThumbView(
                model: model,
                onOpen: { [weak self] in self?.onOpen?(file) },
                onDismiss: { [weak self] in self?.removeThumb(file) }))
        return panel
    }

    private func origin(forIndex index: Int) -> NSPoint {
        guard let screen = NSScreen.gumboHome else { return .zero }
        let visible = screen.visibleFrame
        let top = (stackBottom ?? visible.maxY - margin) - CGFloat(index) * (Self.thumbSize.height + gap)
        return NSPoint(x: visible.maxX - Self.thumbSize.width - margin, y: top - Self.thumbSize.height)
    }

    private func layout() {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.26
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            for (index, file) in order.enumerated() {
                guard let thumb = thumbs[file] else { continue }
                thumb.panel.animator().setFrame(
                    NSRect(origin: origin(forIndex: index), size: Self.thumbSize), display: true)
            }
        }
    }
}

/// Loads gallery images off the daemon's /files route (loopback). Filenames are
/// validated to the generated-image shape before touching the URL.
enum ImageFetch {
    static func load(file: String, completion: @escaping (NSImage?) -> Void) {
        guard file.range(of: #"^[\w-]+\.png$"#, options: .regularExpression) != nil,
              let url = URL(string: "http://127.0.0.1:8737/files/images/\(file)") else {
            completion(nil)
            return
        }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            let image = data.flatMap(NSImage.init(data:))
            DispatchQueue.main.async { completion(image) }
        }.resume()
    }
}

final class ThumbModel: ObservableObject {
    let file: String
    @Published var image: NSImage?

    init(file: String) {
        self.file = file
    }
}

private struct ImageThumbView: View {
    @ObservedObject var model: ThumbModel
    let onOpen: () -> Void
    let onDismiss: () -> Void
    @State private var hovering = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image = model.image {
                    Image(nsImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    ZStack {
                        Tokens.surface
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .frame(width: ImageBubbleController.thumbSize.width - 8,
                   height: ImageBubbleController.thumbSize.height - 8)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(hovering ? Tokens.ember : Tokens.line, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .onTapGesture(perform: onOpen)
            .pointingCursor()

            if hovering {
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(.white.opacity(0.85), .black.opacity(0.55))
                }
                .buttonStyle(.plain)
                .padding(6)
                .pointingCursor()
            }
        }
        .frame(width: ImageBubbleController.thumbSize.width,
               height: ImageBubbleController.thumbSize.height)
        .onHover { hovering = $0 }
    }
}
