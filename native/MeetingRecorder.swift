import Foundation
import AVFoundation

// Text mode for the plugin: convert Chinese script with the system transform (Hant-Hans or Hans-Hant), stdin to stdout.
if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--convert" {
    let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let transform = CommandLine.arguments[2] == "Hans-Hant" ? "Hans-Hant" : "Hant-Hans"
    FileHandle.standardOutput.write((input.applyingTransform(StringTransform(rawValue: transform), reverse: false) ?? input).data(using: .utf8)!)
    exit(0)
}
let output = CommandLine.arguments[1]
let chunkSeconds = Double(CommandLine.arguments[2]) ?? 15
let streamPCM = CommandLine.arguments.dropFirst(3).contains("--stream-pcm")
let queue = DispatchQueue(label: "xj.meeting.audio")
let printLock = NSLock()
func emit(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message), let text = String(data: data, encoding: .utf8) else { return }
    printLock.lock(); print(text); fflush(stdout); printLock.unlock()
}
final class Writer {
    var samples: [Float] = []
    var streamSamples: [Float] = []
    private static let hex = Array("0123456789abcdef".utf8)
    func emitPCM(_ count: Int) {
        guard count > 0 else { return }
        var encoded: [UInt8] = []
        encoded.reserveCapacity(count * 4)
        for value in streamSamples.prefix(count) {
            let sample = UInt16(bitPattern: Int16(max(-32767, min(32767, Int(value * 32767)))))
            for shift in [4, 0, 12, 8] { encoded.append(Self.hex[Int((sample >> shift) & 15)]) }
        }
        emit(["event": "pcm", "hex": String(decoding: encoded, as: UTF8.self)])
        streamSamples.removeFirst(count)
    }
    var sampleOffset = 0
    var sequence = 0
    var paused = false
    var finished = false
    var lastLevel = Date.distantPast
    let chunkFrames = Int(chunkSeconds * 16000)
    func consume(_ buffer: AVAudioPCMBuffer) {
        if paused || finished { return }
        guard let values = buffer.floatChannelData?[0] else { return }
        let frames = UnsafeBufferPointer(start: values, count: Int(buffer.frameLength))
        samples.append(contentsOf: frames)
        if streamPCM {
            streamSamples.append(contentsOf: frames)
            while streamSamples.count >= 3200 { emitPCM(3200) }
        }
        if Date().timeIntervalSince(lastLevel) > 0.2 {
            let peak = (0..<Int(buffer.frameLength)).reduce(Float(0)) { max($0, abs(values[$1])) }
            emit(["event": "level", "db": max(-120, 20 * log10(max(peak, 0.000001)))])
            lastLevel = Date()
        }
        while samples.count >= chunkFrames { flush(count: chunkFrames) }
    }
    func flush(count: Int? = nil) {
        let amount = count ?? samples.count
        if amount == 0 { return }
        let batch = Array(samples.prefix(amount))
        samples.removeFirst(amount)
        var bytes = Data()
        func ascii(_ text: String) { bytes.append(text.data(using: .ascii)!) }
        func le<T: FixedWidthInteger>(_ value: T) { var n = value.littleEndian; withUnsafeBytes(of: &n) { bytes.append(contentsOf: $0) } }
        ascii("RIFF"); le(UInt32(36 + amount * 2)); ascii("WAVEfmt "); le(UInt32(16))
        le(UInt16(1)); le(UInt16(1)); le(UInt32(16000)); le(UInt32(32000)); le(UInt16(2)); le(UInt16(16)); ascii("data"); le(UInt32(amount * 2))
        for value in batch { le(Int16(max(-32767, min(32767, Int(value * 32767))))) }
        let name = String(format: "%06d.wav", sequence)
        let file = URL(fileURLWithPath: output).appendingPathComponent(name)
        do {
            try bytes.write(to: file, options: .atomic)
            let energy = sqrt(batch.reduce(0.0) { $0 + Double($1 * $1) } / Double(amount))
            let voiced = batch.filter { abs($0) > 0.01 }.count
            emit(["event": "chunk", "name": name, "seq": sequence, "startMs": sampleOffset / 16,
                  "endMs": (sampleOffset + amount) / 16, "rms": energy, "voicedMs": Double(voiced) / 16])
            sampleOffset += amount; sequence += 1
        } catch { emit(["event": "error", "message": "audio_write_failed"]); finished = true }
    }
}
let writer = Writer()
// QA only supplies synthetic audio; normal execution never creates synthetic samples.
#if RECORDER_QA
let buffer = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!, frameCapacity: 32000)!
buffer.frameLength = 32000
for i in 0..<32000 { buffer.floatChannelData![0][i] = 0.2 * sin(Float(i) * 2 * .pi * 440 / 16000) }
writer.consume(buffer)
writer.emitPCM(writer.streamSamples.count)
writer.flush()
emit(["event": "stopped"])
#else
let authorization = AVCaptureDevice.authorizationStatus(for: .audio)
if authorization == .notDetermined {
    let gate = DispatchSemaphore(value: 0)
    var allowed = false
    AVCaptureDevice.requestAccess(for: .audio) { granted in allowed = granted; gate.signal() }
    if gate.wait(timeout: .now() + 55) != .success || !allowed { emit(["event": "error", "message": "microphone_permission_denied"]); exit(1) }
} else if authorization != .authorized { emit(["event": "error", "message": "microphone_permission_denied"]); exit(1) }
let engine = AVAudioEngine()
guard let target = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1) else { emit(["event": "error", "message": "microphone_unavailable"]); exit(1) }
/// Taps the current input device. Called again whenever the system changes the device (a headset connected, another
/// app took the microphone): the engine stops itself then, and without a new tap the recording would go silent.
func connectInput() -> Bool {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0, let converter = AVAudioConverter(from: format, to: target) else { return false }
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
        // Copy before leaving the tap: the engine reuses its input buffers.
        guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength) else { return }
        copy.frameLength = buffer.frameLength
        let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for i in 0..<source.count { if let src = source[i].mData, let dst = destination[i].mData { memcpy(dst, src, Int(source[i].mDataByteSize)) } }
        queue.async {
            if writer.paused || writer.finished { return }
            let capacity = AVAudioFrameCount(ceil(Double(copy.frameLength) * 16000 / format.sampleRate) + 32)
            guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            let status = converter.convert(to: converted, error: &error) { _, flag in
                if supplied { flag.pointee = .noDataNow; return nil }
                supplied = true; flag.pointee = .haveData; return copy
            }
            if status == .error { emit(["event": "error", "message": "audio_conversion_failed"]); return }
            writer.consume(converted)
        }
    }
    do { try engine.start(); return true } catch { input.removeTap(onBus: 0); return false }
}
guard connectInput() else { emit(["event": "error", "message": "microphone_permission_or_device"]); exit(1) }
emit(["event": "ready"])
var stopping = false
var reconnectAttempts = 0
func reconnect() {
    if stopping { return }
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    if connectInput() { reconnectAttempts = 0; emit(["event": "device_changed"]); return }
    // The new device can take a moment to become usable; give up after about 10 s so the meeting is not silently empty.
    reconnectAttempts += 1
    if reconnectAttempts > 20 { emit(["event": "error", "message": "microphone_lost"]); return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: reconnect)
}
NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in reconnect() }
DispatchQueue.global().async {
    while let command = readLine() {
        if command == "pause" { queue.sync { writer.flush(); writer.paused = true }; emit(["event": "paused"]) }
        else if command == "resume" { queue.sync { writer.paused = false }; emit(["event": "resumed"]) }
        else if command == "stop" { break }
    }
    DispatchQueue.main.sync { stopping = true; engine.stop(); engine.inputNode.removeTap(onBus: 0) }
    queue.sync { writer.emitPCM(writer.streamSamples.count); writer.flush(); writer.finished = true }
    emit(["event": "stopped"])
    exit(0)
}
RunLoop.main.run()
#endif

