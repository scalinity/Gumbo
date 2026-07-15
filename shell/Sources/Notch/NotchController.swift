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
            }
            model.transcript += delta
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

final class NotchModel: ObservableObject {
    @Published var state: NotchState = .idle
    @Published var level: Float = 0
    @Published var transcript = ""
    @Published var pulse: String? // task completion status while the M3 pulse is live
    var transcriptItem = ""
    var onTap: (() -> Void)?
}

private let ember = Color(red: 1.0, green: 0.478, blue: 0.282) // dashboard's ember accent
private let bay = Color(red: 0.608, green: 0.706, blue: 0.475) // bay green (input/done)
private let alarm = Color(red: 0.886, green: 0.365, blue: 0.365) // --alarm (failed)
private let faint = Color(red: 0.42, green: 0.376, blue: 0.333) // --faint (cancelled)

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
                if !model.transcript.isEmpty {
                    Text(model.transcript)
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
