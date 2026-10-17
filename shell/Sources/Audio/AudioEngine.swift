import AVFoundation
import Foundation

/// Capture + playback for the voice loop. Two graph modes so the mic is only open while
/// push-to-talk actually needs it (the macOS orange indicator tracks the input unit, not
/// whether frames are streamed):
///   · duplex — Voice-Processing I/O + input tap (spike 1a/1b findings: AEC so Gumbo on
///     speakers doesn't trigger its own barge-in, AGC, Bluetooth full-duplex). Used from
///     ⌃⌥ press until the conversation goes idle.
///   · playbackOnly — player graph only, inputNode never touched → no mic indicator.
///     Used for spoken replies and M3 announcements arriving with no press.
/// A ⌃⌥ press mid-playback swaps the graph live: unscheduled audio survives the switch
/// (the in-flight buffers — a fraction of a second — are lost, accepted).
/// Gotcha -10851: with VPIO the graph must stay in the unit's native I/O format — all PCM
/// conversion happens at the buffer level. Gotcha -10875: build the playback graph BEFORE
/// enabling VPIO. `start(reason:)` is the wake-word seam: a future `.wakeWord` reason runs
/// the same duplex tap into a local detector first.
final class AudioEngine {
    enum StartReason { case ptt, playback }
    private enum Mode { case duplex, playbackOnly }

    var onMicFrame: ((Data) -> Void)?
    var onCaptureReady: (() -> Void)?
    var onMicLevel: ((Float) -> Void)?
    var onPlaybackLevel: ((Float) -> Void)?
    var onPlaybackStateChange: ((Bool) -> Void)? // true while queued audio is draining
    // Absolute wire-format frame counters for the current playback stream: (played,
    // enqueued). Generation runs several× faster than speech, so transcript display paces
    // against these. ABSOLUTE counts, not a fraction: a fraction's denominator grows when a
    // second response's audio lands mid-drain, which shoved the ratio below a caller's
    // captured baseline and froze the notch transcript for most of the reply (the
    // "transcript lags behind" bug, 2026-07-16). Counters reset to 0 on full drain/flush —
    // callers detect the reset by the counts going backwards.
    var onPlaybackProgress: ((Int, Int) -> Void)?
    var onError: ((String) -> Void)?

    /// 24 kHz mono interleaved Int16 — the Realtime API wire format both directions.
    private let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!

    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var mode: Mode?
    private var captureConverter: AVAudioConverter?
    private var captureMonoFormat: AVAudioFormat?
    private var captureInputFormat: AVAudioFormat?
    private var playbackConverter: AVAudioConverter?
    private var playFormat: AVAudioFormat?
    private var loggedChannelPeaks = false

    private let lock = NSLock()
    // Device activation can block for seconds on a cold VPIO graph. Keep every graph
    // mutation on this queue so neither notch animation nor key releases wait for it.
    private let graphQueue = DispatchQueue(label: "ai.Gumbo.app.audio.graph", qos: .userInitiated)
    // All pop→convert→schedule work is serialized here. playChunk (main) and buffer
    // completion handlers (audio thread) both used to run the pump concurrently, which
    // could schedule chunks out of order, schedule a stale buffer after a barge-in
    // flush, or schedule onto a dead player mid graph-switch (wedging inFlight forever).
    private let pumpQueue = DispatchQueue(label: "ai.Gumbo.app.audio.pump")
    private var armed = false
    private var inFlight = 0 // buffers scheduled on the player, not yet played back
    private var generation = 0 // invalidates completion handlers of flushed buffers
    private var drainingActive = false
    private var micPermission = false
    private var running = false
    private var lastStartFailure: Date?
    private var startRetry: DispatchWorkItem?
    // Device formats can briefly be zero while VPIO releases/reacquires the output.
    var outputSampleRate: (AVAudioEngine) -> Double = { $0.outputNode.outputFormat(forBus: 0).sampleRate }
    private var captureRequest = 0
    private var captureReadySent = false
    private var lifecycleVersion = 0
    private var configurationObserver: NSObjectProtocol?
    private var playbackWatchdog: DispatchSourceTimer?
    private var inFlightFrames = 0
    private var playbackDeadline: Date?
    // Unscheduled pcm chunks. Also the pre-start queue (spoken reply with no prior press)
    // and what carries playback across a live playbackOnly → duplex graph switch.
    // Cap sized for multi-minute report reads: 4096 × ~200 ms chunks ≫ any real reply
    // (the old 512 could overflow → dropped chunks → skipped audio mid-read).
    private var playbackQueue: [Data] = []
    // Head cursor instead of removeFirst(): draining a multi-minute read would otherwise
    // shift the whole array per scheduled buffer (O(n²) over the stream). Compacted
    // periodically so consumed chunks don't pin memory.
    private var queueHead = 0
    // Wire-format (24 kHz) frame counters for the current playback stream; reset when
    // the stream fully drains or is flushed.
    private var framesEnqueued = 0
    private var framesPlayed = 0

    /// Callers must hold `lock`.
    private var queueIsEmpty: Bool { queueHead >= playbackQueue.count }

    // MARK: lifecycle

    func start(reason: StartReason) {
        lock.lock()
        let version = lifecycleVersion
        lock.unlock()
        graphQueue.async { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let current = version == self.lifecycleVersion
            self.lock.unlock()
            if current { self.startNow(reason: reason) }
        }
    }

    private func startNow(reason: StartReason) {
        switch reason {
        case .playback:
            // Playback never needs the mic. If a duplex engine is already up (armed
            // conversation), play through it — VPIO's echo cancellation even helps.
            if !running { switchTo(.playbackOnly) }
        case .ptt:
            lock.lock()
            let needsCapture = armed
            lock.unlock()
            guard needsCapture else { return }
            if running && mode == .duplex { return }
            if micPermission {
                switchTo(.duplex)
                return
            }
            lock.lock()
            captureRequest += 1
            let request = captureRequest
            lock.unlock()
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                self?.graphQueue.async { [weak self] in
                    guard let self else { return }
                    self.lock.lock()
                    let current = request == self.captureRequest && self.armed
                    self.lock.unlock()
                    guard current else { return }
                    self.micPermission = granted
                    guard granted else {
                        self.reportError("Microphone access is unavailable. Enable Gumbo in Privacy & Security.")
                        return
                    }
                    self.lock.lock()
                    let stillArmed = self.armed
                    self.lock.unlock()
                    if stillArmed { self.switchTo(.duplex) }
                }
            }
        }
    }

    func stop() {
        setArmed(false)
        lock.lock()
        lifecycleVersion += 1
        lock.unlock()
        graphQueue.async { self.stopEngine(keepQueue: false) }
    }

    /// Close hardware I/O while retaining the configured graph for the next press.
    /// Rebuilding VPIO on every idle timeout adds seconds before input can arrive.
    func suspend() {
        setArmed(false)
        lock.lock()
        lifecycleVersion += 1
        lock.unlock()
        graphQueue.async { self.stopEngine(keepQueue: false, keepGraph: true) }
    }

    private func switchTo(_ target: Mode) {
        if mode == target {
            if running { return }
            if let engine, outputSampleRate(engine) == playFormat?.sampleRate,
               target != .duplex || engine.inputNode.outputFormat(forBus: 0) == captureInputFormat {
                lock.lock()
                let version = lifecycleVersion
                lock.unlock()
                activateGraph(startVersion: version)
                return
            }
        }
        if engine != nil {
            stopEngine(keepQueue: true) // keep queued audio: press-and-stay-silent must still hear the rest
        }
        setupAndStart(target)
    }

    private func stopEngine(keepQueue: Bool, keepGraph: Bool = false) {
        startRetry?.cancel()
        startRetry = nil
        playbackWatchdog?.cancel()
        playbackWatchdog = nil
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        lock.lock()
        running = false
        captureRequest += 1
        captureReadySent = false
        generation += 1
        inFlight = 0
        inFlightFrames = 0
        playbackDeadline = nil
        if !keepQueue {
            playbackQueue = []
            queueHead = 0
            framesEnqueued = 0
            framesPlayed = 0
        } else {
            // Scheduled buffers are lost with the old graph. Count only retained audio
            // in the new stream so transcript pacing cannot wait for discarded frames.
            framesPlayed = 0
            framesEnqueued = playbackQueue.dropFirst(queueHead).reduce(0) { $0 + $1.count / 2 }
        }
        let queueEmpty = queueIsEmpty
        lock.unlock()
        pumpQueue.sync {}
        if !keepGraph, mode == .duplex { engine?.inputNode.removeTap(onBus: 0) }
        player?.stop()
        engine?.stop()
        captureConverter?.reset()
        playbackConverter?.reset()
        if !keepGraph {
            engine = nil
            player = nil
            mode = nil
            captureConverter = nil
            captureMonoFormat = nil
            captureInputFormat = nil
            playbackConverter = nil
            playFormat = nil
        }
        if queueEmpty { setDraining(false) }
        NSLog("[audio] engine stopped%@", keepQueue && !queueEmpty ? " (graph switch, queue retained)" : "")
    }

    func setArmed(_ value: Bool) {
        lock.lock()
        if !value { captureRequest += 1 }
        armed = value
        captureReadySent = false
        lock.unlock()
        if !value { onMicLevel?(0) }
    }

    // MARK: playback

    /// Incoming speaker pcm16 (arbitrary chunk sizes) → queue → player. Chunks arriving
    /// before any engine is up wait in the queue and drain on the next start.
    func playChunk(_ pcm: Data) {
        guard !pcm.isEmpty, pcm.count.isMultiple(of: 2) else { return }
        graphQueue.async { [weak self] in self?.enqueuePlayback(pcm) }
    }

    private func enqueuePlayback(_ pcm: Data) {
        lock.lock()
        if !running && lastStartFailure != nil { lock.unlock(); return }
        playbackQueue.append(pcm)
        if playbackQueue.count - queueHead > 4096 { queueHead += 1 } // drop-oldest cap
        if queueHead > 1024 { // compact consumed prefix
            playbackQueue.removeFirst(queueHead)
            queueHead = 0
        }
        framesEnqueued += pcm.count / MemoryLayout<Int16>.size
        lock.unlock()
        pumpPlayback() // pump self-guards on running under the lock
    }

    /// Keep a few buffers scheduled ahead; the rest stays as Data in the queue so a graph
    /// switch or flush loses at most the in-flight fraction, never the whole stream.
    /// Serialized on pumpQueue — see the property comment for the races this prevents.
    private func pumpPlayback() {
        pumpQueue.async { [weak self] in self?.pumpNow() }
    }

    private func pumpNow() {
        while true {
            lock.lock()
            guard running, let player, let playFormat, let converter = playbackConverter,
                  inFlight < 3, !queueIsEmpty else {
                lock.unlock()
                return
            }
            let pcm = playbackQueue[queueHead]
            queueHead += 1
            inFlight += 1
            let gen = generation
            let wireFrames = pcm.count / MemoryLayout<Int16>.size
            lock.unlock()

            guard let outBuf = convertForPlayback(pcm, converter: converter, to: playFormat) else {
                lock.lock()
                if gen == generation { inFlight -= 1; framesEnqueued -= wireFrames }
                let drained = gen == generation && inFlight == 0 && queueIsEmpty
                lock.unlock()
                if drained { setDraining(false) }
                continue
            }
            if let ch = outBuf.floatChannelData?[0] {
                var peak: Float = 0
                for i in 0..<Int(outBuf.frameLength) { peak = max(peak, abs(ch[i])) }
                onPlaybackLevel?(peak)
            }

            // Re-check right before scheduling: a flush or graph teardown that landed
            // during the convert must drop this buffer, never schedule it stale.
            lock.lock()
            let stillLive = gen == generation && running
            if stillLive {
                inFlightFrames += wireFrames
                playbackDeadline = Date().addingTimeInterval(Double(inFlightFrames) / 24_000 + 3)
            }
            lock.unlock()
            if !stillLive { continue }

            player.scheduleBuffer(outBuf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                guard let self else { return }
                // All queue consumption and completion decisions share one ordering.
                self.pumpQueue.async { [weak self] in
                    guard let self else { return }
                    self.lock.lock()
                    guard gen == self.generation else { self.lock.unlock(); return }
                    self.inFlight -= 1
                    self.inFlightFrames -= wireFrames
                    self.playbackDeadline = self.inFlight > 0
                        ? Date().addingTimeInterval(Double(self.inFlightFrames) / 24_000 + 3) : nil
                    self.framesPlayed += wireFrames
                    let progress = (self.framesPlayed, self.framesEnqueued)
                    let drained = self.inFlight == 0 && self.queueIsEmpty
                    if drained { self.framesEnqueued = 0; self.framesPlayed = 0 }
                    self.lock.unlock()
                    DispatchQueue.main.async { [weak self] in
                        guard let self else { return }
                        self.lock.lock()
                        let live = gen == self.generation
                        self.lock.unlock()
                        if live { self.onPlaybackProgress?(progress.0, progress.1) }
                    }
                    if drained { self.setDraining(false) }
                    else { self.pumpNow() }
                }
            }
            setDraining(true)
            if !player.isPlaying { player.play() }
        }
    }

    private func convertForPlayback(_ pcm: Data, converter: AVAudioConverter, to playFormat: AVAudioFormat) -> AVAudioPCMBuffer? {
        let inFrames = pcm.count / MemoryLayout<Int16>.size
        guard inFrames > 0,
              let inBuf = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: AVAudioFrameCount(inFrames))
        else { return nil }
        inBuf.frameLength = AVAudioFrameCount(inFrames)
        pcm.withUnsafeBytes { raw in
            inBuf.int16ChannelData![0].update(from: raw.bindMemory(to: Int16.self).baseAddress!, count: inFrames)
        }

        let ratio = playFormat.sampleRate / wireFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(inFrames) * ratio) + 32
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: capacity) else { return nil }
        var provided = false
        var convErr: NSError?
        let status = converter.convert(to: outBuf, error: &convErr) { _, outStatus in
            if provided { outStatus.pointee = .noDataNow; return nil }
            provided = true
            outStatus.pointee = .haveData
            return inBuf
        }
        guard status != .error, outBuf.frameLength > 0 else { return nil }
        return outBuf
    }

    /// Barge-in: drop everything queued, immediately.
    func flushPlayback() {
        graphQueue.async { [weak self] in self?.flushPlaybackNow() }
    }

    private func flushPlaybackNow() {
        lock.lock()
        generation += 1
        inFlight = 0
        inFlightFrames = 0
        playbackDeadline = nil
        playbackQueue = []
        queueHead = 0
        framesEnqueued = 0
        framesPlayed = 0
        lock.unlock()
        // Fence: an in-flight pump sees the bumped generation and drops its buffer, and
        // can't be mid-convert while the converter is reset below.
        pumpQueue.sync {}
        player?.stop()
        playbackConverter?.reset()
        if running, let player, let engine, engine.isRunning {
            player.play() // ready for the next reply
        }
        setDraining(false)
    }

    private func setDraining(_ value: Bool) {
        lock.lock()
        let changed = drainingActive != value
        drainingActive = value
        let gen = generation
        lock.unlock()
        guard changed else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let current = self.generation == gen && self.drainingActive == value
            self.lock.unlock()
            guard current else { return }
            NSLog("[audio] playback %@", value ? "active" : "drained")
            self.onPlaybackStateChange?(value)
        }
    }

    // MARK: engine graph

    private func setupAndStart(_ target: Mode, attempt: Int = 0) {
        guard !running, startRetry == nil else { return }
        if let last = lastStartFailure, Date().timeIntervalSince(last) < 3 { return } // no retry storms
        lock.lock()
        let startVersion = lifecycleVersion
        lock.unlock()
        let engine = AVAudioEngine()

        // Order is load-bearing (probed on this macOS 27 beta): materialize the playback
        // graph FIRST, then (duplex only) enable VPIO — enabling VPIO before touching
        // mainMixerNode makes engine start fail with -10875 (output unit kAUInitialize).
        let player = AVAudioPlayerNode()
        engine.attach(player)
        // Keep the connection in a native-rate format (mono float at the output hardware rate);
        // a 24 kHz connection here is the exact -10851 trap from the spike.
        let hwRate = outputSampleRate(engine)
        if hwRate <= 0 && attempt < 6 {
            let retry = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.startRetry = nil
                self.lock.lock()
                let current = self.lifecycleVersion == startVersion
                let needsMic = self.armed
                self.lock.unlock()
                guard current else { return }
                let nextMode: Mode = needsMic && self.micPermission ? .duplex : .playbackOnly
                self.setupAndStart(nextMode, attempt: attempt + 1)
            }
            startRetry = retry
            graphQueue.asyncAfter(deadline: .now() + 0.25, execute: retry)
            return
        }
        guard hwRate > 0,
              let playFormat = AVAudioFormat(standardFormatWithSampleRate: hwRate, channels: 1),
              let outputConverter = AVAudioConverter(from: wireFormat, to: playFormat) else {
            failStart("No usable audio output device is available.")
            return
        }
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        self.playFormat = playFormat
        playbackConverter = outputConverter

        if target == .duplex {
            let input = engine.inputNode
            do {
                try input.setVoiceProcessingEnabled(true)
            } catch {
                NSLog("[audio] voice processing unavailable (\(error)) — echo cancellation degraded")
            }
            // Preparation settles VPIO's discrete input layout before the tap is
            // installed; reading it earlier can see the pre-switch three-channel bus.
            engine.prepare()

            // Input format only settles after the VPIO switch — here a 48 kHz **9-channel**
            // array with a discrete layout. AVAudioConverter does NOT downmix discrete
            // multichannel to mono (its default channel map produced pure silence — live-debug
            // finding); the voice-processed signal is on channel 0, so captureTapped extracts
            // ch0 into a mono buffer and the converter only ever does mono float → mono int16.
            let hwInFormat = input.outputFormat(forBus: 0)
            guard hwInFormat.sampleRate > 0, hwInFormat.channelCount > 0,
                  let monoIn = AVAudioFormat(standardFormatWithSampleRate: hwInFormat.sampleRate, channels: 1),
                  let inputConverter = AVAudioConverter(from: monoIn, to: wireFormat) else {
                failStart("No usable microphone input device is available.")
                return
            }
            captureMonoFormat = monoIn
            captureInputFormat = hwInFormat
            captureConverter = inputConverter
            loggedChannelPeaks = false

            input.installTap(onBus: 0, bufferSize: 1024, format: hwInFormat) { [weak self] buffer, _ in
                self?.captureTapped(buffer)
            }
            NSLog("[audio] input %.0f Hz/%d ch, VPIO %@", hwInFormat.sampleRate,
                  hwInFormat.channelCount, input.isVoiceProcessingEnabled ? "on" : "OFF")
        }

        engine.prepare()
        lock.lock()
        let startStillWanted = startVersion == lifecycleVersion
        if startStillWanted {
            self.engine = engine
            self.player = player
            self.mode = target
        }
        lock.unlock()
        guard startStillWanted else {
            if target == .duplex { engine.inputNode.removeTap(onBus: 0) }
            return
        }
        activateGraph(startVersion: startVersion)
    }

    private func activateGraph(startVersion: Int) {
        guard let engine, player != nil, let target = mode else { return }
        do {
            lock.lock()
            let startStillWanted = startVersion == lifecycleVersion
            lock.unlock()
            guard startStillWanted else {
                return
            }
            try engine.start()
            // Under the lock: the pump reads running + graph refs together and must
            // never observe running == true with half-assigned refs.
            lock.lock()
            guard startVersion == lifecycleVersion else {
                lock.unlock()
                engine.stop()
                return
            }
            running = true
            lastStartFailure = nil
            lock.unlock()
            let watchdog = DispatchSource.makeTimerSource(queue: graphQueue)
            watchdog.schedule(deadline: .now() + 1, repeating: 1)
            watchdog.setEventHandler { [weak self] in
                guard let self else { return }
                self.lock.lock()
                let stalled = self.playbackDeadline.map { $0 < Date() } ?? false
                self.lock.unlock()
                if stalled {
                    self.stopEngine(keepQueue: false)
                    self.reportError("Audio playback stopped responding. Try speaking again.")
                }
            }
            playbackWatchdog = watchdog
            watchdog.resume()
            configurationObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
            ) { [weak self, weak engine] _ in
                self?.graphQueue.async { [weak self, weak engine] in
                    guard let self, let engine, engine === self.engine else { return }
                    self.configurationChangedNow()
                }
            }
            NSLog("[audio] engine started (%@), output %.0f Hz",
                  target == .duplex ? "duplex" : "playback-only", playFormat?.sampleRate ?? 0)
            pumpPlayback() // drain anything queued before/across the start
        } catch {
            stopEngine(keepQueue: false)
            failStart("Audio engine could not start (\((error as NSError).code)).")
        }
    }

    func configurationChanged() {
        graphQueue.async { [weak self] in self?.configurationChangedNow() }
    }

    private func configurationChangedNow() {
        guard let currentMode = mode else { return }
        lock.lock()
        let needsMic = armed
        lock.unlock()
        stopEngine(keepQueue: true)
        lock.lock()
        lastStartFailure = nil
        lock.unlock()
        setupAndStart(needsMic && currentMode == .duplex ? .duplex : .playbackOnly)
    }

    private func captureTapped(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let isArmed = armed
        lock.unlock()
        guard isArmed, let converter = captureConverter, let monoFormat = captureMonoFormat,
              let src = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        let frames = Int(buffer.frameLength)

        // One-shot diagnostic per engine start: which channels actually carry signal?
        if !loggedChannelPeaks {
            loggedChannelPeaks = true
            let peaks = (0..<Int(buffer.format.channelCount)).map { ch -> String in
                var p: Float = 0
                for i in 0..<frames { p = max(p, abs(src[ch][i])) }
                return String(format: "%.3f", p)
            }
            NSLog("[audio] capture channel peaks: [%@]", peaks.joined(separator: " "))
        }

        var peak: Float = 0
        for i in 0..<frames { peak = max(peak, abs(src[0][i])) }
        onMicLevel?(peak)

        // ch0 → mono buffer (the converter must never see the discrete 9-ch layout).
        guard let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
        mono.frameLength = AVAudioFrameCount(frames)
        mono.floatChannelData![0].update(from: src[0], count: frames)

        let ratio = wireFormat.sampleRate / monoFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(frames) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
        var provided = false
        var convErr: NSError?
        let status = converter.convert(to: out, error: &convErr) { _, outStatus in
            if provided { outStatus.pointee = .noDataNow; return nil }
            provided = true
            outStatus.pointee = .haveData
            return mono
        }
        if status == .error || convErr != nil {
            NSLog("[audio] capture convert failed: %@", convErr?.localizedDescription ?? "unknown")
            return
        }
        guard out.frameLength > 0, let samples = out.int16ChannelData else { return }
        let data = Data(bytes: samples[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
        lock.lock()
        let announceReady = armed && !captureReadySent
        captureReadySent = true
        let request = captureRequest
        lock.unlock()
        if announceReady {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.lock.lock()
                let current = self.armed && self.captureRequest == request
                self.lock.unlock()
                if current { self.onCaptureReady?() }
            }
        }
        onMicFrame?(data)
    }

    private func failStart(_ message: String) {
        lock.lock()
        lastStartFailure = Date()
        lock.unlock()
        captureConverter = nil
        playbackConverter = nil
        flushPlaybackNow()
        NSLog("[audio] %@", message)
        reportError(message)
    }

    private func reportError(_ message: String) {
        DispatchQueue.main.async { [weak self] in self?.onError?(message) }
    }
}
