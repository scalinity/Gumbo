import Foundation

/// Thin WebSocket client of the daemon (ws://127.0.0.1:8737/ws). Sends hello{role:shell}
/// on open, auto-reconnects forever (the daemon restarts freely under tsx watch), and
/// carries JSON text frames + binary audio frames. Native client sends no Origin, which
/// the daemon's allowlist admits by design — but the privileged shell role must also prove
/// it can read the daemon's 0600 token file (~/Gumbo/daemon.token), included in the hello,
/// so an arbitrary same-machine process can't claim the shell role.
final class WSClient: NSObject, URLSessionWebSocketDelegate {
    var onMessage: (([String: Any]) -> Void)?
    var onBinary: ((Data) -> Void)?
    /// Fires (on main) after every successful open + hello — reconnects included. Used
    /// to re-arm daemon-side state that died with a restart (M5.5: the image viewer's
    /// context), mirroring how the daemon re-syncs bubbles on hello (review 🟡).
    var onConnect: (() -> Void)?
    /// Fires (on main) once per socket drop, before the reconnect attempt. M8: an active
    /// recording has nowhere to stream — the recorder must stop LOUDLY, never buffer
    /// into a dead socket.
    var onDisconnect: (() -> Void)?

    private let url = URL(string: "ws://127.0.0.1:8737/ws")!
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var closed = false

    func connect() {
        closed = false
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        receiveLoop(task)
    }

    func sendJSON(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    func sendBinary(_ data: Data) {
        task?.send(.data(data)) { _ in }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, task === self.task else { return }
            switch result {
            case .failure:
                self.scheduleReconnect()
            case .success(let message):
                switch message {
                case .data(let data):
                    DispatchQueue.main.async { self.onBinary?(data) }
                case .string(let text):
                    if let data = text.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        DispatchQueue.main.async { self.onMessage?(obj) }
                    }
                @unknown default:
                    break
                }
                self.receiveLoop(task)
            }
        }
    }

    private func scheduleReconnect() {
        guard !closed else { return }
        closed = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        DispatchQueue.main.async { self.onDisconnect?() } // once per drop (the guard above)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.connect()
        }
    }

    // MARK: URLSessionWebSocketDelegate

    /// The daemon's shell-auth token, read fresh each connect so a daemon restart that
    /// re-minted it is picked up. Nil (file missing on an older daemon) sends no token —
    /// a daemon without a configured token still admits the shell.
    private func daemonToken() -> String? {
        let path = ("~/Gumbo/daemon.token" as NSString).expandingTildeInPath
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        var hello: [String: Any] = ["type": "hello", "role": "shell"]
        if let token = daemonToken() { hello["token"] = token }
        sendJSON(hello)
        DispatchQueue.main.async { self.onConnect?() }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        scheduleReconnect()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil { scheduleReconnect() }
    }
}
