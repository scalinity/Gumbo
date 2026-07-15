import AVFoundation
import Foundation

/// Capture + playback for the voice loop, built on Voice-Processing I/O (spike 1a/1b findings):
/// VPIO gives acoustic echo cancellation (Gumbo on speakers doesn't trigger its own barge-in),
/// automatic gain, and Bluetooth full-duplex (plain taps go silent on AirPods-as-mic).
/// Gotcha -10851: with VPIO the graph must stay in the unit's native I/O format — all PCM
/// conversion happens at the buffer level (capture → 24 kHz mono pcm16 wire format; incoming
/// wire pcm16 → hardware-rate float for playback). `start(reason:)` is the wake-word seam:
/// a future `.wakeWord` reason runs the same tap into a local detector first.
final class AudioEngine {
    enum StartReason { case ptt, playback }

    var onMicFrame: ((Data) -> Void)?
    var onMicLevel: ((Float) -> Void)?
    var onPlaybackLevel: ((Float) -> Void)?
    var onPlaybackStateChange: ((Bool) -> Void)? // true while queued audio is draining

    /// 24 kHz mono interleaved Int16 — the Realtime API wire format both directions.
    private let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!

    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var captureConverter: AVAudioConverter?
    private var captureMonoFormat: AVAudioFormat?
    private var playbackConverter: AVAudioConverter?
    private var playFormat: AVAudioFormat?
    private var loggedChannelPeaks = false

    private let lock = NSLock()
    private var armed = false
    private var pendingBuffers = 0
    private var generation = 0 // invalidates completion handlers of flushed buffers
    private var micPermission = false
    private var running = false
    private var lastStartFailure: Date?
    // Chunks that arrive before the engine is up (first spoken reply of a session with no
    // prior ⌃⌥ press — dashboard text turns, M3 announcements). Drained on engine start.
    private var pendingPlayback: [Data] = []

    // MARK: lifecycle

    func start(reason: StartReason) {
        guard !running else { return }
        if micPermission {
            setupAndStart()
            return
        }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            guard let self, granted else {
                NSLog("[audio] microphone denied — enable Gumbo in System Settings > Privacy & Security")
                return
            }
            self.micPermission = true
            DispatchQueue.main.async { self.setupAndStart() }
        }
    }

    func stop() {
        guard running else { return }
        running = false
        engine?.inputNode.removeTap(onBus: 0)
        player?.stop()
        engine?.stop()
        engine = nil
        player = nil
        captureConverter = nil
        playbackConverter = nil
        playFormat = nil
        setDraining(false)
        NSLog("[audio] engine stopped (idle)")
    }

    func setArmed(_ value: Bool) {
        lock.lock()
        armed = value
        lock.unlock()
        if !value { onMicLevel?(0) }
    }

    // MARK: playback

    /// Incoming speaker pcm16 (arbitrary chunk sizes) → hardware-rate float → player queue.
    func playChunk(_ pcm: Data) {
        guard running, let player, let playFormat, let converter = playbackConverter else {
            pendingPlayback.append(pcm)
            if pendingPlayback.count > 120 { pendingPlayback.removeFirst() }
            return
        }
        let inFrames = pcm.count / MemoryLayout<Int16>.size
        guard inFrames > 0,
              let inBuf = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: AVAudioFrameCount(inFrames))
        else { return }
        inBuf.frameLength = AVAudioFrameCount(inFrames)
        pcm.withUnsafeBytes { raw in
            inBuf.int16ChannelData![0].update(from: raw.bindMemory(to: Int16.self).baseAddress!, count: inFrames)
        }

        let ratio = playFormat.sampleRate / wireFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(inFrames) * ratio) + 32
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: capacity) else { return }
        var provided = false
        var convErr: NSError?
        let status = converter.convert(to: outBuf, error: &convErr) { _, outStatus in
            if provided { outStatus.pointee = .noDataNow; return nil }
            provided = true
            outStatus.pointee = .haveData
            return inBuf
        }
        guard status != .error, outBuf.frameLength > 0 else { return }

        if let ch = outBuf.floatChannelData?[0] {
            var peak: Float = 0
            for i in 0..<Int(outBuf.frameLength) { peak = max(peak, abs(ch[i])) }
            onPlaybackLevel?(peak)
        }

        lock.lock()
        pendingBuffers += 1
        let gen = generation
        let becameActive = pendingBuffers == 1
        lock.unlock()
        if becameActive {
            NSLog("[audio] playback active")
            setDraining(true)
        }

        player.scheduleBuffer(outBuf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            let live = gen == self.generation
            if live { self.pendingBuffers -= 1 }
            let drained = live && self.pendingBuffers == 0
            self.lock.unlock()
            if drained { self.setDraining(false) }
        }
        if !player.isPlaying { player.play() }
    }

    /// Barge-in: drop everything queued, immediately.
    func flushPlayback() {
        lock.lock()
        generation += 1
        pendingBuffers = 0
        lock.unlock()
        player?.stop()
        playbackConverter?.reset()
        if running, let player, let engine, engine.isRunning {
            player.play() // ready for the next reply
        }
        setDraining(false)
    }

    private func setDraining(_ value: Bool) {
        onPlaybackStateChange?(value)
    }

    // MARK: engine graph

    private func setupAndStart() {
        guard !running else { return }
        if let last = lastStartFailure, Date().timeIntervalSince(last) < 3 { return } // no retry storms
        let engine = AVAudioEngine()
        let input = engine.inputNode

        // Order is load-bearing (probed on this macOS 27 beta): materialize the playback
        // graph FIRST, then enable VPIO — enabling VPIO before touching mainMixerNode makes
        // engine start fail with -10875 (output unit kAUInitialize).
        let player = AVAudioPlayerNode()
        engine.attach(player)
        // Keep the connection in a native-rate format (mono float at the output hardware rate);
        // a 24 kHz connection here is the exact -10851 trap from the spike.
        let hwRate = engine.outputNode.outputFormat(forBus: 0).sampleRate
        let playFormat = AVAudioFormat(standardFormatWithSampleRate: hwRate, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        self.playFormat = playFormat
        playbackConverter = AVAudioConverter(from: wireFormat, to: playFormat)

        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            NSLog("[audio] voice processing unavailable (\(error)) — echo cancellation degraded")
        }

        // Input format only settles after the VPIO switch — here a 48 kHz **9-channel** array
        // with a discrete layout. AVAudioConverter does NOT downmix discrete multichannel to
        // mono (its default channel map produced pure silence — live-debug finding); the
        // voice-processed signal is on channel 0, so captureTapped extracts ch0 into a mono
        // buffer and the converter only ever does mono 48 kHz float → mono 24 kHz int16.
        let hwInFormat = input.outputFormat(forBus: 0)
        let monoIn = AVAudioFormat(standardFormatWithSampleRate: hwInFormat.sampleRate, channels: 1)!
        captureMonoFormat = monoIn
        captureConverter = AVAudioConverter(from: monoIn, to: wireFormat)
        loggedChannelPeaks = false

        input.installTap(onBus: 0, bufferSize: 1024, format: hwInFormat) { [weak self] buffer, _ in
            self?.captureTapped(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
            self.engine = engine
            self.player = player
            running = true
            lastStartFailure = nil
            NSLog("[audio] engine started — in %.0f Hz/%d ch, out %.0f Hz, VPIO %@",
                  hwInFormat.sampleRate, hwInFormat.channelCount, hwRate,
                  input.isVoiceProcessingEnabled ? "on" : "OFF")
            let queued = pendingPlayback
            pendingPlayback = []
            for chunk in queued { playChunk(chunk) }
        } catch {
            NSLog("[audio] engine start failed: \(error)")
            lastStartFailure = Date()
            input.removeTap(onBus: 0)
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
