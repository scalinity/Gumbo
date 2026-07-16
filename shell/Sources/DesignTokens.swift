import AppKit
import SwiftUI

extension NSScreen {
    /// The MacBook's own display (the one with a notch), falling back to main.
    /// `NSScreen.main` is the *key window's* screen — bubbles would follow whatever
    /// display has focus, and the notch click-catcher could vanish whenever an
    /// external display was frontmost.
    static var gumboHome: NSScreen? {
        screens.first { $0.safeAreaInsets.top > 0 } ?? main
    }
}

/// Dashboard design tokens (dashboard/src/index.css :root) — the single Swift source of
/// truth. Two files previously redefined these with divergent encodings and had already
/// drifted on bay; keep this in lockstep with the CSS by hand.
enum Tokens {
    static let roux = rgb(0x19, 0x14, 0x11) // --bg
    static let surface = rgb(0x20, 0x1A, 0x15) // --surface
    static let line = rgb(0x32, 0x2A, 0x23) // --line
    static let ember = rgb(0xFF, 0x7A, 0x48) // --ember
    static let bay = rgb(0x9B, 0xB4, 0x79) // --bay
    static let alarm = rgb(0xE2, 0x5D, 0x5D) // --alarm
    static let faint = rgb(0x6B, 0x60, 0x55) // --faint

    private static func rgb(_ r: Int, _ g: Int, _ b: Int) -> Color {
        Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
    }
}
