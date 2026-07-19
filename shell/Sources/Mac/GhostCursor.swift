import AppKit
import QuartzCore

/// M6 agent cursor: a transparent, CLICK-THROUGH overlay window at .screenSaver level with
/// an animated fake cursor (prior art: farzaa/clicky). Pure visualization — the AX and
/// pid-targeted rungs never move the real pointer, so this is how the user sees where the
/// agent is working. It never intercepts real input (ignoresMouseEvents), which also keeps
/// the kill switch honest: anything the real pointer does is the user's.
final class GhostCursor {
    private var window: NSWindow?
    private var cursor: CAShapeLayer?
    private var ring: CAShapeLayer?
    // The overlay spans the UNION of all displays so the fake cursor can fly to a target on
    // any screen; layer positions are converted into this frame's coordinate space.
    private var overlayFrame: CGRect = .zero

    // Warm ember tone matching the notch/confirm palette — used for the bloom + pulse ring.
    private let emberColor = NSColor(calibratedRed: 0.95, green: 0.45, blue: 0.15, alpha: 1)

    /// The classic macOS arrow-pointer outline (tip at top-left), in y-UP layer coordinates,
    /// bounds ≈ 13×20 pt — real-cursor proportions so it reads instantly as a pointer, not a
    /// blob. The layer's anchorPoint puts the TIP (the hotspot) on the target coordinate.
    private static func arrowPath() -> CGPath {
        let path = CGMutablePath()
        path.move(to: CGPoint(x: 0, y: 19.4)) // tip
        path.addLine(to: CGPoint(x: 0, y: 2.9)) // straight left edge down
        path.addLine(to: CGPoint(x: 4.4, y: 6.6)) // notch in
        path.addLine(to: CGPoint(x: 7.3, y: 0)) // tail outer
        path.addLine(to: CGPoint(x: 9.9, y: 1.1)) // tail tip
        path.addLine(to: CGPoint(x: 7.0, y: 7.5)) // tail inner
        path.addLine(to: CGPoint(x: 12.5, y: 7.5)) // diagonal shoulder
        path.closeSubpath()
        return path
    }

    func show() {
        guard window == nil, !NSScreen.screens.isEmpty else { return }
        let frame = NSScreen.screens.reduce(CGRect.null) { $0.union($1.frame) }
        overlayFrame = frame
        let win = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        win.level = .screenSaver
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = false
        win.ignoresMouseEvents = true // click-through, always
        win.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        win.isReleasedWhenClosed = false

        let content = NSView(frame: CGRect(origin: .zero, size: frame.size))
        content.wantsLayer = true
        win.contentView = content

        // A real arrow pointer: black fill + white outline (the system cursor's own scheme,
        // so it reads as a cursor at a glance) with a slight ember bloom so it's still
        // unmistakably Gumbo's hand, not the user's.
        let cursor = CAShapeLayer()
        cursor.path = Self.arrowPath()
        cursor.bounds = CGRect(x: 0, y: 0, width: 12.5, height: 19.4)
        cursor.fillColor = NSColor.black.cgColor
        cursor.strokeColor = NSColor.white.cgColor
        cursor.lineWidth = 1.5
        cursor.lineJoin = .round
        cursor.shadowColor = emberColor.cgColor
        cursor.shadowOpacity = 0.85
        cursor.shadowRadius = 6 // the "slight bloom"
        cursor.shadowOffset = .zero
        cursor.anchorPoint = CGPoint(x: 0, y: 1) // the TIP is the hotspot
        cursor.position = CGPoint(x: frame.width / 2, y: frame.height / 2)
        content.layer?.addSublayer(cursor)

        let ring = CAShapeLayer()
        let ringRect = CGRect(x: -16, y: -16, width: 32, height: 32)
        ring.path = CGPath(ellipseIn: ringRect, transform: nil)
        ring.fillColor = NSColor.clear.cgColor
        ring.strokeColor = emberColor.withAlphaComponent(0.85).cgColor
        ring.lineWidth = 2
        ring.opacity = 0
        ring.position = cursor.position
        content.layer?.addSublayer(ring)

        self.window = win
        self.cursor = cursor
        self.ring = ring
        win.alphaValue = 0
        win.orderFrontRegardless()
        win.animator().alphaValue = 1
    }

    func hide() {
        guard let win = window else { return }
        window = nil
        cursor = nil
        ring = nil
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.2
            win.animator().alphaValue = 0
        }, completionHandler: {
            win.orderOut(nil)
        })
    }

    /// Fly to an element's AXFrame (top-left screen coords) and pulse the highlight ring —
    /// called just before the action fires so the user's eye arrives with the agent's.
    func move(to axFrame: CGRect) {
        guard let cursor, let ring else { return }
        let target = convert(axCenter: CGPoint(x: axFrame.midX, y: axFrame.midY))

        CATransaction.begin()
        CATransaction.setAnimationDuration(0.28)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeInEaseOut))
        cursor.position = target // anchorPoint puts the arrow TIP on the target
        ring.position = target
        CATransaction.commit()

        // Brief highlight pulse at the target once the flight lands.
        let pulse = CABasicAnimation(keyPath: "transform.scale")
        pulse.fromValue = 0.6
        pulse.toValue = 1.6
        pulse.duration = 0.45
        pulse.beginTime = CACurrentMediaTime() + 0.28
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9
        fade.toValue = 0
        fade.duration = 0.45
        fade.beginTime = pulse.beginTime
        ring.add(pulse, forKey: "pulse")
        ring.add(fade, forKey: "fade")
    }

    /// AX frames are top-left-origin global screen coordinates; AppKit is bottom-left-origin
    /// off the PRIMARY screen (NSScreen.screens[0]). Flip via the primary's maxY to get global
    /// AppKit coords, then subtract the overlay's origin so the point lands in the (possibly
    /// multi-display) overlay view's own coordinate space.
    private func convert(axCenter: CGPoint) -> CGPoint {
        let primaryMaxY = NSScreen.screens.first?.frame.maxY ?? 0
        return CGPoint(x: axCenter.x - overlayFrame.minX, y: (primaryMaxY - axCenter.y) - overlayFrame.minY)
    }
}
