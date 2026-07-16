import SwiftUI
import DynamicNotchKit

enum NotchState: String {
    case idle, listening, thinking, speaking
}

/// The notch presence: simmer bars + a live transcript line, shown while a session is
/// active (listening / thinking / speaking) and hidden when idle. Click → dashboard.
/// DynamicNotchKit 1.1.0 pinned — proven on this macOS 27.0 beta (spike 2).
final class NotchController {
    var onTap: (() -> Void)? {
        get { model.onTap }
        set { model.onTap = newValue }
    }

    private let model = NotchModel()
    private var notch: DynamicNotch<NotchContentView, EmptyView, EmptyView>?
    private var visible = false
    private var hideWork: DispatchWorkItem?
    private var pulseWork: DispatchWorkItem?
    private var clickCatcher: NSPanel?
    private var screenObserver: NSObjectProtocol?

    /// The expanded panel's tap gesture only exists while the panel is showing — the bare
    /// hardware notch is a dead black rect. This keeps an invisible, non-activating panel
    /// over the notch permanently, so clicking it opens the dashboard anytime.
    func installClickCatcher() {
        positionClickCatcher()
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            self?.positionClickCatcher()
        }
    }

    private func positionClickCatcher() {
        guard let screen = NSScreen.gumboHome,
              let left = screen.auxiliaryTopLeftArea,
              let right = screen.auxiliaryTopRightArea,
              screen.safeAreaInsets.top > 0 else {
            clickCatcher?.orderOut(nil) // no hardware notch on this display
            return
        }
        let height = screen.safeAreaInsets.top
        let frame = NSRect(x: left.maxX, y: screen.frame.maxY - height,
                           width: right.minX - left.maxX, height: height)
        if clickCatcher == nil {
            let panel = NSPanel(contentRect: frame,
                                styleMask: [.borderless, .nonactivatingPanel],
                                backing: .buffered, defer: false)
            panel.level = .statusBar
            panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.isMovable = false
            panel.hidesOnDeactivate = false
            panel.isReleasedWhenClosed = false
            let view = NotchClickCatcherView()
            view.onClick = { [weak self] in self?.model.onTap?() }
            panel.contentView = view
            clickCatcher = panel
        }
        clickCatcher?.setFrame(frame, display: true)
        clickCatcher?.orderFrontRegardless()
    }

    /// M3 completion pulse: briefly surface the notch with a status-colored flourish when
    /// a background task finishes. Purely transient — session state resumes afterwards.
    func pulse(status: String) {
        DispatchQueue.main.async { [self] in
            model.pulse = status
            hideWork?.cancel()
            hideWork = nil
            show()
            pulseWork?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.model.pulse = nil
                self.pulseWork = nil
                if self.model.state == .idle { self.scheduleHide() }
            }
            pulseWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.6, execute: work)
        }
    }

    func setState(_ state: NotchState) {
        DispatchQueue.main.async { [self] in
            model.state = state
            if state == .idle {
                scheduleHide()
            } else {
                hideWork?.cancel()
                hideWork = nil
                if state == .listening { model.transcript = "" }
                show()
            }
        }
    }

    func setLevel(_ level: Float) {
        DispatchQueue.main.async { [self] in
            // Smooth toward the new peak so the bars breathe instead of flickering.
            model.level = model.level * 0.6 + min(level, 1) * 0.4
        }
    }

    func appendTranscript(itemId: String, delta: String) {
        DispatchQueue.main.async { [self] in
            if itemId != model.transcriptItem {
                model.transcriptItem = itemId
                model.transcript = ""
                model.revealedChars = 0
                // Frame counters span the whole drain stream, not one response item —
                // rebase so a second item (chained announcement) doesn't inherit the
                // first item's mostly-played fraction and reveal itself instantly.
                model.fractionBase = model.lastFraction
            }
            // The line renders with lineLimit(1): a hard newline (report reads are full
            // markdown) would freeze the display at the first line forever — flatten it.
            model.transcript += delta
                .replacingOccurrences(of: "\r", with: "")
                .replacingOccurrences(of: "\n", with: " ")
            if !model.paced { model.revealedChars = model.transcript.count }
        }
    }

    /// While audio is draining, the transcript reveals in proportion to what's actually
    /// been HEARD (generation runs several× faster than speech — without pacing, a long
    /// report read shows its final words within seconds and freezes there).
    func setPacing(_ paced: Bool) {
        DispatchQueue.main.async { [self] in
            model.paced = paced
            if !paced {
                model.revealedChars = model.transcript.count
                // Drain over — the engine's frame counters reset with it.
                model.fractionBase = 0
                model.lastFraction = 0
            }
        }
    }

    func setPlaybackProgress(_ fraction: Double) {
        DispatchQueue.main.async { [self] in
            model.lastFraction = min(1, max(0, fraction))
            guard model.paced else { return }
            // Map the remaining audio fraction onto this item's transcript.
            let base = min(model.fractionBase, 0.95)
            let adjusted = (model.lastFraction - base) / (1 - base)
            let target = Int(Double(model.transcript.count) * min(1, max(0, adjusted)))
            if target > model.revealedChars { model.revealedChars = target }
        }
    }

    private func show() {
        guard !visible else { return }
        visible = true
        if notch == nil {
            // Always reached via DispatchQueue.main.async; the init is @MainActor-isolated.
            MainActor.assumeIsolated {
                notch = DynamicNotch { [model] in NotchContentView(model: model) }
            }
        }
        guard let notch else { return }
        Task { await notch.expand() }
    }

    private func scheduleHide() {
        guard visible, hideWork == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.model.state == .idle, self.model.pulse == nil, let notch = self.notch else { return }
            self.visible = false
            self.hideWork = nil
            Task { await notch.hide() }
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4, execute: work) // don't flap between turns
    }
}

/// Nearly invisible fill keeps the window hit-testable (a fully transparent window goes
/// click-through); 2% black is imperceptible on the pure-black hardware notch. Accepts
/// first mouse — the panel never becomes key, so every click is a "first mouse".
private final class NotchClickCatcherView: NSView {
    var onClick: (() -> Void)?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.02).setFill()
        dirtyRect.fill()
    }
}

final class NotchModel: ObservableObject {
    @Published var state: NotchState = .idle
    @Published var level: Float = 0
    @Published var transcript = "" // full text (newline-flattened)
    @Published var revealedChars = 0 // how much has been *heard* (playback pacing)
    @Published var paced = false // true while speaker audio is draining
    @Published var pulse: String? // task completion status while the M3 pulse is live
    var transcriptItem = ""
    var fractionBase: Double = 0 // playback fraction when the current item began
    var lastFraction: Double = 0
    var onTap: (() -> Void)?

    var visibleTranscript: String {
        paced ? String(transcript.prefix(revealedChars)) : transcript
    }
}

// Design tokens — single source in DesignTokens.swift; file-local aliases for brevity.
private let ember = Tokens.ember
private let bay = Tokens.bay
private let alarm = Tokens.alarm
private let faint = Tokens.faint
private let gold = Tokens.gold

struct NotchContentView: View {
    @ObservedObject var model: NotchModel

    // The completion pulse decorates the idle notch; a live session display wins —
    // during a spoken announcement 'speaking' is the more truthful presence.
    private var activePulse: String? {
        model.state == .idle ? model.pulse : nil
    }

    var body: some View {
        HStack(spacing: 10) {
            SimmerBars(state: model.state, level: model.level, pulse: activePulse)
                .frame(width: 34, height: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
                if !model.visibleTranscript.isEmpty {
                    Text(model.visibleTranscript)
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            .frame(minWidth: 90, maxWidth: 230, alignment: .leading)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture { model.onTap?() }
    }

    private var title: String {
        switch activePulse {
        case "done": return "Task finished"
        case "failed": return "Task failed"
        case "cancelled": return "Task cancelled"
        case "reminder": return "Reminder" // M5: a scheduled reminder just fired
        default: break
        }
        switch model.state {
        case .idle: return "Gumbo"
        case .listening: return "Listening…"
        case .thinking: return "Thinking…"
        case .speaking: return "Gumbo"
        }
    }
}

/// The signature element — mirrors the dashboard's simmer bars.
struct SimmerBars: View {
    let state: NotchState
    let level: Float
    var pulse: String? = nil // completion pulse: overrides color + motion while set

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(alignment: .center, spacing: 3) {
                ForEach(0..<5, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(color)
                        .frame(width: 3, height: barHeight(index: i, time: t))
                }
            }
        }
    }

    private var color: Color {
        switch pulse {
        case "done": return bay
        case "failed": return alarm
        case "cancelled": return faint
        case "reminder": return gold // M5: gold beacon — matches the dashboard's reminder accent
        default: break
        }
        switch state {
        case .listening: return bay
        case .speaking, .thinking: return ember
        case .idle: return .white.opacity(0.35)
        }
    }

    private func barHeight(index: Int, time: TimeInterval) -> CGFloat {
        let base: CGFloat = 4
        if pulse != nil {
            // celebratory ripple — quicker than 'thinking', reads as an arrival
            let phase = sin(time * 6.2 + Double(index) * 1.3) * 0.5 + 0.5
            return base + CGFloat(phase) * 10
        }
        switch state {
        case .idle:
            return base
        case .thinking:
            // slow traveling pulse while the model works
            let phase = sin(time * 3.4 + Double(index) * 1.1) * 0.5 + 0.5
            return base + CGFloat(phase) * 8
        case .listening, .speaking:
            // level-driven, each bar with its own wobble so it reads organic
            let wobble = sin(time * 9 + Double(index) * 1.7) * 0.5 + 0.5
            return base + CGFloat(level) * (6 + CGFloat(wobble) * 12)
        }
    }
}
