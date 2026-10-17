import XCTest
import AVFoundation
@testable import Gumbo

final class AudioLifecycleTests: XCTestCase {
    @MainActor
    func testDuplexGraphDeliversMicrophoneFramesAndStopsOnRelease() async throws {
        let audio = AudioEngine()
        let captured = expectation(description: "Actual microphone PCM arrives")
        let resumed = expectation(description: "Stopped microphone resumes promptly")
        let frameLock = NSLock()
        var frames = 0
        var failures: [String] = []
        var readyCount = 0
        var resumeAt: Date?
        audio.onError = { failures.append($0) }
        audio.onCaptureReady = {
            readyCount += 1
            if let resumeAt {
                XCTAssertLessThan(Date().timeIntervalSince(resumeAt), 1.5,
                                  "An idle stop must retain the warm graph")
                resumed.fulfill()
            }
        }
        audio.onMicFrame = { data in
            frameLock.lock()
            frames += 1
            let first = frames == 1
            frameLock.unlock()
            if first {
                XCTAssertGreaterThan(data.count, 0)
                captured.fulfill()
            }
        }
        audio.setArmed(true)
        audio.start(reason: .ptt)
        await fulfillment(of: [captured], timeout: 15)
        XCTAssertTrue(failures.isEmpty, "Microphone startup failures: \(failures)")
        audio.setArmed(false)
        try await Task.sleep(for: .milliseconds(150))
        let releasedCount = frames
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(frames, releasedCount, "Release must stop microphone delivery")
        audio.suspend()
        try await Task.sleep(for: .milliseconds(500))
        let suspendedCount = frames
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(frames, suspendedCount)
        resumeAt = Date()
        audio.setArmed(true)
        audio.start(reason: .ptt)
        await fulfillment(of: [resumed], timeout: 3)
        XCTAssertEqual(readyCount, 2)
        audio.stop()
        try await Task.sleep(for: .milliseconds(300))
    }

    @MainActor
    func testColdAudioStartupLeavesMainQueueResponsiveAndCanBeCancelled() async throws {
        let audio = AudioEngine()
        let entered = expectation(description: "Cold device probe entered")
        let mainResponded = expectation(description: "Main queue responds during device startup")
        var active = false
        audio.onPlaybackStateChange = { if $0 { active = true } }
        audio.outputSampleRate = { engine in
            XCTAssertFalse(Thread.isMainThread, "Device initialization must not block the notch or key releases")
            entered.fulfill()
            Thread.sleep(forTimeInterval: 0.8) // reproduce the blocking device call
            return engine.outputNode.outputFormat(forBus: 0).sampleRate
        }
        audio.start(reason: .playback)
        await fulfillment(of: [entered], timeout: 2)
        let before = Date()
        DispatchQueue.main.async { mainResponded.fulfill() }
        await fulfillment(of: [mainResponded], timeout: 0.3)
        XCTAssertLessThan(Date().timeIntervalSince(before), 0.3)
        audio.stop() // cancellation must be accepted while the device call is blocked
        try await Task.sleep(for: .milliseconds(1100))
        XCTAssertFalse(active)
    }

    @MainActor
    func testTransientOutputFormatRetainsQueuedAudioAndStopCancelsRetry() async throws {
        let audio = AudioEngine()
        var probes = 0
        var states: [Bool] = []
        var failure: String?
        let drained = expectation(description: "Retried audio drains after a playback flush")
        audio.outputSampleRate = { engine in
            probes += 1
            return probes < 3 ? 0 : engine.outputNode.outputFormat(forBus: 0).sampleRate
        }
        audio.onPlaybackStateChange = {
            states.append($0)
            if !$0, states.contains(true) { drained.fulfill() }
        }
        audio.onError = { failure = $0 }
        audio.start(reason: .playback)
        audio.playChunk(Data(repeating: 0, count: 4800))
        try await Task.sleep(for: .milliseconds(50))
        audio.flushPlayback() // a new turn must not strand a pending device retry
        audio.playChunk(Data(repeating: 0, count: 4800))
        await fulfillment(of: [drained], timeout: 4)
        XCTAssertGreaterThanOrEqual(probes, 3)
        XCTAssertTrue(states.contains(true))
        XCTAssertEqual(states.last, false)
        XCTAssertNil(failure)
        audio.onPlaybackStateChange = { states.append($0) }
        audio.stop()
        probes = 0
        audio.start(reason: .playback)
        try await Task.sleep(for: .milliseconds(50))
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
            let drained = expectation(description: "Playback drains after route recovery")
            var active = false
            audio.onPlaybackStateChange = { draining in
                states.append(draining)
                if draining { active = true }
                else if active { active = false; drained.fulfill() }
            }
            audio.playChunk(Data(repeating: 0, count: 9_600))
            try await Task.sleep(for: .milliseconds(40))
            audio.flushPlayback()
            audio.configurationChanged()
            audio.playChunk(Data(repeating: 0, count: 4_800))
            await fulfillment(of: [drained], timeout: 4)
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
