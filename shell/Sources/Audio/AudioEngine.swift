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
    // Fraction (0–1) of this playback stream actually *heard* so far. Generation runs
    // several× faster than speech, so transcript display must pace against this, not
    // against delta arrival, for read-along to work on long report reads.
    var onPlaybackProgress: ((Double) -> Void)?

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
    private let pumpQueue = DispatchQueue(label: "ai.scalinity.gumbo.audio.pump")
    private var armed = false
    private var inFlight = 0 // buffers scheduled on the player, not yet played back
    private var generation = 0 // invalidates completion handlers of flushed buffers
    private var drainingActive = false
    private var micPermission = false
    private var running = false
    private var lastStartFailure: Date?
    // Unscheduled pcm chunks. Also the pre-start queue (spoken reply with no prior press)
    // and what carries playback across a live playbackOnly → duplex graph switch.
    // Cap sized for multi-minute report reads: 4096 × ~200 ms chunks ≫ any real reply
    // (the old 512 could overflow → dropped chunks → skipped audio mid-read).
    private var playbackQueue: [Data] = []
    // Wire-format (24 kHz) frame counters for the current playback stream; reset when
    // the stream fully drains or is flushed.
    private var framesEnqueued = 0
    private var framesPlayed = 0

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
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                guard let self, granted else {
                    NSLog("[audio] microphone denied — enable Gumbo in System Settings > Privacy & Security")
                    return
                }
                self.micPermission = true
                DispatchQueue.main.async { self.switchTo(.duplex) }
            }
        }
    }

    func stop() {
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
        lock.lock()
        guard running else { lock.unlock(); return }
        running = false
        generation += 1 // completion handlers of dying buffers become stale
        inFlight = 0
        if !keepQueue {
            playbackQueue = []
            framesEnqueued = 0
            framesPlayed = 0
        }
        let queueEmpty = playbackQueue.isEmpty
        lock.unlock()
        pumpQueue.sync {} // fence: no pump body is mid-flight while the graph is torn down
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
        lock.lock()
        armed = value
        lock.unlock()
        if !value { onMicLevel?(0) }
    }

    // MARK: playback

    /// Incoming speaker pcm16 (arbitrary chunk sizes) → queue → player. Chunks arriving
    /// before any engine is up wait in the queue and drain on the next start.
    func playChunk(_ pcm: Data) {
        lock.lock()
        playbackQueue.append(pcm)
        if playbackQueue.count > 4096 { playbackQueue.removeFirst() }
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
                  inFlight < 3, !playbackQueue.isEmpty else {
                lock.unlock()
                return
            }
            let pcm = playbackQueue.removeFirst()
            inFlight += 1
            let gen = generation
            let wireFrames = pcm.count / MemoryLayout<Int16>.size
            lock.unlock()

            guard let outBuf = convertForPlayback(pcm, converter: converter, to: playFormat) else {
                lock.lock()
                if gen == generation { inFlight -= 1 }
                lock.unlock()
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
            lock.unlock()
            if !stillLive { continue }

            player.scheduleBuffer(outBuf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                let live = gen == self.generation
                var progress: Double? = nil
                if live {
                    self.inFlight -= 1
                    self.framesPlayed += wireFrames
                    if self.framesEnqueued > 0 {
                        progress = Double(self.framesPlayed) / Double(self.framesEnqueued)
                    }
                }
                let drained = live && self.inFlight == 0 && self.playbackQueue.isEmpty
                if drained { // stream over — next playback stream starts its own ratio
                    self.framesEnqueued = 0
                    self.framesPlayed = 0
                }
                self.lock.unlock()
                if let progress { self.onPlaybackProgress?(min(1, progress)) }
                if drained {
                    self.setDraining(false)
                } else if live {
                    self.pumpPlayback()
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
        playbackQueue = []
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
        lock.unlock()
        guard changed else { return }
        if value { NSLog("[audio] playback active") }
        onPlaybackStateChange?(value)
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
        let playFormat = AVAudioFormat(standardFormatWithSampleRate: hwRate, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        self.playFormat = playFormat
        playbackConverter = AVAudioConverter(from: wireFormat, to: playFormat)

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
            let monoIn = AVAudioFormat(standardFormatWithSampleRate: hwInFormat.sampleRate, channels: 1)!
            captureMonoFormat = monoIn
            captureConverter = AVAudioConverter(from: monoIn, to: wireFormat)
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
            NSLog("[audio] engine started (%@) — in %@, out %.0f Hz",
                  target == .duplex ? "duplex" : "playback-only", inDescription, hwRate)
            pumpPlayback() // drain anything queued before/across the start
        } catch {
            NSLog("[audio] engine start failed: \(error)")
            lastStartFailure = Date()
            if target == .duplex { engine.inputNode.removeTap(onBus: 0) }
            captureConverter = nil
            playbackConverter = nil
        }
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
}
