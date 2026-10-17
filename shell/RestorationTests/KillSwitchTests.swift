import XCTest
import CoreGraphics
@testable import Gumbo

final class KillSwitchTests: XCTestCase {
    func testOrdinaryInputDoesNotStopBackgroundTasks() {
        for type: CGEventType in [.keyDown, .keyUp, .flagsChanged, .mouseMoved,
                                  .leftMouseDown, .rightMouseDown, .otherMouseDown,
                                  .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel] {
            XCTAssertFalse(KillSwitch.isAbortShortcut(type: type, keyCode: 0, flags: []))
        }
        XCTAssertFalse(KillSwitch.isAbortShortcut(type: .keyDown, keyCode: 53, flags: []))
        XCTAssertFalse(KillSwitch.isAbortShortcut(type: .keyDown, keyCode: 53, flags: [.maskControl, .maskAlternate]))
    }

    func testOnlyExplicitStopChordCancels() {
        XCTAssertTrue(KillSwitch.isAbortShortcut(type: .keyDown, keyCode: 53, flags: [.maskControl, .maskShift]))
        XCTAssertFalse(KillSwitch.isAbortShortcut(type: .keyUp, keyCode: 53, flags: [.maskControl, .maskShift]))
        XCTAssertFalse(KillSwitch.isAbortShortcut(type: .keyDown, keyCode: 53, flags: [.maskControl, .maskShift, .maskCommand]))
    }
}
