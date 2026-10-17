import XCTest
import AppKit
@testable import Gumbo

final class NotchRenderingTests: XCTestCase {
    @MainActor
    func testWindowStaysAnchoredDuringCaptionAndLevelUpdates() async throws {
        let before = Set(NSApp.windows.map(ObjectIdentifier.init))
        let notch = NotchController()
        notch.setState(.listening)
        try await Task.sleep(for: .milliseconds(650))
        let window = try XCTUnwrap(NSApp.windows.first { !before.contains(ObjectIdentifier($0)) && $0.isVisible })
        let initial = window.frame
        XCTAssertFalse(window.isOpaque, "A shaped clear panel must not use an opaque window backing")
        XCTAssertEqual(window.backgroundColor.alphaComponent, 0, accuracy: 0.001)
        for i in 0..<30 {
            notch.setState(i % 3 == 0 ? .listening : .speaking)
            notch.setLevel(Float(i % 10) / 10)
            notch.appendTranscript(itemId: "probe", delta: " measured caption")
            try await Task.sleep(for: .milliseconds(50))
            XCTAssertEqual(window.frame, initial)
            XCTAssertTrue(window.isVisible)
            XCTAssertFalse(window.isOpaque)
            XCTAssertEqual(window.alphaValue, 1, accuracy: 0.01)
        }
        notch.setState(.idle)
        try await Task.sleep(for: .seconds(2))
    }
}
