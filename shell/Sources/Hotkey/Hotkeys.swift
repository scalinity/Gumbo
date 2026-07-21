import AppKit
import Carbon.HIToolbox

/// Push-to-talk chord: Control + Option held together, nothing else. A modifier-only chord
/// can't be modeled by key-plus-modifier libraries, so this watches `.flagsChanged` directly.
/// Press = both down with ⌘/⇧ absent; release = either lifting. Extra modifiers joining
/// mid-hold don't cancel (forgiving). Global monitors need the Accessibility grant.
///
/// Quick-text hotkey: ⌃Space, via Carbon `RegisterEventHotKey`. Registering the chord (rather than
/// a passive `.keyDown` global monitor) is what lets us capture a real-key combo WITHOUT the
/// separate Input Monitoring TCC grant a keyDown monitor would need — and it consumes the keypress
/// so no stray Space leaks to the frontmost app. Keyboard focus for the box is handled separately,
/// by a non-activating key panel (see QuickTextController), not by activating this app. The trade:
/// a registered hotkey needs a real key, so this can't be a modifier-only double-tap.
final class Hotkeys {
    var onPress: (() -> Void)?
    var onRelease: (() -> Void)?
    var onQuickText: (() -> Void)?

    private var isDown = false
    private var watchdog: Timer?
    private var monitors: [Any] = []
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?

    func startMonitoring() {
        // Prompt for Accessibility on first launch — without it the PTT global monitor sees nothing.
        // (The ⌃Space hotkey below needs neither Accessibility nor Input Monitoring.)
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
        registerQuickTextHotKey()
    }

    private func handle(_ event: NSEvent) {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let control = mods.contains(.control)
        let option = mods.contains(.option)
        if !isDown {
            if control && option && !mods.contains(.command) && !mods.contains(.shift) {
                beginHold()
            }
        } else if !(control && option) {
            endHold()
        }
    }

    private func beginHold() {
        isDown = true
        onPress?()
        // A `.flagsChanged` RELEASE event can be MISSED — a focus change, the global monitor
        // throttling, or another app's special key (e.g. a Globe/fn dictation PTT) swallowing
        // it — which leaves `isDown` stuck true, the mic armed, and everything said afterward
        // captured as one runaway prompt / empty commits (live bug 2026-07-21). Poll the REAL
        // modifier state and force-release the instant ⌃⌥ is no longer actually held.
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
            guard let self, self.isDown else { return }
            let mods = NSEvent.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if !(mods.contains(.control) && mods.contains(.option)) { self.endHold() }
        }
    }

    private func endHold() {
        guard isDown else { return }
        isDown = false
        watchdog?.invalidate()
        watchdog = nil
        onRelease?()
    }

    // MARK: ⌃Space quick-text hotkey (Carbon RegisterEventHotKey)

    private func registerQuickTextHotKey() {
        // Install a single hot-key handler; it dispatches back to this instance via userData. The
        // handler runs on the main thread during event processing, so `onQuickText` (which activates
        // + shows the box) fires inside the hotkey's activation context — exactly what we need.
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, eventRef, userData -> OSStatus in
            guard let userData, let eventRef else { return noErr }
            var hkID = EventHotKeyID()
            GetEventParameter(eventRef, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hkID)
            if hkID.id == Hotkeys.quickTextID {
                Unmanaged<Hotkeys>.fromOpaque(userData).takeUnretainedValue().onQuickText?()
            }
            return noErr
        }, 1, &spec, selfPtr, &eventHandler)

        let id = EventHotKeyID(signature: Hotkeys.quickTextSignature, id: Hotkeys.quickTextID)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    private static let quickTextSignature = OSType(0x47_55_4D_42) // 'GUMB'
    private static let quickTextID: UInt32 = 1
}
