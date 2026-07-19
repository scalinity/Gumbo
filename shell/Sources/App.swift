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
    private let imageBubbles = ImageBubbleController()
    private let imageViewer = ImageViewerController()
    private let fileBubbles = FileBubbleController()
    private let fileViewer = FileViewerController()
    private let confirm = ConfirmController()
    private let reminders = RemindersBridge()
    private let quickText = QuickTextController()
    private let mac = MacBridge()
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
        // M5.5: image thumbnails stack directly beneath the task orbs; clicking one opens
        // the viewer/editor, whose context + edit requests ride the WS back to the daemon.
        bubbles.onStackBottomChange = { [weak self] y in self?.imageBubbles.setStackBottom(y) }
        imageBubbles.onOpen = { [weak self] file in self?.imageViewer.open(file: file) }
        // Presented files (specs, docs) stack beneath the images; a card opens Gumbo's own
        // renderer, never a system text editor.
        imageBubbles.onStackBottomChange = { [weak self] y in self?.fileBubbles.setStackBottom(y) }
        fileBubbles.onOpen = { [weak self] doc in self?.fileViewer.open(doc) }
        // The file viewer arms a file_context + sends typed edit requests over the WS.
        fileViewer.onSend = { [weak self] json in self?.ws.sendJSON(json) }
        imageViewer.onSend = { [weak self] json in self?.ws.sendJSON(json) }
        // Daemon restarts lose the in-memory image_context / file_context while a viewer
        // sits open — re-arm both on every (re)connect so voice edits keep working (review 🟡).
        ws.onConnect = { [weak self] in
            self?.imageViewer.resendContext()
            self?.fileViewer.resendContext()
        }
        // M4: notch confirms answer supervisor escalations (deny happens daemon-side on timeout).
        confirm.onRespond = { [weak self] id, approved in
            self?.ws.sendJSON(["type": "confirm_response", "id": id, "approved": approved])
        }
        // Quick text: ⌃Space opens the box; a submission rides the existing debug_text path,
        // so it drives the orchestrator identically to a spoken turn (no daemon changes).
        quickText.onSubmit = { [weak self] text in
            self?.ws.sendJSON(["type": "debug_text", "text": text])
        }
        // M6: mac_action results + kill-switch aborts ride back over the same socket.
        mac.onReply = { [weak self] json in self?.ws.sendJSON(json) }
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
        // ⌃Space opens the text box (a Carbon registered hotkey, so it can grab keyboard focus).
        // Independent of the ⌃⌥ PTT chord — no mic armed, nothing to cancel.
        hotkeys.onQuickText = { [weak self] in self?.quickText.toggle() }
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
        audio.onPlaybackProgress = { [weak self] played, enqueued in
            self?.notch.setPlaybackProgress(played: played, enqueued: enqueued)
        }
    }

    private func wireWS() {
        ws.onMessage = { [weak self] msg in
            guard let self, let type = msg["type"] as? String else { return }
            // M6: mac_action / mac_task go straight to the bridge (its own worker queue);
            // it owns the reply, so short-circuit the notch/bubble switch below.
            if self.mac.handle(msg) { return }
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
                    let status = msg["status"] as? String ?? "running"
                    self.bubbles.upsert(
                        taskId: taskId,
                        title: msg["title"] as? String ?? taskId,
                        status: status)
                    // A task that just ended can't need a confirm anymore. The daemon sends
                    // confirm_cancel too, but after a daemon RESTART it has no memory of the
                    // pending prompt — the shell must self-dismiss (live failure 2026-07-16:
                    // a plan approval outlived its cancelled session).
                    if ["done", "failed", "cancelled"].contains(status) {
                        self.confirm.cancelForTask(taskId)
                    }
                }
            case "bubble_remove":
                if let taskId = msg["task_id"] as? String {
                    self.bubbles.remove(taskId: taskId)
                    self.confirm.cancelForTask(taskId)
                }
            case "notch_pulse":
                self.notch.pulse(status: msg["status"] as? String ?? "done")
            case "confirm_request":
                if let id = msg["id"] as? String {
                    self.confirm.present(
                        id: id,
                        taskId: msg["task_id"] as? String ?? "",
                        taskTitle: msg["task_title"] as? String ?? "",
                        title: msg["title"] as? String ?? "Allow this action?",
                        detail: msg["detail"] as? String ?? "",
                        body: msg["body"] as? String ?? "",
                        timeoutMs: msg["timeout_ms"] as? Double ?? 60_000)
                }
            case "confirm_cancel":
                if let id = msg["id"] as? String {
                    self.confirm.cancel(id: id)
                }
            case "open_image":
                // Voice-driven gallery recall (open_image tool): straight into the editor,
                // AND onto the thumbnail shelf — the corner stack reflects everything
                // recently pulled up, not just fresh renders, so closing the editor still
                // leaves a click-path back (the user, 2026-07-16).
                if let file = msg["file"] as? String {
                    self.imageBubbles.present(file: file, editedFrom: nil, genId: nil)
                    self.imageViewer.open(file: file)
                }
            case "create_reminder":
                // M5: mirror the daemon's schedule row into Reminders.app; the reply
                // carries the EventKit id (or omits it on failure — daemon reads null).
                if let id = msg["id"] as? String, let text = msg["text"] as? String,
                   let fireAt = msg["fire_at"] as? Double {
                    self.reminders.create(text: text, fireAtMs: fireAt) { [weak self] ekId in
                        var reply: [String: Any] = ["type": "reminder_created", "id": id]
                        reply["eventkit_id"] = ekId // nil → key omitted → daemon stores null
                        self?.ws.sendJSON(reply)
                    }
                }
            case "remove_reminder":
                if let ekId = msg["eventkit_id"] as? String {
                    self.reminders.remove(eventkitId: ekId)
                }
            case "file_present":
                // The voice agent put a file on screen — document card now, renderer on click.
                // Also refresh the open viewer in place (this is how an edit's new content
                // arrives, and how a re-present of the same doc updates it).
                if let file = msg["file"] as? String, let content = msg["content"] as? String {
                    let doc = PresentedFile(
                        title: msg["title"] as? String ?? file,
                        file: file,
                        path: msg["path"] as? String ?? "",
                        content: content)
                    self.fileBubbles.present(doc)
                    self.fileViewer.handlePresented(doc)
                }
            case "event":
                // Task-scoped activity for the bubble mini-panel live tail.
                if let event = msg["event"] as? [String: Any] {
                    self.bubbles.ingest(event: event)
                    // M5.5: image lifecycle — new/edited images surface as thumbnails,
                    // and the open viewer swaps to an edited version / leaves busy state.
                    if let type = event["type"] as? String,
                       let payload = event["payload"] as? [String: Any] {
                        if type == "image.created", let file = payload["file"] as? String {
                            let parent = payload["edited_from"] as? String
                            self.imageBubbles.present(file: file, editedFrom: parent,
                                                      genId: payload["gen_id"] as? String)
                            self.imageViewer.handleCreated(file: file, editedFrom: parent)
                        } else if type == "image.generating", let genId = payload["gen_id"] as? String {
                            // A render just started: hold its slot with a working orb.
                            self.imageBubbles.beginWork(key: "gen:" + genId)
                        } else if type == "image.generate_failed", let genId = payload["gen_id"] as? String {
                            self.imageBubbles.failWork(key: "gen:" + genId)
                        } else if type == "image.edit_requested", let file = payload["file"] as? String {
                            self.imageBubbles.beginWork(key: "edit:" + file)
                            self.imageViewer.handleEditRequested(file: file)
                        } else if type == "image.edit_failed", let file = payload["file"] as? String {
                            self.imageBubbles.failWork(key: "edit:" + file)
                            self.imageViewer.handleEditFailed(file: file)
                        } else if type == "file.edit_failed", let path = payload["path"] as? String {
                            // The edited doc's new content arrives via file_present (success);
                            // failure only fans out as this event — un-busy the viewer.
                            self.fileViewer.handleEditFailed(path: path)
                        }
                    }
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
