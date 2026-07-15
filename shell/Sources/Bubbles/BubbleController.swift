import AppKit
import SwiftUI

/// Upper-right completion presence (SPEC §9 M3): one small non-activating panel per
/// background task, stacked under the menu bar, mirroring the dashboard's task-dot
/// states (pulsing ember running, bay done, alarm failed, faint cancelled). Click →
/// dashboard at that task's view. Removal is daemon-driven (bubble_remove after the
/// linger), with a local failsafe so a daemon restart mid-linger can't strand a bubble.
final class BubbleController {
    var onTap: ((String) -> Void)?

    private struct Bubble {
        let panel: NSPanel
        let model: BubbleModel
        var failsafe: DispatchWorkItem?
    }

    private var bubbles: [String: Bubble] = [:]
    private var order: [String] = [] // stacking order, newest on top

    private let size = NSSize(width: 232, height: 44)
    private let margin: CGFloat = 12
    private let gap: CGFloat = 8

    func upsert(taskId: String, title: String, status: String) {
        if let existing = bubbles[taskId] {
            existing.model.title = title
            existing.model.status = status
        } else {
            let model = BubbleModel(title: title, status: status)
            let panel = makePanel(model: model, taskId: taskId)
            bubbles[taskId] = Bubble(panel: panel, model: model, failsafe: nil)
            order.insert(taskId, at: 0)
            panel.setFrame(frame(forIndex: 0), display: false)
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            panel.animator().alphaValue = 1
            layout()
        }
        if status == "running" {
            bubbles[taskId]?.failsafe?.cancel()
            bubbles[taskId]?.failsafe = nil
        } else {
            scheduleFailsafe(taskId)
        }
    }

    func remove(taskId: String) {
        guard let bubble = bubbles.removeValue(forKey: taskId) else { return }
        bubble.failsafe?.cancel()
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

    /// The daemon owns the linger (bubble_remove ~12 s after finish); this local cap only
    /// exists so a bubble can't live forever if the daemon dies inside that window.
    private func scheduleFailsafe(_ taskId: String) {
        bubbles[taskId]?.failsafe?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.remove(taskId: taskId) }
        bubbles[taskId]?.failsafe = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: work)
    }

    private func makePanel(model: BubbleModel, taskId: String) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
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
        panel.contentView = FirstMouseHostingView(
            rootView: BubbleView(model: model) { [weak self] in self?.onTap?(taskId) })
        return panel
    }

    private func frame(forIndex index: Int) -> NSRect {
        guard let screen = NSScreen.main else { return NSRect(origin: .zero, size: size) }
        let visible = screen.visibleFrame // already excludes the menu bar
        let x = visible.maxX - size.width - margin
        let y = visible.maxY - margin - size.height - CGFloat(index) * (size.height + gap)
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    private func layout() {
        for (index, id) in order.enumerated() {
            bubbles[id]?.panel.animator().setFrame(frame(forIndex: index), display: true)
        }
    }
}

/// The bubble panel is borderless + non-activating, so it never becomes key — which makes
/// EVERY click a "first mouse", and NSView discards those by default (the tap gesture never
/// fired; live finding from the user). Accepting first mouse delivers the click to SwiftUI.
private final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class BubbleModel: ObservableObject {
    @Published var title: String
    @Published var status: String

    init(title: String, status: String) {
        self.title = title
        self.status = status
    }
}

// Dashboard design tokens (index.css) — the bubbles are the same system on screen glass.
private let roux = Color(red: 0x19 / 255, green: 0x14 / 255, blue: 0x11 / 255) // --bg
private let line = Color(red: 0x32 / 255, green: 0x2A / 255, blue: 0x23 / 255) // --line
private let ember = Color(red: 0xFF / 255, green: 0x7A / 255, blue: 0x48 / 255) // --ember
private let bay = Color(red: 0x9B / 255, green: 0xB4 / 255, blue: 0x79 / 255) // --bay
private let alarm = Color(red: 0xE2 / 255, green: 0x5D / 255, blue: 0x5D / 255) // --alarm
private let faint = Color(red: 0x6B / 255, green: 0x60 / 255, blue: 0x55 / 255) // --faint

struct BubbleView: View {
    @ObservedObject var model: BubbleModel
    var onTap: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            dot
            VStack(alignment: .leading, spacing: 1) {
                Text(model.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(1)
                Text(statusLabel)
                    .font(.system(size: 10))
                    .foregroundStyle(statusColor.opacity(0.9))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(width: 232, height: 44, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(roux)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(line, lineWidth: 1))
        )
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onTapGesture { onTap() }
    }

    // Running pulses like the dashboard's task-dot (1.6 s breathe); terminal states hold.
    private var dot: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20.0)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let breathe = model.status == "running" ? 0.55 + 0.45 * (sin(t * 3.9) * 0.5 + 0.5) : 1.0
            Circle()
                .fill(statusColor.opacity(breathe))
                .frame(width: 8, height: 8)
        }
        .frame(width: 8, height: 8)
    }

    private var statusColor: Color {
        switch model.status {
        case "running": return ember
        case "done": return bay
        case "failed": return alarm
        default: return faint
        }
    }

    private var statusLabel: String {
        model.status == "running" ? "running…" : model.status
    }
}
