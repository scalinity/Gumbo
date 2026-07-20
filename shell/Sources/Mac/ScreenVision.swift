import AppKit
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

/// M7 vision lane: one-shot ScreenCaptureKit captures + on-device Vision OCR. This is the
/// LAST planned TCC grant — the first SCShareableContent call makes macOS prompt for
/// Screen Recording; a denial comes back as typed `capture_denied`, never a hang.
///
/// ALL coordinate math lives here, next to the pixels: window frames and SCDisplay frames
/// are global TOP-LEFT points; Vision bounding boxes are normalized BOTTOM-LEFT — the
/// conversion happens once, in this file, and the daemon/model only ever see global
/// top-left points they can hand straight back to the `point` action. (Retina DPR and
/// multi-display mapping are the documented #1 cause of offset clicks — structurally
/// removed by never letting a pixel coordinate cross the wire.)
enum ScreenVision {
    private static let captureTimeoutMs = 8000

    /// Entry point from MacBridge (already off the main thread, on its serial work queue).
    static func perform(_ action: [String: Any]) -> [String: Any] {
        let kind = action["kind"] as? String ?? ""
        let app = action["app"] as? String
        let region = rect(from: action["region"])
        switch kind {
        case "ocr":
            return ocr(app: app, region: region).wire()
        case "screenshot":
            guard let outPath = action["out_path"] as? String, !outPath.isEmpty else {
                return AXResult.failure("out_of_scope", "screenshot needs an out_path.").wire()
            }
            return screenshot(app: app, region: region, outPath: outPath).wire()
        default:
            return AXResult.failure("out_of_scope", "Unknown capture kind \"\(kind)\".").wire()
        }
    }

    private static func rect(from raw: Any?) -> CGRect? {
        guard let arr = raw as? [Any], arr.count == 4 else { return nil }
        let v = arr.compactMap { ($0 as? NSNumber)?.doubleValue }
        guard v.count == 4, v[2] > 0, v[3] > 0 else { return nil }
        return CGRect(x: v[0], y: v[1], width: v[2], height: v[3])
    }

    // MARK: capture

    private struct Capture {
        let image: CGImage
        let rect: CGRect // global top-left points the image covers
        let scale: CGFloat
        let label: String
    }

    /// Capture either succeeds with pixels or fails with a ready-to-wire AXResult —
    /// (AXResult is not an Error, so this is a plain outcome enum, not Result).
    private enum CaptureOutcome {
        case ok(Capture)
        case fail(AXResult)
    }

    private static func capture(app: String?, region: CGRect?) -> CaptureOutcome {
        // Bring the target app to the FRONT before capturing: click_point clicks global
        // coordinates, so the window we OCR must be the one actually on top or the click
        // lands on whatever occludes it (it was clicking Terminal). The system doesn't
        // auto-foreground, so we raise via the AX grant. Small settle for the raise.
        if let app, !app.isEmpty {
            DispatchQueue.main.sync { _ = Foreground.bringToFront(app: app) }
            usleep(250_000)
        }
        // Content discovery triggers the Screen Recording prompt on first use.
        let contentResult: Result<SCShareableContent, Error> = wait { done in
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
                if let content { done(.success(content)) } else { done(.failure(error ?? timeoutError())) }
            }
        }
        let content: SCShareableContent
        switch contentResult {
        case .failure(let err): return .fail(deniedOrFailed(err, while: "listing screen content"))
        case .success(let c): content = c
        }

        let filter: SCContentFilter
        let rect: CGRect
        let label: String
        // Region capture resolves its display ONCE, up front, and reuses it for both the
        // filter and sourceRect — resolving twice with divergent fallbacks (one with
        // `?? .first`, one without) let a straddling/off-screen region capture the whole
        // fallback display while the OCR math still assumed the region, throwing every
        // coordinate off (review 🟡). regionDisplay is nil for the window branch.
        var regionDisplay: SCDisplay?
        if let region {
            guard let display = content.displays.first(where: { $0.frame.contains(CGPoint(x: region.midX, y: region.midY)) }) ?? content.displays.first else {
                return .fail(AXResult.failure("ax_unavailable", "No display found for that region."))
            }
            regionDisplay = display
            filter = SCContentFilter(display: display, excludingWindows: [])
            rect = region
            label = "region (\(Int(region.minX)),\(Int(region.minY)) \(Int(region.width))x\(Int(region.height)))"
        } else {
            guard let window = pickWindow(content: content, app: app) else {
                return .fail(AXResult.failure("element_not_found", app.map { "No on-screen window found for \"\($0)\"." } ?? "No frontmost window found."))
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            rect = window.frame
            let owner = window.owningApplication?.applicationName ?? "?"
            label = "window \"\(window.title ?? "")\" of \(owner) (\(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))x\(Int(rect.height)))"
        }

        let scale = CGFloat(filter.pointPixelScale)
        let cfg = SCStreamConfiguration()
        cfg.width = Int(rect.width * scale)
        cfg.height = Int(rect.height * scale)
        cfg.showsCursor = false
        cfg.captureResolution = .best
        if let region, let display = regionDisplay {
            // sourceRect is in display-local points (top-left origin) — the SAME display the
            // filter was built from, so the captured pixels and cap.rect can never disagree.
            cfg.sourceRect = region.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
        }

        let imageResult: Result<CGImage, Error> = wait { done in
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { image, error in
                if let image { done(.success(image)) } else { done(.failure(error ?? timeoutError())) }
            }
        }
        switch imageResult {
        case .failure(let err): return .fail(deniedOrFailed(err, while: "capturing"))
        case .success(let image): return .ok(Capture(image: image, rect: rect, scale: scale, label: label))
        }
    }

    /// Frontmost-or-named window pick: layer 0, on screen, largest area — mirrors the AX
    /// executor's app targeting (name match falls back to frontmost app's pid).
    private static func pickWindow(content: SCShareableContent, app: String?) -> SCWindow? {
        let pid: pid_t?
        if let app, !app.isEmpty {
            let running = NSWorkspace.shared.runningApplications
            let exact = running.first { $0.localizedName?.caseInsensitiveCompare(app) == .orderedSame }
            let loose = running.first { $0.localizedName?.range(of: app, options: .caseInsensitive) != nil }
            pid = (exact ?? loose)?.processIdentifier
        } else {
            pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        }
        let candidates = content.windows.filter { w in
            w.isOnScreen && w.windowLayer == 0 && (pid == nil || w.owningApplication?.processID == pid)
        }
        return candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
    }

    // MARK: OCR (on-device Vision)

    private static func ocr(app: String?, region: CGRect?) -> AXResult {
        let cap: Capture
        switch capture(app: app, region: region) {
        case .fail(let fail): return fail
        case .ok(let c): cap = c
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cgImage: cap.image)
        do {
            try handler.perform([request])
        } catch {
            return AXResult.failure("ax_unavailable", "OCR failed: \(error.localizedDescription)")
        }
        let observations = (request.results ?? [])
            .compactMap { obs -> (text: String, box: CGRect)? in
                guard let cand = obs.topCandidates(1).first, !cand.string.isEmpty else { return nil }
                return (cand.string, obs.boundingBox)
            }
            // Reading order: top-to-bottom (Vision origin is bottom-left → higher midY first), then left-to-right.
            .sorted { a, b in
                let ay = 1 - a.box.midY, by = 1 - b.box.midY
                return abs(ay - by) > 0.01 ? ay < by : a.box.midX < b.box.midX
            }
        if observations.isEmpty {
            return AXResult(ok: true, output: "\(cap.label)\nno text recognized — try screen_look for non-text UI, or a different region", errorKind: nil, health: nil)
        }
        var lines = ["\(cap.label) — \(observations.count) text lines (center coordinates are global points for click_point):"]
        for (i, obs) in observations.enumerated() {
            // Vision box: normalized, bottom-left origin, relative to the captured rect.
            let cx = cap.rect.minX + obs.box.midX * cap.rect.width
            let cy = cap.rect.minY + (1 - obs.box.midY) * cap.rect.height
            let w = obs.box.width * cap.rect.width
            let h = obs.box.height * cap.rect.height
            lines.append("T\(i + 1) \"\(obs.text)\" @ (\(Int(cx)),\(Int(cy))) \(Int(w))x\(Int(h))")
        }
        return AXResult(ok: true, output: lines.joined(separator: "\n"), errorKind: nil, health: nil)
    }

    // MARK: screenshot to file

    private static func screenshot(app: String?, region: CGRect?, outPath: String) -> AXResult {
        let cap: Capture
        switch capture(app: app, region: region) {
        case .fail(let fail): return fail
        case .ok(let c): cap = c
        }
        let url = URL(fileURLWithPath: outPath)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            return AXResult.failure("script_error", "Could not create \(outPath).")
        }
        CGImageDestinationAddImage(dest, cap.image, nil)
        guard CGImageDestinationFinalize(dest) else {
            return AXResult.failure("script_error", "Could not write \(outPath).")
        }
        return AXResult(
            ok: true,
            output: "captured \(cap.label) at scale \(Int(cap.scale))x → \(outPath)",
            errorKind: nil, health: nil
        )
    }

    // MARK: plumbing

    /// Blocking bridge for SCK's async-only APIs — MacBridge calls us on its own serial
    /// queue (never main), so parking on a semaphore is safe; the timeout keeps a wedged
    /// capture from stalling the loop (the daemon's RPC budget is the outer guard).
    private static func wait<T>(_ body: (@escaping (Result<T, Error>) -> Void) -> Void) -> Result<T, Error> {
        let sem = DispatchSemaphore(value: 0)
        let box = ResultBox<T>()
        body { r in
            box.set(r)
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + .milliseconds(captureTimeoutMs))
        return box.get() ?? .failure(timeoutError())
    }

    private final class ResultBox<T> {
        private var value: Result<T, Error>?
        private let lock = NSLock()
        func set(_ v: Result<T, Error>) { lock.lock(); value = v; lock.unlock() }
        func get() -> Result<T, Error>? { lock.lock(); defer { lock.unlock() }; return value }
    }

    private static func timeoutError() -> Error {
        NSError(domain: "ai.scalinity.gumbo.vision", code: -2, userInfo: [NSLocalizedDescriptionKey: "capture timed out"])
    }

    /// Screen Recording denial → typed capture_denied (the daemon tells the user exactly
    /// what to grant); everything else keeps its message with a generic kind.
    private static func deniedOrFailed(_ err: Error, while what: String) -> AXResult {
        let ns = err as NSError
        let text = ns.localizedDescription
        let denied = ns.domain == SCStreamErrorDomain
            ? (ns.code == SCStreamError.Code.userDeclined.rawValue || text.localizedCaseInsensitiveContains("declin") || text.localizedCaseInsensitiveContains("permi"))
            : !CGPreflightScreenCaptureAccess()
        if denied {
            return AXResult.failure("capture_denied", "Screen Recording is not granted (\(text)).")
        }
        if ns.code == -2 && ns.domain == "ai.scalinity.gumbo.vision" {
            return AXResult.failure("timeout", "Timed out \(what).")
        }
        return AXResult.failure("ax_unavailable", "Failed \(what): \(text)")
    }
}
