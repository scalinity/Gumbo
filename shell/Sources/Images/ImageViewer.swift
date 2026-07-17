import AppKit
import SwiftUI

/// M5.5: the enlarged image viewer/editor. Opens from a thumbnail at full resolution,
/// carries a brush select tool (paint the area to change — bright inside, dimmed
/// outside), and takes edit requests two ways: typed into the composer here, or spoken
/// through the normal ⌃⌥ push-to-talk (the viewer arms an `image_context` on the daemon
/// — open file + strokes — so a voice edit needs no coordinates). Every edit arrives as
/// a NEW version (image.created with edited_from) and the viewer swaps to it in place.
final class ImageViewerController {
    /// WS sender, wired to WSClient by GumboController.
    var onSend: (([String: Any]) -> Void)?

    private var panel: ImageViewerPanel?
    private let model = ViewerModel()

    func open(file: String) {
        model.reset(file: file)
        sendContext()
        loadImage(file)
        showPanel()
    }

    /// Load the full-res image; a failed fetch surfaces a notice instead of an eternal
    /// spinner (review 🔵).
    private func loadImage(_ file: String) {
        ImageFetch.load(file: file) { [weak self] image in
            guard let self, self.model.file == file else { return }
            self.model.image = image
            if image == nil { self.model.notice = "Couldn't load the image" }
            self.sizePanel(for: image)
        }
    }

    func close() {
        guard panel != nil else { return }
        model.file = nil
        onSend?(["type": "image_context", "file": NSNull()])
        panel?.orderOut(nil)
    }

    /// image.created from the event fan-out: if it's an edit of the open image, swap to
    /// the new version in place (selection cleared — it applied to the old pixels).
    func handleCreated(file: String, editedFrom: String?) {
        guard let current = model.file, current == editedFrom else { return }
        model.reset(file: file)
        sendContext()
        loadImage(file)
    }

    /// image.edit_requested: an edit is running against a file — if it's the one open
    /// here, show the busy state even when the edit was started by VOICE (live gap
    /// 2026-07-16: only the panel's own typed submits ever set busy).
    func handleEditRequested(file: String) {
        guard model.file == file, !model.busy else { return }
        model.busy = true
        model.notice = nil
    }

    /// image.edit_failed: leave the busy state with an honest notice (the daemon also
    /// speaks the failure).
    func handleEditFailed(file: String) {
        guard model.file == file else { return }
        model.busy = false
        model.notice = "Edit failed — try again"
    }

    /// WS (re)connected: the daemon's in-memory context died with it — re-arm so a voice
    /// edit keeps targeting the image that is visibly open (review 🟡, corroborated).
    func resendContext() {
        guard model.file != nil else { return }
        sendContext()
    }

    // MARK: internals

    private func showPanel() {
        if panel == nil {
            let panel = ImageViewerPanel(
                contentRect: NSRect(origin: .zero, size: NSSize(width: 560, height: 480)),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered, defer: false)
            panel.level = .statusBar
            panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = true
            panel.isMovable = true
            // NOT movable-by-background: window-background drags were winning against
            // the brush-size slider's drag (live gripe 2026-07-16 — "it drags the whole
            // window"). The header is the explicit drag handle instead (WindowDragHandle).
            panel.isMovableByWindowBackground = false
            panel.hidesOnDeactivate = false
            panel.isReleasedWhenClosed = false
            panel.animationBehavior = .none
            panel.becomesKeyOnlyIfNeeded = true // key arrives when the composer is clicked
            panel.contentView = FirstMouseHostingView(
                rootView: ImageViewerView(
                    model: model,
                    onSelectionChange: { [weak self] in self?.sendContext() },
                    onSubmitEdit: { [weak self] in self?.submitEdit() },
                    onClose: { [weak self] in self?.close() }))
            self.panel = panel
        }
        if let image = model.image { sizePanel(for: image) } else { position() }
        panel?.orderFrontRegardless()
    }

    /// Fit the panel to the image's aspect ratio inside ~65 % × 80 % of the visible
    /// frame, plus the chrome height — the image area then IS the fitted image, which
    /// keeps brush-coordinate mapping trivial (view point ÷ view size = normalized).
    private func sizePanel(for image: NSImage?) {
        guard let screen = NSScreen.gumboHome else { return }
        let visible = screen.visibleFrame
        let maxImage = NSSize(width: visible.width * 0.65, height: visible.height * 0.8 - ViewerChrome.height)
        let pixels = image?.size ?? NSSize(width: 1536, height: 1024)
        var scale = min(maxImage.width / pixels.width, maxImage.height / pixels.height, 1)
        // Enforce the minimum by scaling BOTH dimensions: independent per-axis clamps
        // would break the area's aspect, letterbox the image inside the overlay, and
        // shift brush coordinates off the daemon's mask (review 🔵, corroborated).
        scale = max(scale, 320 / pixels.width, 220 / pixels.height)
        let imageSize = NSSize(width: pixels.width * scale, height: pixels.height * scale)
        model.imageAreaSize = imageSize
        let size = NSSize(width: imageSize.width, height: imageSize.height + ViewerChrome.height)
        position(size: size)
    }

    private func position(size: NSSize? = nil) {
        guard let screen = NSScreen.gumboHome, let panel else { return }
        let visible = screen.visibleFrame
        let s = size ?? panel.frame.size
        // Anchored toward the top-right — it expands out of the thumbnail column.
        let origin = NSPoint(
            x: visible.maxX - s.width - ImageBubbleController.thumbSize.width - 24,
            y: visible.maxY - s.height - 14)
        panel.setFrame(NSRect(origin: origin, size: s), display: true)
    }

    private func sendContext() {
        guard let file = model.file else { return }
        onSend?([
            "type": "image_context",
            "file": file,
            "strokes": model.strokes.map { $0.wireForm },
        ])
    }

    private func submitEdit() {
        guard let file = model.file, !model.busy else { return }
        let prompt = model.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        model.busy = true
        model.notice = nil
        model.prompt = ""
        onSend?([
            "type": "image_edit_request",
            "file": file,
            "prompt": prompt,
            "strokes": model.strokes.map { $0.wireForm },
        ])
        // Local failsafe: if neither image.created nor image.edit_failed ever arrives
        // (daemon died mid-edit), don't spin forever. Generation-scoped (review 🔵):
        // a (file, busy) check alone would let a stale timer from a failed first edit
        // fire into a retry on the same file with a false "No result".
        model.editGeneration += 1
        let generation = model.editGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 240) { [weak self] in
            guard let self, self.model.editGeneration == generation, self.model.busy else { return }
            self.model.busy = false
            self.model.notice = "No result — check the dashboard"
        }
    }
}

/// Borderless non-activating panels refuse key status by default; the composer text
/// field needs it (Spotlight-style: key without activating the app).
private final class ImageViewerPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// Explicit window-move affordance for the header row. Replaces
/// isMovableByWindowBackground, which routed drags ANYWHERE the hit view didn't claim
/// them — including losing races against the brush-size slider (live gripe 2026-07-16).
private struct WindowDragHandle: NSViewRepresentable {
    final class DragView: NSView {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func mouseDown(with event: NSEvent) {
            window?.performDrag(with: event)
        }
    }

    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

enum ViewerChrome {
    /// Header + controls + composer rows around the image area.
    static let height: CGFloat = 132
}

// MARK: - model

/// One brush stroke in image-normalized coordinates (0–1, origin top-left); radius is
/// normalized to image WIDTH — the exact vocabulary the daemon's mask rasterizer speaks.
struct BrushStroke {
    /// Mirror of the daemon's caps (mask.ts MAX_POINTS_PER_STROKE / MAX_STROKES). The
    /// daemon CLAMPS past these, so exceeding them shell-side would silently mask less
    /// than the user drew (review 🔴) — cap at the source instead so drawn == masked.
    static let maxPoints = 2000
    static let maxStrokes = 200

    var points: [CGPoint]
    var radius: Double

    var wireForm: [String: Any] {
        ["points": points.map { [Double($0.x), Double($0.y)] }, "radius": radius]
    }
}

final class ViewerModel: ObservableObject {
    @Published var file: String?
    @Published var image: NSImage?
    @Published var imageAreaSize = NSSize(width: 560, height: 372)
    @Published var strokes: [BrushStroke] = []
    @Published var liveStroke: BrushStroke?
    @Published var brushRadius: Double = 0.04
    @Published var prompt = ""
    @Published var busy = false
    @Published var notice: String?
    /// Monotonic edit counter — scopes the submit failsafe to its own edit (review 🔵).
    var editGeneration = 0

    func reset(file: String) {
        self.file = file
        image = nil
        strokes = []
        liveStroke = nil
        busy = false
        notice = nil
    }
}

// MARK: - view

private let roux = Tokens.roux
private let surface = Tokens.surface
private let line = Tokens.line
private let ember = Tokens.ember
private let gold = Tokens.gold
private let faint = Tokens.faint
private let alarm = Tokens.alarm

private struct ImageViewerView: View {
    @ObservedObject var model: ViewerModel
    let onSelectionChange: () -> Void
    let onSubmitEdit: () -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(line).frame(height: 1)
            imageArea
            Rectangle().fill(line).frame(height: 1)
            controls
            composer
        }
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(LinearGradient(colors: [surface, roux], startPoint: .top, endPoint: .bottom))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(line, lineWidth: 1)))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var header: some View {
        // The drag handle is the BOTTOM layer of a ZStack and the passive content
        // (icon, title, notice) is marked non-hit-testing, so a mouseDown on the header
        // reaches the NSView and starts a window drag. Only the close Button keeps its
        // own hits. (The earlier `.background(WindowDragHandle())` never received the
        // click — a `.contentShape(Rectangle())` above it made SwiftUI eat the mouseDown
        // first, so the header looked draggable but wasn't — live gripe 2026-07-16.)
        ZStack {
            WindowDragHandle().frame(maxWidth: .infinity, maxHeight: .infinity) // fill the header (an NSView has no intrinsic size)
            // Passive labels — non-hit-testing so mouseDown falls through to the drag view.
            HStack(spacing: 8) {
                Image(systemName: "photo")
                    .font(.system(size: 11))
                    .foregroundStyle(ember)
                Text(model.busy ? "Editing…" : "Image")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
                if model.busy {
                    ProgressView().controlSize(.small).padding(.leading, 2)
                }
                if let notice = model.notice {
                    Text(notice)
                        .font(.system(size: 10.5))
                        .foregroundStyle(alarm)
                }
                Spacer()
            }
            .allowsHitTesting(false)
            // The one interactive control — kept above the drag layer.
            HStack {
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(faint)
                }
                .buttonStyle(.plain)
                .pointingCursor()
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 36)
    }

    private var imageArea: some View {
        ZStack {
            if let image = model.image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                BrushOverlay(model: model, onSelectionChange: onSelectionChange)
            } else if model.notice == nil {
                ProgressView() // still loading; a failed load shows the header notice instead
            }
        }
        .frame(width: model.imageAreaSize.width, height: model.imageAreaSize.height)
        .background(Color.black.opacity(0.35))
        .clipped()
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Image(systemName: "paintbrush.pointed")
                .font(.system(size: 10))
                .foregroundStyle(model.strokes.isEmpty && model.liveStroke == nil ? faint : gold)
            Slider(value: $model.brushRadius, in: 0.01...0.12)
                .controlSize(.small)
                .frame(width: 140)
                .help("Brush size")
            if !model.strokes.isEmpty {
                Button("Clear") {
                    model.strokes = []
                    model.liveStroke = nil
                    onSelectionChange()
                }
                .buttonStyle(.plain)
                .font(.system(size: 10.5))
                .foregroundStyle(faint)
                .pointingCursor()
            }
            Spacer()
            Text(model.strokes.isEmpty ? "Paint an area to scope the edit — or edit the whole image" : "Edit applies to the highlighted area")
                .font(.system(size: 10))
                .foregroundStyle(faint)
            Text("⌃⌥ speak works too")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(gold.opacity(0.85))
        }
        .padding(.horizontal, 14)
        .frame(height: 34)
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Describe the edit…", text: $model.prompt)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.92))
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 8).fill(roux.opacity(0.8)))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(line, lineWidth: 1))
                .onSubmit(onSubmitEdit)
                .disabled(model.busy)
            Button(action: onSubmitEdit) {
                Text("Edit")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(model.busy ? faint : Color(red: 0.10, green: 0.05, blue: 0.03))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 8).fill(model.busy ? surface : ember))
            }
            .buttonStyle(.plain)
            .disabled(model.busy)
            .pointingCursor()
        }
        .padding(.horizontal, 12)
        .frame(height: 48)
    }
}

/// The select tool: drag to paint round-capped strokes over the image. Selected area
/// stays at full brightness while everything else dims (the dim layer is punched out
/// with destination-clear strokes), plus a thin gold rim so faint selections still read.
/// Coordinates are normalized against the overlay's size — which is exactly the fitted
/// image, because the panel is sized to the image's aspect ratio.
private struct BrushOverlay: View {
    @ObservedObject var model: ViewerModel
    let onSelectionChange: () -> Void

    var body: some View {
        GeometryReader { geo in
            let size = geo.size
            Canvas { context, canvasSize in
                let all = model.strokes + (model.liveStroke.map { [$0] } ?? [])
                guard !all.isEmpty else { return }
                // Gold rim first (slightly wider), then dim, then punch the selection
                // clear — the rim survives as a halo around the bright region.
                for stroke in all {
                    draw(stroke, in: &context, size: canvasSize, widthBonus: 5,
                         shading: .color(gold.opacity(0.9)))
                }
                context.fill(Path(CGRect(origin: .zero, size: canvasSize)),
                             with: .color(.black.opacity(0.42)))
                context.blendMode = .clear
                for stroke in all {
                    draw(stroke, in: &context, size: canvasSize, widthBonus: 0, shading: .color(.white))
                }
            }
            .allowsHitTesting(!model.busy)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let point = CGPoint(
                            x: min(1, max(0, value.location.x / size.width)),
                            y: min(1, max(0, value.location.y / size.height)))
                        if var live = model.liveStroke {
                            // Thin the polyline: only keep points that actually moved,
                            // and never outgrow what the daemon will accept verbatim.
                            guard live.points.count < BrushStroke.maxPoints else { return }
                            if let last = live.points.last,
                               abs(last.x - point.x) * size.width < 2.5,
                               abs(last.y - point.y) * size.height < 2.5 { return }
                            live.points.append(point)
                            model.liveStroke = live
                        } else {
                            model.liveStroke = BrushStroke(points: [point], radius: model.brushRadius)
                        }
                    }
                    .onEnded { _ in
                        if let live = model.liveStroke {
                            if model.strokes.count < BrushStroke.maxStrokes {
                                model.strokes.append(live)
                            }
                            model.liveStroke = nil
                            onSelectionChange()
                        }
                    })
        }
    }

    private func draw(_ stroke: BrushStroke, in context: inout GraphicsContext, size: CGSize, widthBonus: CGFloat, shading: GraphicsContext.Shading) {
        let width = CGFloat(stroke.radius) * 2 * size.width + widthBonus
        let points = stroke.points.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) }
        guard let first = points.first else { return }
        if points.count == 1 {
            // A tap: the daemon stamps a circle — draw the same thing.
            let r = width / 2
            context.fill(Path(ellipseIn: CGRect(x: first.x - r, y: first.y - r, width: r * 2, height: r * 2)), with: shading)
            return
        }
        var path = Path()
        path.move(to: first)
        for point in points.dropFirst() { path.addLine(to: point) }
        context.stroke(path, with: shading, style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
    }
}
