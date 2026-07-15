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
        item.button?.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Gumbo")
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
}

/// Wires the pieces together: hotkey ⇄ audio ⇄ websocket ⇄ notch. Owns the session-state
/// merge (daemon state + local playback drain) and the audio-engine idle-stop.
final class GumboController {
    private let ws = WSClient()
    private let audio = AudioEngine()
    private let hotkeys = Hotkeys()
    private let notch = NotchController()
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
        ws.connect()
    }

    func showDashboard() {
        dashboard.show()
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
                self?.playbackDraining = draining
                self?.refreshState()
            }
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
            default:
                break
            }
        }
        ws.onBinary = { [weak self] data in
            guard let self, data.count > 1 else { return }
            if data[0] == 0x01 { // realtime speaker pcm16 (0x02 one-shot TTS lands in M3)
                self.audio.start(reason: .playback) // spoken reply with no prior press still plays
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

    /// VPIO keeps the mic unit hot (orange indicator) while the engine runs, so stop the
    /// engine once the session is over: idle daemon state, not armed, playback drained.
    private func scheduleEngineIdleStop() {
        engineIdleTimer?.invalidate()
        guard !armed, !playbackDraining, daemonState == "idle" else { return }
        engineIdleTimer = Timer.scheduledTimer(withTimeInterval: 75, repeats: false) { [weak self] _ in
            guard let self, !self.armed, !self.playbackDraining, self.daemonState == "idle" else { return }
            self.audio.stop()
        }
    }
}
