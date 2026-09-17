@preconcurrency import AVFoundation
import Foundation
import Speech

@available(iOS 26.0, *)
@MainActor
final class T3EvenG2SpeechTranscriber {
  typealias UpdateHandler = (_ text: String, _ isFinal: Bool) -> Void

  private struct AudioFormats {
    let source: AVAudioFormat
    let analyzer: AVAudioFormat
    let converter: AVAudioConverter?
  }

  private var analyzer: SpeechAnalyzer?
  private var sourceFormat: AVAudioFormat?
  private var analyzerFormat: AVAudioFormat?
  private var audioConverter: AVAudioConverter?
  private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
  private var resultTask: Task<Void, Never>?
  private var finalText = ""
  private var volatileText = ""
  private var onUpdate: UpdateHandler?

  func start(onUpdate: @escaping UpdateHandler) async throws {
    await cancel()
    guard await requestAuthorization() else {
      throw SpeechError.authorizationDenied
    }
    guard SpeechTranscriber.isAvailable else {
      throw SpeechError.unavailable
    }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) else {
      throw SpeechError.unsupportedLocale
    }

    let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
    let formats = try await compatibleAudioFormats(for: transcriber)

    let (sequence, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    self.analyzer = analyzer
    sourceFormat = formats.source
    analyzerFormat = formats.analyzer
    audioConverter = formats.converter
    self.inputContinuation = continuation
    self.onUpdate = onUpdate
    finalText = ""
    volatileText = ""

    resultTask = Task { [weak self] in
      do {
        for try await result in transcriber.results {
          guard let self else { return }
          let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
          guard !text.isEmpty else { continue }
          if result.isFinal {
            self.finalText = Self.join(self.finalText, text)
            self.volatileText = ""
          } else {
            self.volatileText = text
          }
          self.onUpdate?(Self.join(self.finalText, self.volatileText), false)
        }
      } catch {
        // The owning connection reports lifecycle errors. Cancellation while
        // finishing a short utterance is expected and needs no separate event.
      }
    }

    try await analyzer.prepareToAnalyze(in: formats.analyzer)
    try await analyzer.start(inputSequence: sequence)
  }

  func appendPCM(_ pcm: Data) throws {
    guard let sourceFormat, let continuation = inputContinuation else { return }
    guard
      let buffer = AVAudioPCMBuffer(
        pcmFormat: sourceFormat,
        frameCapacity: AVAudioFrameCount(pcm.count / MemoryLayout<Int16>.size)
      ),
      let destination = buffer.int16ChannelData?.pointee
    else {
      throw SpeechError.invalidAudio
    }

    buffer.frameLength = buffer.frameCapacity
    pcm.withUnsafeBytes { rawBuffer in
      if let source = rawBuffer.baseAddress?.assumingMemoryBound(to: Int16.self) {
        destination.update(from: source, count: Int(buffer.frameLength))
      }
    }
    if audioConverter == nil {
      continuation.yield(AnalyzerInput(buffer: buffer))
    } else if let converted = try convert(buffer) {
      continuation.yield(AnalyzerInput(buffer: converted))
    }
  }

  func finish() async throws -> String {
    if let continuation = inputContinuation {
      do {
        try flushConverter(into: continuation)
      } catch {
        continuation.finish()
        inputContinuation = nil
        if let analyzer {
          await analyzer.cancelAndFinishNow()
        }
        resultTask?.cancel()
        reset()
        throw error
      }
      continuation.finish()
    }
    inputContinuation = nil
    if let analyzer {
      try await analyzer.finalizeAndFinishThroughEndOfInput()
    }
    await resultTask?.value
    let text = Self.join(finalText, volatileText).trimmingCharacters(in: .whitespacesAndNewlines)
    onUpdate?(text, true)
    reset()
    return text
  }

  func cancel() async {
    inputContinuation?.finish()
    inputContinuation = nil
    if let analyzer {
      await analyzer.cancelAndFinishNow()
    }
    resultTask?.cancel()
    reset()
  }

  private func reset() {
    analyzer = nil
    sourceFormat = nil
    analyzerFormat = nil
    audioConverter = nil
    inputContinuation = nil
    resultTask = nil
    finalText = ""
    volatileText = ""
    onUpdate = nil
  }

  private func compatibleAudioFormats(
    for transcriber: SpeechTranscriber
  ) async throws -> AudioFormats {
    guard
      let sourceFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
      ),
      let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
        compatibleWith: [transcriber],
        considering: sourceFormat
      )
    else {
      throw SpeechError.unavailable
    }
    if sourceFormat.isEqual(analyzerFormat) {
      return AudioFormats(source: sourceFormat, analyzer: analyzerFormat, converter: nil)
    }
    guard let converter = AVAudioConverter(from: sourceFormat, to: analyzerFormat) else {
      throw SpeechError.unavailable
    }
    return AudioFormats(source: sourceFormat, analyzer: analyzerFormat, converter: converter)
  }

  private func convert(_ input: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer? {
    guard let audioConverter, let analyzerFormat, let sourceFormat else { return nil }
    let ratio = analyzerFormat.sampleRate / sourceFormat.sampleRate
    let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * ratio)) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else {
      throw SpeechError.invalidAudio
    }

    var suppliedInput = false
    var conversionError: NSError?
    let status = audioConverter.convert(to: output, error: &conversionError) { _, inputStatus in
      if suppliedInput {
        inputStatus.pointee = .noDataNow
        return nil
      }
      suppliedInput = true
      inputStatus.pointee = .haveData
      return input
    }
    if let conversionError { throw conversionError }
    if status == .error { throw SpeechError.invalidAudio }
    return output.frameLength > 0 ? output : nil
  }

  private func flushConverter(into continuation: AsyncStream<AnalyzerInput>.Continuation) throws {
    guard let audioConverter, let analyzerFormat else { return }
    while true {
      guard let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: 4_096) else {
        throw SpeechError.invalidAudio
      }
      var conversionError: NSError?
      let status = audioConverter.convert(to: output, error: &conversionError) { _, inputStatus in
        inputStatus.pointee = .endOfStream
        return nil
      }
      if let conversionError { throw conversionError }
      if output.frameLength > 0 {
        continuation.yield(AnalyzerInput(buffer: output))
      }
      if status == .endOfStream || output.frameLength == 0 { return }
      if status == .error { throw SpeechError.invalidAudio }
    }
  }

  private static func join(_ lhs: String, _ rhs: String) -> String {
    if lhs.isEmpty { return rhs }
    if rhs.isEmpty { return lhs }
    return "\(lhs) \(rhs)"
  }

  private func requestAuthorization() async -> Bool {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized:
      return true
    case .notDetermined:
      return await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { status in
          continuation.resume(returning: status == .authorized)
        }
      }
    default:
      return false
    }
  }

  enum SpeechError: LocalizedError {
    case authorizationDenied
    case invalidAudio
    case unavailable
    case unsupportedLocale

    var errorDescription: String? {
      switch self {
      case .authorizationDenied: "Speech recognition permission is required."
      case .invalidAudio: "The G2 microphone returned invalid audio."
      case .unavailable: "On-device speech recognition is unavailable."
      case .unsupportedLocale: "The current language is not supported for transcription."
      }
    }
  }
}
