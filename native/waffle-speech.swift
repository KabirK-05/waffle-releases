// waffle-speech: transcribe one audio file on this Mac with Apple's speech engine.
//
//   waffle-speech <file.wav>      prints the transcript to stdout
//   waffle-speech --check         prints "ok" when the engine can run here
//   waffle-speech --mic           records the microphone and writes raw 16 kHz mono 16-bit PCM to
//                                stdout until stdin closes (works on macOS 14+; it replaces sox,
//                                so a downloaded Waffle needs nothing from Homebrew)
//   waffle-speech --stream        live: reads raw 16 kHz mono 16-bit PCM on stdin and writes one
//                                JSON object per line to stdout:
//                                  {"t":"ready"}
//                                  {"t":"partial"|"final","text":"…","start":1.2,"end":3.4}
//                                Partials are the current guess for audio still being heard and
//                                are replaced by the next partial or final. Times are seconds of
//                                audio received. Close stdin to finish; the last finals are
//                                written before the process exits.
//
// Uses SpeechAnalyzer + SpeechTranscriber (macOS 26+), which run fully on device. The language
// model for the user's locale is downloaded by macOS the first time it is needed.
//
// Exit codes: 0 success, 2 bad arguments, 3 engine unavailable (older macOS or unsupported
// language), 4 microphone access denied or no microphone, 1 any other failure. Error text goes
// to stderr.

import AVFoundation
import Foundation
import Speech

func fail(_ message: String, code: Int32) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

@available(macOS 26.0, *)
func makeTranscriber(live: Bool = false) async throws -> SpeechTranscriber {
  guard SpeechTranscriber.isAvailable else { fail("Apple's speech engine is not available on this Mac.", code: 3) }
  let wanted = Locale.current
  guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
    fail("Apple's speech engine does not support \(wanted.identifier).", code: 3)
  }
  let transcriber =
    live
    ? SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
    : SpeechTranscriber(locale: locale, preset: .transcription)
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall() // first run only: fetch the on-device model
  }
  return transcriber
}

@available(macOS 26.0, *)
func transcribe(_ path: String) async throws -> String {
  let transcriber = try await makeTranscriber()
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
  let analyzer = SpeechAnalyzer(modules: [transcriber])

  let collector = Task { () throws -> String in
    var text = ""
    for try await result in transcriber.results where result.isFinal {
      text += String(result.text.characters)
    }
    return text
  }

  if let last = try await analyzer.analyzeSequence(from: file) {
    try await analyzer.finalizeAndFinish(through: last)
  } else {
    await analyzer.cancelAndFinishNow()
  }
  return try await collector.value.trimmingCharacters(in: .whitespacesAndNewlines)
}

let output = FileHandle.standardOutput

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  output.write(data + Data("\n".utf8))
}

/** Live mode: stdin PCM in, JSON lines out. */
@available(macOS 26.0, *)
func stream() async throws {
  let transcriber = try await makeTranscriber(live: true)
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
  let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) ?? source
  let converter = target == source ? nil : AVAudioConverter(from: source, to: target)

  let (inputs, feed) = AsyncStream.makeStream(of: AnalyzerInput.self)
  try await analyzer.start(inputSequence: inputs)

  let results = Task {
    for try await result in transcriber.results {
      let text = String(result.text.characters)
      emit([
        "t": result.isFinal ? "final" : "partial",
        "text": text,
        "start": result.range.start.seconds.isFinite ? result.range.start.seconds : 0,
        "end": result.range.end.seconds.isFinite ? result.range.end.seconds : 0,
      ])
    }
  }
  emit(["t": "ready"])

  // Read stdin on its own thread so blocking reads never hold up the analyzer.
  let reader = Thread {
    var pending = Data()
    while true {
      let chunk = FileHandle.standardInput.availableData
      if chunk.isEmpty { break }
      pending.append(chunk)
      let usable = pending.count - pending.count % 2
      if usable == 0 { continue }
      let frames = AVAudioFrameCount(usable / 2)
      guard let buffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: frames) else { continue }
      buffer.frameLength = frames
      pending.prefix(usable).withUnsafeBytes { raw in
        buffer.int16ChannelData![0].update(from: raw.bindMemory(to: Int16.self).baseAddress!, count: Int(frames))
      }
      pending.removeFirst(usable)
      if let converter {
        let capacity = AVAudioFrameCount(Double(frames) * target.sampleRate / source.sampleRate) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { continue }
        var given = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
          if given {
            status.pointee = .noDataNow
            return nil
          }
          given = true
          status.pointee = .haveData
          return buffer
        }
        if error == nil, converted.frameLength > 0 { feed.yield(AnalyzerInput(buffer: converted)) }
      } else {
        feed.yield(AnalyzerInput(buffer: buffer))
      }
    }
    feed.finish()
  }
  reader.start()

  try await analyzer.finalizeAndFinishThroughEndOfInput()
  try await results.value
}

// ---------- microphone capture (macOS 14+) ----------

/** Record the default input device as 16 kHz mono Int16 PCM on stdout until stdin closes. */
func recordMicrophone() -> Never {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .denied, .restricted:
    fail("Microphone access is off for Waffle. Turn it on in System Settings → Privacy & Security → Microphone.", code: 4)
  case .notDetermined:
    let wait = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { ok in
      granted = ok
      wait.signal()
    }
    wait.wait()
    if !granted { fail("Microphone access was not granted.", code: 4) }
  default:
    break
  }

  let engine = AVAudioEngine()
  let input = engine.inputNode
  let inFormat = input.outputFormat(forBus: 0)
  if inFormat.sampleRate == 0 || inFormat.channelCount == 0 { fail("No microphone was found.", code: 4) }
  let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
  guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
    fail("Could not convert the microphone's audio format.", code: 1)
  }

  input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buffer, _ in
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000 / inFormat.sampleRate) + 64
    guard let converted = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
    var given = false
    var error: NSError?
    converter.convert(to: converted, error: &error) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, converted.frameLength > 0, let samples = converted.int16ChannelData else { return }
    output.write(Data(bytes: samples[0], count: Int(converted.frameLength) * 2))
  }

  do {
    try engine.start()
  } catch {
    fail("Could not start the microphone: \(error.localizedDescription)", code: 1)
  }

  // The parent closes stdin to stop; reading it here also notices if the parent goes away.
  Thread {
    while !FileHandle.standardInput.availableData.isEmpty {}
    engine.stop()
    exit(0)
  }.start()
  dispatchMain()
}

@available(macOS 26.0, *)
func run(_ arg: String) async {
  do {
    if arg == "--stream" {
      try await stream()
    } else if arg == "--check" {
      _ = try await makeTranscriber()
      print("ok")
    } else {
      print(try await transcribe(arg))
    }
    exit(0)
  } catch {
    fail(error.localizedDescription, code: 1)
  }
}

let args = CommandLine.arguments.dropFirst()
guard args.count == 1, let arg = args.first else { fail("usage: waffle-speech <file.wav> | --check | --stream | --mic", code: 2) }
if arg == "--mic" { recordMicrophone() }
if #available(macOS 26.0, *) {
  Task { await run(arg) }
} else {
  fail("Apple's speech engine needs macOS 26 or later.", code: 3)
}
dispatchMain() // run() always exits the process
