import Foundation

/// Thin WebSocket client of the daemon (ws://127.0.0.1:8737/ws). Sends hello{role:shell}
/// on open, auto-reconnects forever (the daemon restarts freely under tsx watch), and
/// carries JSON text frames + binary audio frames. Native client sends no Origin, which
/// the daemon's allowlist admits by design.
final class WSClient: NSObject, URLSessionWebSocketDelegate {
    var onMessage: (([String: Any]) -> Void)?
    var onBinary: ((Data) -> Void)?
    /// Fires (on main) after every successful open + hello — reconnects included. Used
    /// to re-arm daemon-side state that died with a restart (M5.5: the image viewer's
    /// context), mirroring how the daemon re-syncs bubbles on hello (review 🟡).
    var onConnect: (() -> Void)?

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
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.connect()
        }
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        sendJSON(["type": "hello", "role": "shell"])
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
