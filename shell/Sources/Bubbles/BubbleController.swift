import AppKit
import SwiftUI

/// Upper-right completion presence (SPEC §9 M3, redesigned per the user): one floating
/// panel per background task. Collapsed it is a **coal** — a breathing ember orb while
/// the task runs (molten seams drifting under a darker crust, soft heat bloom) that
/// cools into a still bay stone when the task finishes. Clicking expands it in place —
/// like the notch — into a mini observability panel that live-tails the sub-agent's
/// activity; the full dashboard stays one small link away. Removal is daemon-driven
/// (bubble_remove after the linger) and deferred while the user is reading the panel.
final class BubbleController {
    var onOpenDashboard: ((String) -> Void)?

    static let collapsedSize = NSSize(width: 84, height: 84)
    static let expandedSize = NSSize(width: 332, height: 408)

    private struct Bubble {
        let panel: NSPanel
        let model: BubbleModel
        var failsafe: DispatchWorkItem?
        var pendingRemove = false
    }

    private var bubbles: [String: Bubble] = [:]
    private var order: [String] = [] // stacking order, newest on top
    private var expandedId: String?

    private let margin: CGFloat = 10
    private let gap: CGFloat = 10

    // MARK: lifecycle from the daemon

    func upsert(taskId: String, title: String, status: String) {
        if let existing = bubbles[taskId] {
            existing.model.title = title
            let wasAlive = existing.model.state.isAlive
            existing.model.status = status
            if wasAlive && !existing.model.state.isAlive {
                existing.model.settledAt = Date() // the cooling ripple
            }
        } else {
            let model = BubbleModel(title: title, status: status)
            let panel = makePanel(model: model, taskId: taskId)
            bubbles[taskId] = Bubble(panel: panel, model: model)
            order.insert(taskId, at: 0)
            panel.setFrame(NSRect(origin: frameOrigin(forIndex: 0, size: Self.collapsedSize), size: Self.collapsedSize), display: false)
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            panel.animator().alphaValue = 1
            layout()
        }
        if OrbState(wire: status).isAlive {
            bubbles[taskId]?.failsafe?.cancel()
            bubbles[taskId]?.failsafe = nil
        } else {
            scheduleFailsafe(taskId)
        }
    }

    func remove(taskId: String) {
        guard let bubble = bubbles[taskId] else { return }
        if bubble.model.expanded {
            // the user is reading this panel — removal waits until he collapses it.
            bubbles[taskId]?.pendingRemove = true
            return
        }
        doRemove(taskId)
    }

    /// Live activity from the daemon's event fan-out; the expanded panel tails it.
    func ingest(event: [String: Any]) {
        guard let taskId = event["task_id"] as? String,
              let bubble = bubbles[taskId],
              let entry = BubbleEvent(raw: event) else { return }
        bubble.model.insert(entry)
    }

    // MARK: expand / collapse

    private func toggle(_ taskId: String) {
        if expandedId == taskId {
            collapse(taskId)
        } else {
            if let current = expandedId { collapse(current) }
            expand(taskId)
        }
    }

    private func expand(_ taskId: String) {
        guard let bubble = bubbles[taskId] else { return }
        expandedId = taskId
        bubble.panel.hasShadow = true
        withAnimation(.easeOut(duration: 0.26)) { bubble.model.expanded = true }
        fetchHistory(for: taskId)
        layout()
    }

    private func collapse(_ taskId: String) {
        guard let bubble = bubbles[taskId], bubble.model.expanded else { return }
        if expandedId == taskId { expandedId = nil }
        withAnimation(.easeIn(duration: 0.2)) { bubble.model.expanded = false }
        bubble.panel.hasShadow = false
        layout()
        if bubbles[taskId]?.pendingRemove == true { doRemove(taskId) }
    }

    private func doRemove(_ taskId: String) {
        guard let bubble = bubbles.removeValue(forKey: taskId) else { return }
        bubble.failsafe?.cancel()
        if expandedId == taskId { expandedId = nil }
        order.removeAll { $0 == taskId }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.35
            bubble.panel.animator().alphaValue = 0
        }, completionHandler: {
            bubble.panel.orderOut(nil)
            bubble.panel.close()
        })
        layout()
    }

    /// The daemon owns the linger (bubble_remove, config.bubbleLingerMs = 12 s after
    /// finish); this local cap only exists so a settled bubble can't live forever if the
    /// daemon dies inside that window — hence comfortably larger than the linger.
    private static let failsafeSeconds: TimeInterval = 30

    private func scheduleFailsafe(_ taskId: String) {
        bubbles[taskId]?.failsafe?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.remove(taskId: taskId) }
        bubbles[taskId]?.failsafe = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.failsafeSeconds, execute: work)
    }

    // MARK: history

    /// On expand, backfill the feed over the daemon's HTTP API; live events keep it
    /// current afterwards. Merging is seq-deduped, so overlap with the live tail is fine.
    private func fetchHistory(for taskId: String) {
        guard let url = URL(string: "http://127.0.0.1:8737/api/events?task_id=\(taskId)&limit=40") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self, let data,
                  let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
            DispatchQueue.main.async {
                guard let bubble = self.bubbles[taskId] else { return }
                for raw in rows {
                    if let entry = BubbleEvent(raw: raw) { bubble.model.insert(entry) }
                }
            }
        }.resume()
    }

    // MARK: panels + layout

    private func makePanel(model: BubbleModel, taskId: String) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.collapsedSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false // the orb's own bloom is the halo; shadow returns for the panel
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.contentView = FirstMouseHostingView(
            rootView: BubbleRootView(
                model: model,
                onToggle: { [weak self] in self?.toggle(taskId) },
                onDashboard: { [weak self] in self?.onOpenDashboard?(taskId) }))
        return panel
    }

    private func frameOrigin(forIndex index: Int, size: NSSize) -> NSPoint {
        guard let screen = NSScreen.main else { return .zero }
        let visible = screen.visibleFrame
        var top = visible.maxY - margin
        for (i, id) in order.enumerated() {
            let s = bubbles[id]?.model.expanded == true ? Self.expandedSize : Self.collapsedSize
            if i == index { return NSPoint(x: visible.maxX - size.width - margin, y: top - size.height) }
            top -= s.height + gap
        }
        return NSPoint(x: visible.maxX - size.width - margin, y: top - size.height)
    }

    private func layout() {
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        var top = visible.maxY - margin
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.26
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            for id in order {
                guard let bubble = bubbles[id] else { continue }
                let size = bubble.model.expanded ? Self.expandedSize : Self.collapsedSize
                let frame = NSRect(x: visible.maxX - size.width - margin, y: top - size.height,
                                   width: size.width, height: size.height)
                bubble.panel.animator().setFrame(frame, display: true)
                top -= size.height + gap
            }
        }
    }
}

/// The bubble panel is borderless + non-activating, so it never becomes key — which makes
/// EVERY click a "first mouse", and NSView discards those by default (the tap gesture never
/// fired; live finding from the user). Accepting first mouse delivers the click to SwiftUI.
private final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - model

/// Single source of truth for the wire status vocabulary (protocol.ts BubbleStatus) on
/// the Swift side. Every status→visual decision routes through this — a status M4 adds
/// (e.g. needs_input) lands on .unknown and renders ALIVE with its raw label, instead of
/// silently inheriting the spent/cancelled look from a String switch default.
enum OrbState: String {
    case running, done, failed, cancelled
    case unknown

    init(wire: String) {
        self = OrbState(rawValue: wire) ?? .unknown
    }

    /// Alive = task still in motion (no failsafe, breathing visuals).
    var isAlive: Bool { self == .running || self == .unknown }
}

final class BubbleModel: ObservableObject {
    @Published var title: String
    @Published var status: String

    var state: OrbState { OrbState(wire: status) }
    @Published var expanded = false
    @Published var events: [BubbleEvent] = []
    @Published var settledAt: Date? // when the task left 'running' — drives the cooling ripple

    init(title: String, status: String) {
        self.title = title
        self.status = status
    }

    func insert(_ entry: BubbleEvent) {
        if events.contains(where: { $0.seq == entry.seq }) { return }
        let index = events.firstIndex(where: { $0.seq > entry.seq }) ?? events.count
        events.insert(entry, at: index)
        if events.count > 120 { events.removeFirst(events.count - 120) }
    }
}

struct BubbleEvent: Identifiable {
    enum Kind { case call, result, message, lifecycle }

    let seq: Int
    let kind: Kind
    let text: String
    let time: String
    var id: Int { seq }

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "H:mm:ss"
        return formatter
    }()

    init?(raw: [String: Any]) {
        guard let type = raw["type"] as? String else { return nil }
        let seq = (raw["seq"] as? Int) ?? Int(raw["seq"] as? Double ?? -1)
        guard seq >= 0 else { return nil }
        let payload = raw["payload"] as? [String: Any] ?? [:]

        let body: String
        switch type {
        case "tool.call":
            kind = .call
            let name = payload["name"] as? String ?? "tool"
            let args = payload["args"] as? String ?? ""
            body = "\(name) \(args)"
        case "tool.result":
            kind = .result
            body = payload["output"] as? String ?? ""
        case "subagent.message":
            kind = .message
            body = payload["text"] as? String ?? ""
        case "task.created":
            kind = .lifecycle
            body = "Task started"
        case "task.finished":
            kind = .lifecycle
            let status = payload["status"] as? String ?? "done"
            let error = payload["error"] as? String
            body = "Finished — \(status)" + (error.map { ": \($0)" } ?? "")
        default:
            return nil
        }

        self.seq = seq
        self.text = String(body.replacingOccurrences(of: "\n", with: " ").prefix(280))
        if let ts = raw["ts"] as? Double {
            time = Self.clock.string(from: Date(timeIntervalSince1970: ts / 1000))
        } else {
            time = ""
        }
    }
}

// MARK: - design tokens — single source in DesignTokens.swift; file-local aliases

private let roux = Tokens.roux
private let surface = Tokens.surface
private let line = Tokens.line
private let ember = Tokens.ember
private let bay = Tokens.bay
private let alarm = Tokens.alarm
private let faint = Tokens.faint

private func hexColor(_ value: UInt32) -> Color {
    Color(
        red: Double((value >> 16) & 0xFF) / 255,
        green: Double((value >> 8) & 0xFF) / 255,
        blue: Double(value & 0xFF) / 255)
}

/// Orb palettes: hot core → base → deep edge, pushed wide for luminosity contrast —
/// the plasma shader mixes across the full ramp. Running burns; done is calm sea-glass;
/// failed is embers under ash; cancelled is spent.
private struct OrbPalette {
    let hot: Color
    let base: Color
    let deep: Color

    static func palette(for state: OrbState) -> OrbPalette {
        switch state {
        case .running, .unknown: // unknown = alive-but-unrecognized, never spent
            return OrbPalette(hot: hexColor(0xFFCF9E), base: ember, deep: hexColor(0x8A2E12))
        case .done:
            return OrbPalette(hot: hexColor(0xD9E9BB), base: bay, deep: hexColor(0x55703F))
        case .failed:
            return OrbPalette(hot: hexColor(0xF6AFA9), base: alarm, deep: hexColor(0x8F3030))
        case .cancelled:
            return OrbPalette(hot: hexColor(0x9A8F84), base: faint, deep: hexColor(0x413A33))
        }
    }
}

// MARK: - views

private struct BubbleRootView: View {
    @ObservedObject var model: BubbleModel
    let onToggle: () -> Void
    let onDashboard: () -> Void

    var body: some View {
        Group {
            if model.expanded {
                BubblePanelView(model: model, onCollapse: onToggle, onDashboard: onDashboard)
                    .transition(.opacity)
            } else {
                OrbView(model: model, diameter: 54)
                    .frame(width: BubbleController.collapsedSize.width,
                           height: BubbleController.collapsedSize.height)
                    .contentShape(Circle())
                    .onTapGesture(perform: onToggle)
                    .pointingCursor()
                    .transition(.opacity)
            }
        }
    }
}

/// The orb, v2 (coal-orb v1 preserved at git tag `coal-orb-v1`): a Metal-shaded plasma
/// core — visibly churning fluid interior, fresnel rim, white-hot flecks, luminous
/// bloom swelling with a clearly perceptible breath — plus one geometric accent: a
/// comet-tail arc orbiting while the task runs, settling to a still hairline ring on
/// done. All motion honors Reduce Motion.
struct OrbView: View {
    @ObservedObject var model: BubbleModel
    var diameter: CGFloat

    private var palette: OrbPalette { OrbPalette.palette(for: model.state) }

    /// Flow speed + luminosity: running burns, done drifts calmly (never frozen —
    /// frozen reads as dead), failed smolders, cancelled is nearly out.
    private var aliveness: Double {
        switch model.state {
        case .running, .unknown: return 1.0
        case .failed: return 0.3
        case .done: return 0.15
        case .cancelled: return 0.05
        }
    }

    private var breathAmp: Double {
        switch model.state {
        case .running, .unknown: return 1.0
        case .failed: return 0.3
        case .done: return 0.12
        case .cancelled: return 0.0
        }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 40.0)) { context in
            let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            let now = context.date.timeIntervalSinceReferenceDate
            // The shader sees float32 — a raw epoch timestamp loses sub-second precision
            // and the flow stutters. Wrap hourly (one imperceptible seam per hour).
            let shaderT = reduceMotion ? 0.0 : now.truncatingRemainder(dividingBy: 3600)
            // Two detuned sines so the breath never reads as a loop.
            let breath = reduceMotion ? 0.0 :
                (sin(now * 2 * .pi / 3.4) * 0.7 + sin(now * 2 * .pi / 8.1 + 1.3) * 0.3) * breathAmp
            let side = diameter * 1.55

            ZStack {
                Rectangle()
                    .fill(Color.white)
                    .frame(width: side, height: side)
                    .colorEffect(ShaderLibrary.orb(
                        .float2(side, side),
                        .float(shaderT),
                        .float(aliveness),
                        .float(breath),
                        .color(palette.hot),
                        .color(palette.base),
                        .color(palette.deep)))
                ring(t: shaderT)
                ripple(now: context.date)
            }
            .scaleEffect(1 + 0.04 * breath) // the geometric half of the breath
        }
        .frame(width: diameter * 1.55, height: diameter * 1.55)
    }

    @ViewBuilder
    private func ring(t: Double) -> some View {
        let ringD = diameter * 1.24
        switch model.state {
        case .running, .unknown: // comet-tail arc, one lap ≈ 6.5 s
            Circle()
                .trim(from: 0, to: 0.32)
                .stroke(
                    AngularGradient(colors: [palette.base.opacity(0), palette.hot],
                                    center: .center,
                                    startAngle: .degrees(0), endAngle: .degrees(115)),
                    style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
                .frame(width: ringD, height: ringD)
                .rotationEffect(.radians(t * 2 * .pi / 6.5))
        case .done:
            Circle().stroke(palette.base.opacity(0.45), lineWidth: 1)
                .frame(width: ringD, height: ringD)
        case .failed:
            Circle().stroke(palette.base.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [3, 5]))
                .frame(width: ringD, height: ringD)
        case .cancelled:
            Circle().stroke(faint.opacity(0.25), lineWidth: 1)
                .frame(width: ringD, height: ringD)
        }
    }

    @ViewBuilder
    private func ripple(now: Date) -> some View {
        if let settled = model.settledAt {
            let elapsed = now.timeIntervalSince(settled)
            if elapsed >= 0 && elapsed < 0.9 {
                let f = elapsed / 0.9
                Circle()
                    .stroke(palette.base.opacity((1 - f) * 0.65), lineWidth: 1.5)
                    .frame(width: diameter * (1 + f * 0.9), height: diameter * (1 + f * 0.9))
            }
        }
    }
}

/// The lifted pot lid: header coal + title, then the sub-agent's live activity.
private struct BubblePanelView: View {
    @ObservedObject var model: BubbleModel
    let onCollapse: () -> Void
    let onDashboard: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(line).frame(height: 1)
            feed
        }
        .frame(width: BubbleController.expandedSize.width,
               height: BubbleController.expandedSize.height)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(LinearGradient(colors: [surface, roux], startPoint: .top, endPoint: .bottom))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(line, lineWidth: 1))
        )
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var header: some View {
        HStack(spacing: 10) {
            OrbView(model: model, diameter: 18)
                .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(model.title)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(1)
                Text(statusLabel)
                    .font(.system(size: 10))
                    .foregroundStyle(statusColor.opacity(0.9))
            }
            Spacer(minLength: 4)
            Button(action: onDashboard) {
                Image(systemName: "arrow.up.forward.square")
                    .font(.system(size: 12))
                    .foregroundStyle(faint)
            }
            .buttonStyle(.plain)
            .pointingCursor()
            .help("Open in dashboard")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .onTapGesture(perform: onCollapse)
        .pointingCursor()
    }

    private var feed: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if model.events.isEmpty {
                        Text("Starting up…")
                            .font(.system(size: 10.5))
                            .foregroundStyle(faint)
                            .padding(.top, 16)
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(model.events) { event in
                        BubbleEventRow(event: event)
                    }
                    Color.clear.frame(height: 1).id("feed-end")
                }
                .padding(12)
            }
            .onChange(of: model.events.count) {
                proxy.scrollTo("feed-end", anchor: .bottom)
            }
        }
    }

    private var statusColor: Color {
        switch model.state {
        case .running, .unknown: return ember
        case .done: return bay
        case .failed: return alarm
        case .cancelled: return faint
        }
    }

    private var statusLabel: String {
        switch model.state {
        case .running: return "running…"
        case .unknown: return model.status // show the raw wire status until it's mapped
        default: return model.state.rawValue
        }
    }
}

private struct BubbleEventRow: View {
    let event: BubbleEvent

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            Text(glyph)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(glyphColor)
                .frame(width: 10, alignment: .center)
                .padding(.top, 1)
            Text(event.text)
                .font(.system(size: 10.5))
                .foregroundStyle(.white.opacity(event.kind == .message ? 0.82 : 0.6))
                .lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(event.time)
                .font(.system(size: 8.5))
                .foregroundStyle(faint.opacity(0.8))
                .padding(.top, 1)
        }
    }

    private var glyph: String {
        switch event.kind {
        case .call: return "▸"
        case .result: return "◂"
        case .message: return "●"
        case .lifecycle: return "◆"
        }
    }

    private var glyphColor: Color {
        switch event.kind {
        case .call: return ember
        case .result: return faint
        case .message: return bay
        case .lifecycle: return .white.opacity(0.5)
        }
    }
}

private extension View {
    func pointingCursor() -> some View {
        onHover { inside in
            if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}
