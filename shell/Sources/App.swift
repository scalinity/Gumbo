import AppKit
import SwiftUI

@main
struct GumboApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: GumboController?
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = GumboController()
        self.controller = controller
        setupStatusItem()
        controller.start()
    }

    // LSUIElement apps have no Dock icon; a minimal status item is the quit / dashboard affordance.
    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = Self.statusIcon()
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "d"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Gumbo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        item.menu = menu
        statusItem = item
    }

    @objc private func openDashboard() {
        controller?.showDashboard()
    }

    /// Gumbo's own menu-bar mark: a simmering pot (wide rim, rounded body, two steam
    /// wisps). Custom-drawn — the stock `waveform` symbol collided with the user's
    /// dictation tool sitting in the same menu bar. Template image: adapts to any bar.
    private static func statusIcon() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            NSColor.black.setFill()
            NSColor.black.setStroke()

            // pot body — square shoulders under the rim, rounded base
            let x0: CGFloat = 3.4, x1: CGFloat = 14.6, yTop: CGFloat = 8.8, yBot: CGFloat = 3.2
            let r: CGFloat = 2.6
            let body = NSBezierPath()
            body.move(to: NSPoint(x: x0, y: yTop))
            body.line(to: NSPoint(x: x0, y: yBot + r))
            body.appendArc(withCenter: NSPoint(x: x0 + r, y: yBot + r), radius: r, startAngle: 180, endAngle: 270)
            body.line(to: NSPoint(x: x1 - r, y: yBot))
            body.appendArc(withCenter: NSPoint(x: x1 - r, y: yBot + r), radius: r, startAngle: 270, endAngle: 360)
            body.line(to: NSPoint(x: x1, y: yTop))
            body.close()
            body.fill()

            // rim — wider than the body, reads as the handles
            NSBezierPath(roundedRect: NSRect(x: 2.2, y: 9.4, width: 13.6, height: 1.7),
                         xRadius: 0.85, yRadius: 0.85).fill()

            // two steam wisps, gentle opposing sway
            let steam = NSBezierPath()
            steam.lineWidth = 1.5
            steam.lineCapStyle = .round
            steam.move(to: NSPoint(x: 7.0, y: 12.0))
            steam.curve(to: NSPoint(x: 7.0, y: 15.6),
                        controlPoint1: NSPoint(x: 5.9, y: 13.1),
                        controlPoint2: NSPoint(x: 8.1, y: 14.5))
            steam.move(to: NSPoint(x: 11.0, y: 12.0))
            steam.curve(to: NSPoint(x: 11.0, y: 15.6),
                        controlPoint1: NSPoint(x: 12.1, y: 13.1),
                        controlPoint2: NSPoint(x: 9.9, y: 14.5))
            steam.stroke()
            return true
        }
        image.isTemplate = true // monochrome mask — the system tints it for any menu bar
        image.accessibilityDescription = "Gumbo"
        return image
    }
}

/// Wires the pieces together: hotkey ⇄ audio ⇄ websocket ⇄ notch. Owns the session-state
/// merge (daemon state + local playback drain) and the audio-engine idle-stop.
final class GumboController {
    private let ws = WSClient()
    private let audio = AudioEngine()
    private let hotkeys = Hotkeys()
    private let notch = NotchController()
    private let bubbles = BubbleController()
    private let confirm = ConfirmController()
    private lazy var dashboard = DashboardWindow()

    private var daemonState = "idle"
    private var playbackDraining = false
    private var armed = false
    private var engineIdleTimer: Timer?

    func start() {
        wireAudio()
        wireWS()
        wireHotkeys()
        notch.onTap = { [weak self] in self?.showDashboard() }
        notch.installClickCatcher() // bare hardware notch opens the dashboard too
        // Bubble clicks expand in place (mini panel); the dashboard is its corner link.
        bubbles.onOpenDashboard = { [weak self] taskId in self?.showDashboard(taskId: taskId) }
        // M4: notch confirms answer supervisor escalations (deny happens daemon-side on timeout).
        confirm.onRespond = { [weak self] id, approved in
            self?.ws.sendJSON(["type": "confirm_response", "id": id, "approved": approved])
        }
        ws.connect()
    }

    func showDashboard(taskId: String? = nil) {
        dashboard.show(taskId: taskId)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: wiring

    private func wireHotkeys() {
        hotkeys.onPress = { [weak self] in
            guard let self else { return }
            self.armed = true
            self.audio.start(reason: .ptt) // idempotent; also triggers the one-time mic prompt
            self.audio.setArmed(true)
            self.ws.sendJSON(["type": "ptt_press"])
            self.refreshState()
        }
        hotkeys.onRelease = { [weak self] in
            guard let self else { return }
            self.armed = false
            self.audio.setArmed(false)
            self.ws.sendJSON(["type": "ptt_release"])
            self.refreshState()
        }
        hotkeys.startMonitoring()
    }

    private func wireAudio() {
        audio.onMicFrame = { [weak self] data in
            self?.ws.sendBinary(data)
        }
        audio.onMicLevel = { [weak self] level in
            self?.notch.setLevel(level)
        }
        audio.onPlaybackLevel = { [weak self] level in
            self?.notch.setLevel(level)
        }
        audio.onPlaybackStateChange = { [weak self] draining in
            DispatchQueue.main.async {
                guard let self else { return }
                self.playbackDraining = draining
                // The daemon needs the truth about audible playback: generation ends long
                // before the speaker drains, and both the dashboard's session state and
                // the session idle-close must track what the user actually hears.
                self.ws.sendJSON(["type": "playback_state", "draining": draining])
                self.notch.setPacing(draining)
                self.refreshState()
            }
        }
        audio.onPlaybackProgress = { [weak self] fraction in
            self?.notch.setPlaybackProgress(fraction)
        }
    }

    private func wireWS() {
        ws.onMessage = { [weak self] msg in
            guard let self, let type = msg["type"] as? String else { return }
            switch type {
            case "session_state":
                self.daemonState = msg["state"] as? String ?? "idle"
                self.refreshState()
            case "assistant_delta":
                self.notch.appendTranscript(itemId: msg["item_id"] as? String ?? "", delta: msg["delta"] as? String ?? "")
            case "playback_flush":
                self.audio.flushPlayback()
            case "bubble_upsert":
                if let taskId = msg["task_id"] as? String, !taskId.isEmpty {
                    self.bubbles.upsert(
                        taskId: taskId,
                        title: msg["title"] as? String ?? taskId,
                        status: msg["status"] as? String ?? "running")
                }
            case "bubble_remove":
                if let taskId = msg["task_id"] as? String {
                    self.bubbles.remove(taskId: taskId)
                }
            case "notch_pulse":
                self.notch.pulse(status: msg["status"] as? String ?? "done")
            case "confirm_request":
                if let id = msg["id"] as? String {
                    self.confirm.present(
                        id: id,
                        taskTitle: msg["task_title"] as? String ?? "",
                        title: msg["title"] as? String ?? "Allow this action?",
                        detail: msg["detail"] as? String ?? "",
                        timeoutMs: msg["timeout_ms"] as? Double ?? 60_000)
                }
            case "event":
                // Task-scoped activity for the bubble mini-panel live tail.
                if let event = msg["event"] as? [String: Any] {
                    self.bubbles.ingest(event: event)
                }
            default:
                break
            }
        }
        ws.onBinary = { [weak self] data in
            guard let self, data.count > 1 else { return }
            // 0x01 realtime speaker pcm16; 0x02 one-shot TTS announcement — same wire
            // format, same playback path (pendingPlayback covers the cold engine start).
            if data[0] == 0x01 || data[0] == 0x02 {
                self.audio.start(reason: .playback) // spoken audio with no prior press still plays
                self.audio.playChunk(data.dropFirst())
            }
        }
    }

    // MARK: state merge

    /// The daemon's 'speaking' tracks generation, which finishes seconds before playback —
    /// so the shell holds 'speaking' while its own queue drains. While armed, listening wins.
    private func refreshState() {
        let display: NotchState
        if armed && daemonState == "listening" {
            display = .listening
        } else if daemonState == "thinking" {
            display = .thinking
        } else if daemonState == "speaking" || playbackDraining {
            display = .speaking
        } else if daemonState == "listening" {
            display = .listening
        } else {
            display = .idle
        }
        notch.setState(display)
        scheduleEngineIdleStop()
    }

    /// A duplex engine keeps the mic unit hot (orange indicator), so stop the engine soon
    /// after the conversation is over: idle daemon state, not armed, playback drained.
    /// 8 s covers quick follow-up turns without paying an engine restart; anything longer
    /// and the mic indicator has no business staying lit (playback-only starts are mic-free).
    private func scheduleEngineIdleStop() {
        engineIdleTimer?.invalidate()
        guard !armed, !playbackDraining, daemonState == "idle" else { return }
        engineIdleTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in
            guard let self, !self.armed, !self.playbackDraining, self.daemonState == "idle" else { return }
            self.audio.stop()
        }
    }
}
