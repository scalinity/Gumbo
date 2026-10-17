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
    private var playbackConverter: AVAudioConverter?
    private var playFormat: AVAudioFormat?
    private var loggedChannelPeaks = false

    private let lock = NSLock()
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
    private var captureRequest = 0
    private var configurationObserver: NSObjectProtocol?
    private var playbackWatchdog: Timer?
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
        switch reason {
        case .playback:
            // Playback never needs the mic. If a duplex engine is already up (armed
            // conversation), play through it — VPIO's echo cancellation even helps.
            if !running { setupAndStart(.playbackOnly) }
        case .ptt:
            if running && mode == .duplex { return }
            if micPermission {
                switchTo(.duplex)
                return
            }
            captureRequest += 1
            let request = captureRequest
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self, request == self.captureRequest else { return }
                    self.micPermission = granted
                    guard granted else {
                        self.onError?("Microphone access is unavailable. Enable Gumbo in Privacy & Security.")
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
        captureRequest += 1
        setArmed(false)
        stopEngine(keepQueue: false)
    }

    private func switchTo(_ target: Mode) {
        if running {
            if mode == target { return }
            stopEngine(keepQueue: true) // keep queued audio: press-and-stay-silent must still hear the rest
        }
        setupAndStart(target)
    }

    private func stopEngine(keepQueue: Bool) {
        playbackWatchdog?.invalidate()
        playbackWatchdog = nil
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        lock.lock()
        running = false
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
        if mode == .duplex { engine?.inputNode.removeTap(onBus: 0) }
        player?.stop()
        engine?.stop()
        engine = nil
        player = nil
        mode = nil
        captureConverter = nil
        captureMonoFormat = nil
        playbackConverter = nil
        playFormat = nil
        if queueEmpty { setDraining(false) }
        NSLog("[audio] engine stopped%@", keepQueue && !queueEmpty ? " (graph switch, queue retained)" : "")
    }

    func setArmed(_ value: Bool) {
        if !value { captureRequest += 1 }
        lock.lock()
        armed = value
        lock.unlock()
        if !value { onMicLevel?(0) }
    }

    // MARK: playback

    /// Incoming speaker pcm16 (arbitrary chunk sizes) → queue → player. Chunks arriving
    /// before any engine is up wait in the queue and drain on the next start.
    func playChunk(_ pcm: Data) {
        guard !pcm.isEmpty, pcm.count.isMultiple(of: 2) else { return }
        if !running && lastStartFailure != nil { return }
        lock.lock()
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

    private func setupAndStart(_ target: Mode) {
        guard !running else { return }
        if let last = lastStartFailure, Date().timeIntervalSince(last) < 3 { return } // no retry storms
        let engine = AVAudioEngine()

        // Order is load-bearing (probed on this macOS 27 beta): materialize the playback
        // graph FIRST, then (duplex only) enable VPIO — enabling VPIO before touching
        // mainMixerNode makes engine start fail with -10875 (output unit kAUInitialize).
        let player = AVAudioPlayerNode()
        engine.attach(player)
        // Keep the connection in a native-rate format (mono float at the output hardware rate);
        // a 24 kHz connection here is the exact -10851 trap from the spike.
        let hwRate = engine.outputNode.outputFormat(forBus: 0).sampleRate
        guard hwRate > 0,
              let playFormat = AVAudioFormat(standardFormatWithSampleRate: hwRate, channels: 1),
              let outputConverter = AVAudioConverter(from: wireFormat, to: playFormat) else {
            failStart("No usable audio output device is available.")
            return
        }
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        self.playFormat = playFormat
        playbackConverter = outputConverter

        var inDescription = "none (playback-only, mic untouched)"
        if target == .duplex {
            let input = engine.inputNode
            do {
                try input.setVoiceProcessingEnabled(true)
            } catch {
                NSLog("[audio] voice processing unavailable (\(error)) — echo cancellation degraded")
            }

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
            captureConverter = inputConverter
            loggedChannelPeaks = false

            input.installTap(onBus: 0, bufferSize: 1024, format: hwInFormat) { [weak self] buffer, _ in
                self?.captureTapped(buffer)
            }
            inDescription = String(format: "%.0f Hz/%d ch, VPIO %@", hwInFormat.sampleRate,
                                   hwInFormat.channelCount, input.isVoiceProcessingEnabled ? "on" : "OFF")
        }

        engine.prepare()
        do {
            try engine.start()
            // Under the lock: the pump reads running + graph refs together and must
            // never observe running == true with half-assigned refs.
            lock.lock()
            self.engine = engine
            self.player = player
            self.mode = target
            running = true
            lock.unlock()
            lastStartFailure = nil
            let watchdog = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                let stalled = self.playbackDeadline.map { $0 < Date() } ?? false
                self.lock.unlock()
                if stalled {
                    self.stopEngine(keepQueue: false)
                    self.onError?("Audio playback stopped responding. Try speaking again.")
                }
            }
            playbackWatchdog = watchdog
            RunLoop.main.add(watchdog, forMode: .common)
            configurationObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self, weak engine] _ in
                guard let self, let engine, engine === self.engine else { return }
                self.configurationChanged()
            }
            NSLog("[audio] engine started (%@) — in %@, out %.0f Hz",
                  target == .duplex ? "duplex" : "playback-only", inDescription, hwRate)
            pumpPlayback() // drain anything queued before/across the start
        } catch {
            if target == .duplex { engine.inputNode.removeTap(onBus: 0) }
            failStart("Audio engine could not start (\((error as NSError).code)).")
        }
    }

    func configurationChanged() {
        guard let currentMode = mode else { return }
        lock.lock()
        let needsMic = armed
        lock.unlock()
        stopEngine(keepQueue: true)
        lastStartFailure = nil
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
        onMicFrame?(data)
    }

    private func failStart(_ message: String) {
        lastStartFailure = Date()
        captureConverter = nil
        playbackConverter = nil
        flushPlayback()
        NSLog("[audio] %@", message)
        onError?(message)
    }
}
