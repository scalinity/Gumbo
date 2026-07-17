import AppKit
import QuartzCore

/// M6 agent cursor: a transparent, CLICK-THROUGH overlay window at .screenSaver level with
/// an animated fake cursor (prior art: farzaa/clicky). Pure visualization — the AX and
/// pid-targeted rungs never move the real pointer, so this is how the user sees where the
/// agent is working. It never intercepts real input (ignoresMouseEvents), which also keeps
/// the kill switch honest: anything the real pointer does is the user's.
final class GhostCursor {
    private var window: NSWindow?
    private var dot: CALayer?
    private var ring: CAShapeLayer?

    // Warm ember tone matching the notch/confirm palette.
    private let emberColor = NSColor(calibratedRed: 0.95, green: 0.45, blue: 0.15, alpha: 1)

    func show() {
        guard window == nil, let screen = NSScreen.main else { return }
        let win = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        win.level = .screenSaver
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = false
        win.ignoresMouseEvents = true // click-through, always
        win.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        win.isReleasedWhenClosed = false

        let content = NSView(frame: screen.frame)
        content.wantsLayer = true
        win.contentView = content

        let dot = CALayer()
        dot.bounds = CGRect(x: 0, y: 0, width: 14, height: 14)
        dot.cornerRadius = 7
        dot.backgroundColor = emberColor.cgColor
        dot.shadowColor = emberColor.cgColor
        dot.shadowOpacity = 0.9
        dot.shadowRadius = 10
        dot.shadowOffset = .zero
        dot.position = CGPoint(x: screen.frame.midX, y: screen.frame.midY)
        content.layer?.addSublayer(dot)

        let ring = CAShapeLayer()
        let ringRect = CGRect(x: -16, y: -16, width: 32, height: 32)
        ring.path = CGPath(ellipseIn: ringRect, transform: nil)
        ring.fillColor = NSColor.clear.cgColor
        ring.strokeColor = emberColor.withAlphaComponent(0.85).cgColor
        ring.lineWidth = 2
        ring.opacity = 0
        ring.position = dot.position
        content.layer?.addSublayer(ring)

        self.window = win
        self.dot = dot
        self.ring = ring
        win.alphaValue = 0
        win.orderFrontRegardless()
        win.animator().alphaValue = 1
    }

    func hide() {
        guard let win = window else { return }
        window = nil
        dot = nil
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
        guard let dot, let ring else { return }
        let target = convert(axCenter: CGPoint(x: axFrame.midX, y: axFrame.midY))

        CATransaction.begin()
        CATransaction.setAnimationDuration(0.28)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeInEaseOut))
        dot.position = target
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

    /// AX frames use top-left-origin global screen coordinates; AppKit windows use
    /// bottom-left of the PRIMARY screen. NSScreen.screens[0] is the primary.
    private func convert(axCenter: CGPoint) -> CGPoint {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return CGPoint(x: axCenter.x, y: primaryHeight - axCenter.y)
    }
}
