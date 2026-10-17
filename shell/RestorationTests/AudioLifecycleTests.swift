import XCTest
import AVFoundation
@testable import Gumbo

final class AudioLifecycleTests: XCTestCase {
    @MainActor
    func testTransientOutputFormatRetainsQueuedAudioAndStopCancelsRetry() async throws {
        let audio = AudioEngine()
        var probes = 0
        var states: [Bool] = []
        var failure: String?
        audio.outputSampleRate = { engine in
            probes += 1
            return probes < 3 ? 0 : engine.outputNode.outputFormat(forBus: 0).sampleRate
        }
        audio.onPlaybackStateChange = { states.append($0) }
        audio.onError = { failure = $0 }
        audio.start(reason: .playback)
        audio.playChunk(Data(repeating: 0, count: 4800))
        try await Task.sleep(for: .milliseconds(1100))
        XCTAssertEqual(probes, 3)
        XCTAssertTrue(states.contains(true))
        XCTAssertEqual(states.last, false)
        XCTAssertNil(failure)
        audio.stop()
        probes = 0
        audio.start(reason: .playback)
        audio.stop()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(probes, 1, "A cancelled retry must not restart the graph")
    }

    @MainActor
    func testStopDiscardsAudioQueuedBeforeStartup() async throws {
        let audio = AudioEngine()
        var active = 0
        audio.onPlaybackStateChange = { if $0 { active += 1 } }
        audio.playChunk(Data(repeating: 0, count: 24_000))
        audio.stop()
        audio.start(reason: .playback)
        defer { audio.stop() }
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertEqual(active, 0, "Stopping must discard pre-start audio too")
    }

    @MainActor
    func testFlushThenNewPlaybackDrainsAndRecoversAfterRouteChange() async throws {
        let audio = AudioEngine()
        var states: [Bool] = []
        var failure: String?
        audio.onError = { failure = $0 }
        audio.onPlaybackStateChange = { states.append($0) }
        audio.start(reason: .playback)
        defer { audio.stop() }
        XCTAssertNil(failure)
        for _ in 0..<3 {
            audio.playChunk(Data(repeating: 0, count: 9_600))
            try await Task.sleep(for: .milliseconds(40))
            audio.flushPlayback()
            audio.configurationChanged()
            audio.playChunk(Data(repeating: 0, count: 4_800))
            try await Task.sleep(for: .milliseconds(600))
            XCTAssertEqual(states.last, false)
        }
        XCTAssertTrue(states.contains(true))
        XCTAssertNil(failure)
    }

    @MainActor
    func testStaleSocketDelegateCallbacksCannotConnectOrDisconnect() async throws {
        let client = WSClient()
        let session = URLSession(configuration: .ephemeral)
        let stale = session.webSocketTask(with: URL(string: "ws://127.0.0.1:1/ws")!)
        var connections = 0
        var disconnections = 0
        client.onConnect = { connections += 1 }
        client.onDisconnect = { disconnections += 1 }
        client.urlSession(session, webSocketTask: stale, didOpenWithProtocol: nil)
        client.urlSession(session, webSocketTask: stale, didCloseWith: .goingAway, reason: nil)
        client.urlSession(session, task: stale, didCompleteWithError: URLError(.cancelled))
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(connections, 0)
        XCTAssertEqual(disconnections, 0)
        session.invalidateAndCancel()
    }
}
