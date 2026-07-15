import AppKit

/// Push-to-talk chord: Control + Option held together, nothing else. A modifier-only chord
/// can't be modeled by key-plus-modifier libraries, so this watches `.flagsChanged` directly.
/// Press = both down with ⌘/⇧ absent; release = either lifting. Extra modifiers joining
/// mid-hold don't cancel (forgiving). Global monitors need the Accessibility grant.
final class Hotkeys {
    var onPress: (() -> Void)?
    var onRelease: (() -> Void)?

    private var isDown = false
    private var monitors: [Any] = []

    func startMonitoring() {
        // Prompt for Accessibility on first launch — without it the global monitor sees nothing.
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        if !AXIsProcessTrustedWithOptions(options) {
            NSLog("[hotkeys] waiting on Accessibility grant — ⌃⌥ works after it's given")
        }
        if let global = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: { [weak self] event in
            self?.handle(event)
        }) {
            monitors.append(global)
        }
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handle(event)
            return event
        } as Any)
    }

    private func handle(_ event: NSEvent) {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let control = mods.contains(.control)
        let option = mods.contains(.option)
        if !isDown {
            if control && option && !mods.contains(.command) && !mods.contains(.shift) {
                isDown = true
                onPress?()
            }
        } else if !(control && option) {
            isDown = false
            onRelease?()
        }
    }
}
