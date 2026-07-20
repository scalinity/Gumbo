import AppKit
import SwiftUI

/// M4 notch confirm: a supervisor escalation ("Claude wants to run git push") surfaces as
/// a small panel under the notch with Approve / Deny. One at a time — concurrent requests
/// queue. The daemon is the authority on timeouts (deny after confirm_timeout); the
/// shell's countdown just dismisses the UI so a stale prompt can't outlive its request.
final class ConfirmController {
    /// (id, approved, remember) — remember is true only when the request carried a
    /// remember_host and the user left the toggle on (M7 host confirms).
    var onRespond: ((String, Bool, Bool) -> Void)?

    private struct Request {
        let id: String
        let taskId: String
        let taskTitle: String
        let title: String
        let detail: String
        let body: String // long-form content (the full plan) behind the chevron
        let timeoutMs: Double
        let rememberHost: String // non-empty → show the "Remember <host>" toggle (M7)
        let confirmLabel: String // button text — a handoff says "Done", not "Approve"
        let denyLabel: String
    }

    private var queue: [Request] = []
    private var panel: NSPanel?
    private var model: ConfirmModel?
    private var expireWork: DispatchWorkItem?
    private var showing = false
    private var currentId: String?
    private var currentTaskId: String?

    func present(id: String, taskId: String, taskTitle: String, title: String, detail: String, body: String, timeoutMs: Double, rememberHost: String = "", confirmLabel: String = "Approve", denyLabel: String = "Deny") {
        queue.append(Request(id: id, taskId: taskId, taskTitle: taskTitle, title: title, detail: detail, body: body, timeoutMs: timeoutMs, rememberHost: rememberHost, confirmLabel: confirmLabel, denyLabel: denyLabel))
        if !showing { showNext() }
    }

    /// The confirm's task was cancelled (daemon already resolved it deny) — drop it whether
    /// it's queued or on screen so a stale panel doesn't linger until its local countdown.
    func cancel(id: String) {
        queue.removeAll { $0.id == id }
        if currentId == id { answer(id, approved: nil) }
    }

    /// The task itself ended (bubble removed / terminal status). A daemon RESTART loses the
    /// bridge that would have sent confirm_cancel, so the shell also self-dismisses any
    /// prompt whose task is gone — a plan approval outlived its cancelled session by minutes
    /// (live failure 2026-07-16).
    func cancelForTask(_ taskId: String) {
        queue.removeAll { $0.taskId == taskId }
        if currentTaskId == taskId, let id = currentId { answer(id, approved: nil) }
    }

    private func showNext() {
        guard !queue.isEmpty else { return }
        let request = queue.removeFirst()
        showing = true
        currentId = request.id
        currentTaskId = request.taskId

        let model = ConfirmModel(
            taskTitle: request.taskTitle,
            title: request.title,
            detail: request.detail,
            body: request.body,
            rememberHost: request.rememberHost,
            deadline: Date().addingTimeInterval(request.timeoutMs / 1000),
            totalSeconds: request.timeoutMs / 1000,
            confirmLabel: request.confirmLabel,
            denyLabel: request.denyLabel)
        model.onAnswer = { [weak self] approved in
            self?.answer(request.id, approved: approved)
        }
        // The remember toggle adds a row — the panel and the SwiftUI frame must agree on
        // the taller base size or the buttons clip (same coupling as the chevron below).
        let baseSize = request.rememberHost.isEmpty
            ? ConfirmView.size
            : NSSize(width: ConfirmView.size.width, height: ConfirmView.size.height + ConfirmView.rememberRowHeight)
        // The chevron grows the panel in place (top edge pinned under the notch); the
        // SwiftUI frame and the NSPanel frame must move together or the content clips.
        model.onExpandChange = { [weak self] expanded in
            guard let self, let panel = self.panel else { return }
            self.position(panel, size: expanded ? ConfirmView.expandedSize : baseSize)
        }
        self.model = model

        let panel = ensurePanel()
        panel.contentView = ConfirmFirstMouseView(rootView: ConfirmView(model: model))
        position(panel, size: baseSize)
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
        currentTaskId = nil
        expireWork?.cancel()
        expireWork = nil
        if let approved { onRespond?(id, approved, approved && model?.remember == true) }
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

    /// Centered under the notch on the MacBook display (falls back to top-center). The top
    /// edge stays pinned; an expanded plan view grows downward.
    private func position(_ panel: NSPanel, size: NSSize = ConfirmView.size) {
        guard let screen = NSScreen.gumboHome else { return }
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
    let body: String // long-form content (the full plan); empty → no chevron
    let rememberHost: String // non-empty → the "Remember <host>" toggle (M7)
    let deadline: Date
    let totalSeconds: Double
    let confirmLabel: String // "Approve" normally; a handoff says "Done" (live-demo polish)
    let denyLabel: String
    @Published var expanded = false
    /// Default OFF: remembering forever is the bigger action — the user opts in per site.
    @Published var remember = false
    var onAnswer: ((Bool) -> Void)?
    var onExpandChange: ((Bool) -> Void)?

    init(taskTitle: String, title: String, detail: String, body: String, rememberHost: String = "", deadline: Date, totalSeconds: Double, confirmLabel: String = "Approve", denyLabel: String = "Deny") {
        self.taskTitle = taskTitle
        self.title = title
        self.detail = detail
        self.body = body
        self.rememberHost = rememberHost
        self.deadline = deadline
        self.totalSeconds = max(1, totalSeconds)
        self.confirmLabel = confirmLabel
        self.denyLabel = denyLabel
    }
}

struct ConfirmView: View {
    static let size = NSSize(width: 380, height: 132)
    /// Extra height when the "Remember <host>" toggle row shows (M7 host confirms).
    static let rememberRowHeight: CGFloat = 26
    /// Chevron-expanded: the full plan in a scrollable view (top edge stays pinned).
    static let expandedSize = NSSize(width: 480, height: 520)

    @ObservedObject var model: ConfirmModel

    private var panelSize: NSSize {
        if model.expanded { return Self.expandedSize }
        return model.rememberHost.isEmpty
            ? Self.size
            : NSSize(width: Self.size.width, height: Self.size.height + Self.rememberRowHeight)
    }

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
            if model.expanded {
                ScrollView {
                    Text(model.body)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.78))
                        .lineSpacing(2.5)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                }
                .frame(maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.25)))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.line, lineWidth: 1))
            }
            if !model.body.isEmpty {
                Button(action: {
                    model.expanded.toggle()
                    model.onExpandChange?(model.expanded)
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: model.expanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 8.5, weight: .semibold))
                        Text(model.expanded ? "Hide the plan" : "Read the full plan")
                            .font(.system(size: 10))
                    }
                    .foregroundStyle(Tokens.faint)
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointingCursor()
            }
            if !model.rememberHost.isEmpty {
                // M7: opt-in write-through to the allowlist — this site never asks again.
                Toggle(isOn: $model.remember) {
                    Text("Remember \(model.rememberHost) — don't ask again")
                        .font(.system(size: 10))
                        .foregroundStyle(Tokens.faint)
                }
                .toggleStyle(.checkbox)
                .controlSize(.small)
            }
            HStack(spacing: 8) {
                countdown
                Spacer()
                Button(action: { model.onAnswer?(false) }) {
                    Text(model.denyLabel)
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                        .padding(.horizontal, 14).padding(.vertical, 5)
                        .background(Capsule().fill(Color.white.opacity(0.08)))
                        .overlay(Capsule().strokeBorder(Tokens.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
                Button(action: { model.onAnswer?(true) }) {
                    Text(model.confirmLabel)
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(Tokens.roux)
                        .padding(.horizontal, 14).padding(.vertical, 5)
                        .background(Capsule().fill(Tokens.ember))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .frame(width: panelSize.width, height: panelSize.height)
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
