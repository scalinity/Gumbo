import XCTest
import AppKit
@testable import Gumbo

final class PushToTalkTests: XCTestCase {
    @MainActor
    func testFirstPressOpensNotchBeforeDaemonAcknowledgment() async throws {
        let existing = Set(NSApp.windows.map(ObjectIdentifier.init))
        let notch = NotchController()
        notch.setState(GumboController.displayState(armed: true, daemon: "idle", draining: false))
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertTrue(NSApp.windows.contains {
            !existing.contains(ObjectIdentifier($0)) && $0.isVisible && $0.alphaValue > 0.99
        }, "A local press must open the notch while the daemon still reports idle")
        notch.setState(.idle)
        try await Task.sleep(for: .milliseconds(2000))
    }

    func testCaptureTakesPriorityAndReleaseRestoresActualActivity() {
        XCTAssertEqual(GumboController.displayState(armed: true, daemon: "thinking", draining: false), .listening)
        XCTAssertEqual(GumboController.displayState(armed: true, daemon: "speaking", draining: true), .listening)
        XCTAssertEqual(GumboController.displayState(armed: false, daemon: "idle", draining: true), .speaking)
        XCTAssertEqual(GumboController.displayState(armed: false, daemon: "idle", draining: false), .idle)
    }
}
