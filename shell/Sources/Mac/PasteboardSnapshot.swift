import AppKit

/// M8 image-save: lossless clipboard preservation around a "Copy Image → write to disk"
/// flow. The Copy clobbers the user's clipboard with the image; `snapshot()` before it and
/// `restore()` after put back EXACTLY what they had — every representation (plain/rich text,
/// image, file URLs), not just the string flavor `SyntheticInput.paste` keeps. One saved
/// snapshot at a time (a single sub-agent save flow, n-of-1); a second snapshot overwrites
/// the first. Called on the main thread from MacBridge's dispatch (like the other
/// pasteboard work), so reads/writes never race the AppKit clipboard.
///
/// Fidelity: captures every concrete type→data flavor. Common cases (plain/rich text, image,
/// public.file-url) round-trip byte-exactly. PROMISED/lazy flavors (file promises, some
/// NSPasteboardItemDataProvider sources) return nil from `data(forType:)` and are NOT
/// preserved — acceptable for the image-save flow this serves.
enum PasteboardSnapshot {
    // Each item is type-raw-value → data. nil = nothing snapshotted (restore is a no-op);
    // [] = the clipboard was genuinely empty (restore clears it back to empty).
    private static var saved: [[String: Data]]?

    /// Capture every type of every pasteboard item verbatim.
    static func snapshot() {
        let pb = NSPasteboard.general
        var items: [[String: Data]] = []
        for item in pb.pasteboardItems ?? [] {
            var rep: [String: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { rep[type.rawValue] = data }
            }
            if !rep.isEmpty { items.append(rep) }
        }
        saved = items
    }

    /// Put the captured items back, then drop the snapshot — idempotent, so a second
    /// restore (e.g. the task-end safety net after the model already restored) is a no-op.
    static func restore() {
        guard let items = saved else { return }
        saved = nil
        let pb = NSPasteboard.general
        pb.clearContents()
        let nsItems = items.map { rep -> NSPasteboardItem in
            let it = NSPasteboardItem()
            for (raw, data) in rep { it.setData(data, forType: NSPasteboard.PasteboardType(raw)) }
            return it
        }
        if !nsItems.isEmpty { pb.writeObjects(nsItems) }
    }
}
