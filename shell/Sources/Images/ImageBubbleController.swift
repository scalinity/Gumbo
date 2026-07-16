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
    /// Reports the y just below the thumbnail stack after every layout, so the presented-
    /// file cards (FileBubbleController) can stack beneath the images — the same chaining
    /// BubbleController does for this layer.
    var onStackBottomChange: ((CGFloat) -> Void)?

    static let thumbSize = NSSize(width: 148, height: 104)
    private static let lingerSeconds: TimeInterval = 600
    private static let maxThumbs = 3

    private struct Thumb {
        let panel: NSPanel
        let model: ThumbModel
        var expiry: DispatchWorkItem?
    }

    private var thumbs: [String: Thumb] = [:] // keyed by filename, or "gen:<id>"/"edit:<file>" for in-flight work
    private var order: [String] = [] // stacking order, newest on top
    private var stackBottom: CGFloat? // y just below the task-orb stack
    private let margin: CGFloat = 10
    private let gap: CGFloat = 10

    /// From BubbleController via GumboController: the orb stack moved — restack under it.
    func setStackBottom(_ y: CGFloat) {
        stackBottom = y
        layout()
    }

    /// In-flight work (image.generating / image.edit_requested): a breathing orb holds
    /// the slot so the user SEES the render running (live gap 2026-07-16: a generation died
    /// silently and there was nothing on screen to even suggest it had started). The orb
    /// morphs into the thumbnail on image.created, or flips failed and fades.
    func beginWork(key: String) {
        guard thumbs[key] == nil else { return }
        insert(key: key, file: nil, at: 0)
        trim()
    }

    /// image.generate_failed / image.edit_failed: show the failure mark briefly (the
    /// daemon speaks the details), then fade the slot out.
    func failWork(key: String) {
        guard let thumb = thumbs[key] else { return }
        thumb.model.working = false
        thumb.model.failed = true
        thumbs[key]?.expiry?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.removeThumb(key) }
        thumbs[key]?.expiry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
    }

    /// A new image landed (image.created). Its generating orb (matched by gen_id) or its
    /// edit placeholder morphs into the thumbnail in place; otherwise an edit takes its
    /// parent's slot and a fresh image stacks on top. Oldest beyond the cap fade out.
    func present(file: String, editedFrom: String?, genId: String?) {
        if let genId, thumbs["gen:" + genId] != nil {
            morph(key: "gen:" + genId, into: file)
        } else if let parent = editedFrom {
            if thumbs["edit:" + parent] != nil {
                morph(key: "edit:" + parent, into: file)
                removeThumb(parent) // the new version supersedes the source thumb if it's still up
            } else if let slot = order.firstIndex(of: parent) {
                removeThumb(parent)
                insert(key: file, file: file, at: min(slot, order.count))
            } else if thumbs[file] == nil {
                insert(key: file, file: file, at: 0)
            }
        } else if thumbs[file] == nil {
            insert(key: file, file: file, at: 0)
        }
        trim()
    }

    func dismiss(file: String) {
        removeThumb(file)
    }

    private func trim() {
        while order.count > Self.maxThumbs, let oldest = order.last {
            removeThumb(oldest)
        }
    }

    /// Work orb → thumbnail, keeping the panel and slot (no flicker, no restack jump).
    private func morph(key: String, into file: String) {
        guard let thumb = thumbs.removeValue(forKey: key) else { return }
        thumbs[file] = thumb
        if let index = order.firstIndex(of: key) { order[index] = file }
        thumb.model.file = file
        thumb.model.working = false
        ImageFetch.load(file: file) { image in
            thumb.model.image = image
            thumb.model.failed = image == nil
        }
        scheduleExpiry(file) // fresh linger from the moment it landed
    }

    private func insert(key: String, file: String?, at index: Int) {
        let model = ThumbModel(key: key, file: file)
        let panel = makePanel(model: model, key: key)
        thumbs[key] = Thumb(panel: panel, model: model)
        order.insert(key, at: index)
        panel.setFrame(NSRect(origin: origin(forIndex: index), size: Self.thumbSize), display: false)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        panel.animator().alphaValue = 1
        if let file {
            ImageFetch.load(file: file) { image in
                model.image = image
                model.failed = image == nil
            }
        }
        scheduleExpiry(key)
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

    private func makePanel(model: ThumbModel, key: String) -> NSPanel {
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
                // Read the file at CLICK time — a work orb has none yet, and a morph
                // rewrites it in place (the closure must open the landed image).
                onOpen: { [weak self] in
                    if let file = model.file { self?.onOpen?(file) }
                },
                onDismiss: { [weak self] in self?.removeThumb(model.file ?? key) }))
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
        let top = stackBottom ?? ((NSScreen.gumboHome?.visibleFrame.maxY ?? 0) - margin)
        onStackBottomChange?(top - CGFloat(order.count) * (Self.thumbSize.height + gap))
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
    let key: String
    @Published var file: String? // nil while the render is still working (orb phase)
    @Published var image: NSImage?
    @Published var failed = false // work or fetch failed — show a broken-image mark, not an eternal spinner
    @Published var working: Bool
    /// Drives the same plasma orb the task bubbles use — "generating" wears the running
    /// ember look, so in-flight renders read exactly like other live work.
    let orb = BubbleModel(title: "", status: "running")

    init(key: String, file: String?) {
        self.key = key
        self.file = file
        self.working = file == nil
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
                        if model.failed {
                            Image(systemName: "photo.badge.exclamationmark")
                                .font(.system(size: 16))
                                .foregroundStyle(Tokens.faint)
                        } else if model.working {
                            // The render is running: the same breathing ember orb the
                            // task bubbles use, morphing into the image when it lands.
                            OrbView(model: model.orb, diameter: 40)
                        } else {
                            ProgressView().controlSize(.small)
                        }
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
