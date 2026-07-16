import AppKit
import SwiftUI

/// M4 notch confirm: a supervisor escalation ("Claude wants to run git push") surfaces as
/// a small panel under the notch with Approve / Deny. One at a time — concurrent requests
/// queue. The daemon is the authority on timeouts (deny after confirm_timeout); the
/// shell's countdown just dismisses the UI so a stale prompt can't outlive its request.
final class ConfirmController {
    var onRespond: ((String, Bool) -> Void)?

    private struct Request {
        let id: String
        let taskTitle: String
        let title: String
        let detail: String
        let timeoutMs: Double
    }

    private var queue: [Request] = []
    private var panel: NSPanel?
    private var model: ConfirmModel?
    private var expireWork: DispatchWorkItem?
    private var showing = false
    private var currentId: String?

    func present(id: String, taskTitle: String, title: String, detail: String, timeoutMs: Double) {
        queue.append(Request(id: id, taskTitle: taskTitle, title: title, detail: detail, timeoutMs: timeoutMs))
        if !showing { showNext() }
    }

    /// The confirm's task was cancelled (daemon already resolved it deny) — drop it whether
    /// it's queued or on screen so a stale panel doesn't linger until its local countdown.
    func cancel(id: String) {
        queue.removeAll { $0.id == id }
        if currentId == id { answer(id, approved: nil) }
    }

    private func showNext() {
        guard !queue.isEmpty else { return }
        let request = queue.removeFirst()
        showing = true
        currentId = request.id

        let model = ConfirmModel(
            taskTitle: request.taskTitle,
            title: request.title,
            detail: request.detail,
            deadline: Date().addingTimeInterval(request.timeoutMs / 1000),
            totalSeconds: request.timeoutMs / 1000)
        model.onAnswer = { [weak self] approved in
            self?.answer(request.id, approved: approved)
        }
        self.model = model

        let panel = ensurePanel()
        panel.contentView = ConfirmFirstMouseView(rootView: ConfirmView(model: model))
        position(panel)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        panel.animator().alphaValue = 1

        // Dismiss when the daemon's deny-on-timeout fires — answering after that is a no-op
        // there, so leaving the prompt up would only invite a click into the void.
        expireWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.answer(request.id, approved: nil) }
        expireWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + request.timeoutMs / 1000, execute: work)
    }

    /// approved == nil → timed out locally; the daemon already denied, send nothing.
    private func answer(_ id: String, approved: Bool?) {
        guard showing else { return }
        showing = false
        currentId = nil
        expireWork?.cancel()
        expireWork = nil
        if let approved { onRespond?(id, approved) }
        if let panel {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.18
                panel.animator().alphaValue = 0
            }, completionHandler: { [weak self] in
                guard let self else { return }
                // A confirm_request arriving during this 180 ms fade calls present() →
                // showNext() (showing was already false) and re-shows the shared panel.
                // If that happened, this stale completion must NOT hide it or re-run
                // showNext — that path hides the new confirm and wedges `showing` true,
                // silently killing every future confirm until relaunch.
                guard !self.showing else { return }
                panel.orderOut(nil)
                self.showNext()
            })
        } else {
            showNext()
        }
    }

    private func ensurePanel() -> NSPanel {
        if let panel { return panel }
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: ConfirmView.size),
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
        self.panel = panel
        return panel
    }

    /// Centered under the notch on the MacBook display (falls back to top-center).
    private func position(_ panel: NSPanel) {
        guard let screen = NSScreen.gumboHome else { return }
        let size = ConfirmView.size
        let top = screen.frame.maxY - max(screen.safeAreaInsets.top, 2) - 8
        panel.setFrame(
            NSRect(x: screen.frame.midX - size.width / 2, y: top - size.height,
                   width: size.width, height: size.height),
            display: true)
    }
}

/// Borderless + non-activating panels never become key, so every click is a "first mouse"
/// that NSView discards by default (same live finding as the bubbles) — accept it or the
/// Approve/Deny buttons silently don't work.
private final class ConfirmFirstMouseView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class ConfirmModel: ObservableObject {
    let taskTitle: String
    let title: String
    let detail: String
    let deadline: Date
    let totalSeconds: Double
    var onAnswer: ((Bool) -> Void)?

    init(taskTitle: String, title: String, detail: String, deadline: Date, totalSeconds: Double) {
        self.taskTitle = taskTitle
        self.title = title
        self.detail = detail
        self.deadline = deadline
        self.totalSeconds = max(1, totalSeconds)
    }
}

struct ConfirmView: View {
    static let size = NSSize(width: 380, height: 132)

    @ObservedObject var model: ConfirmModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Tokens.ember)
                Text(model.taskTitle.isEmpty ? "Claude session" : model.taskTitle)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(Tokens.faint)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(model.detail)
                    .font(.system(size: 9.5))
                    .foregroundStyle(Tokens.alarm.opacity(0.9))
                    .lineLimit(1)
            }
            Text(model.title)
                .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(.white.opacity(0.92))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                countdown
                Spacer()
                Button(action: { model.onAnswer?(false) }) {
                    Text("Deny")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                        .padding(.horizontal, 14).padding(.vertical, 5)
                        .background(Capsule().fill(Color.white.opacity(0.08)))
                        .overlay(Capsule().strokeBorder(Tokens.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
                Button(action: { model.onAnswer?(true) }) {
                    Text("Approve")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(Tokens.roux)
                        .padding(.horizontal, 14).padding(.vertical, 5)
                        .background(Capsule().fill(Tokens.ember))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .frame(width: Self.size.width, height: Self.size.height)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(LinearGradient(colors: [Tokens.surface, Tokens.roux], startPoint: .top, endPoint: .bottom))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Tokens.line, lineWidth: 1))
        )
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    /// Thin bar draining toward the deadline — how long before the daemon denies.
    private var countdown: some View {
        TimelineView(.animation(minimumInterval: 0.25)) { context in
            let remaining = max(0, model.deadline.timeIntervalSince(context.date))
            let fraction = min(1, remaining / model.totalSeconds)
            VStack(alignment: .leading, spacing: 3) {
                Text("auto-deny in \(Int(remaining))s")
                    .font(.system(size: 9))
                    .foregroundStyle(Tokens.faint)
                Capsule()
                    .fill(Tokens.line)
                    .frame(width: 90, height: 3)
                    .overlay(alignment: .leading) {
                        Capsule().fill(Tokens.ember.opacity(0.8))
                            .frame(width: 90 * fraction)
                    }
            }
        }
    }
}
