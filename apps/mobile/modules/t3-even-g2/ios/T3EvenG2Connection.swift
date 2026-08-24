import CoreBluetooth
import Foundation

@available(iOS 26.0, *)
final class T3EvenG2Connection: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  enum Status: String {
    case disconnected
    case scanning
    case connecting
    case starting
    case ready
    case error
  }

  var onStatus: (([String: Any]) -> Void)?
  var onTranscript: (([String: Any]) -> Void)?
  var onGesture: (([String: Any]) -> Void)?

  private final class Arm {
    let side: String
    var peripheral: CBPeripheral?
    var write: CBCharacteristic?
    var notify: CBCharacteristic?
    var renderNotify: CBCharacteristic?
    var servicesExpected = 0
    var servicesDiscovered = 0
    var ready = false

    init(side: String) {
      self.side = side
    }

    func resetCharacteristics() {
      write = nil
      notify = nil
      renderNotify = nil
      servicesExpected = 0
      servicesDiscovered = 0
      ready = false
    }
  }

  private let left = Arm(side: "L")
  private let right = Arm(side: "R")
  private var central: CBCentralManager?
  private var status: Status = .disconnected
  private var detail = ""
  private var transportSequence: UInt8 = 0x40
  private var magic = 100
  private var heartbeatTask: Task<Void, Never>?
  private var displayTask: Task<Void, Never>?
  private var bootstrapTask: Task<Void, Never>?
  private var scanTimeoutTask: Task<Void, Never>?
  private var speechSession: AnyObject?
  private var decoder: T3EvenG2LC3Decoder?
  private var requestedDisconnect = false
  private var transportBusy = false
  private var inputEnabled = false
  private var listening = false
  private var stoppingDictation = false
  private var latestTranscript = ""
  private var pendingDisplayText: String?
  private var displayPages: [String] = []
  private var displayPageIndex = 0
  private var lastGestureAt = Date.distantPast
  private var pendingAckKeys: Set<String> = []
  private var receivedAckKeys: Set<String> = []

  var snapshot: [String: Any] {
    [
      "status": status.rawValue,
      "detail": detail,
      "connected": status == .ready,
      "listening": listening,
      "autoConnect": UserDefaults.standard.bool(forKey: Self.autoConnectKey),
    ]
  }

  static let autoConnectKey = "T3EvenG2AutoConnect"

  func connect() {
    guard status == .disconnected || status == .error else { return }
    if status == .error {
      requestedDisconnect = true
      stopTasks()
      cancelSpeechAfterDisconnect()
      for arm in [left, right] {
        if let peripheral = arm.peripheral {
          central?.cancelPeripheralConnection(peripheral)
        }
        arm.peripheral = nil
        arm.resetCharacteristics()
      }
    }
    requestedDisconnect = false
    setStatus(.scanning, detail: "Looking for both G2 arms")
    if central == nil {
      central = CBCentralManager(delegate: self, queue: .main)
    } else if let central {
      if central.state == .poweredOn {
        beginScan()
      } else {
        centralManagerDidUpdateState(central)
      }
    }
  }

  func disconnect() {
    requestedDisconnect = true
    central?.stopScan()
    stopTasks()
    Task { @MainActor in await stopDictation(cancelled: true) }
    for arm in [left, right] {
      if let peripheral = arm.peripheral {
        central?.cancelPeripheralConnection(peripheral)
      }
      arm.peripheral = nil
      arm.resetCharacteristics()
    }
    setStatus(.disconnected)
  }

  func displayText(_ text: String) {
    let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleaned.isEmpty else { return }
    pendingDisplayText = cleaned
    displayPages = T3EvenG2Protocol.lensTextPages(cleaned)
    displayPageIndex = 0
    guard !listening, status == .ready else { return }
    scheduleDisplay(restingDisplayText)
  }

  func clearDisplay() {
    pendingDisplayText = nil
    displayPages = []
    displayPageIndex = 0
    displayTask?.cancel()
    displayTask = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.sendEvenHub(T3EvenG2Protocol.shutdown(magic: self.nextMagic()))
    }
  }

  func setInputEnabled(_ enabled: Bool) {
    inputEnabled = enabled
    if !enabled, listening {
      Task { @MainActor [weak self] in
        guard let self else { return }
        await self.cancelDictation()
        self.scheduleDisplay(self.restingDisplayText)
      }
      return
    }
    guard !listening, status == .ready else { return }
    scheduleDisplay(restingDisplayText)
  }

  @MainActor
  func beginDictation() async {
    guard status == .ready, !listening else { return }
    displayTask?.cancel()
    latestTranscript = ""
    setStatus(.ready, detail: "Preparing on-device speech")
    await sendEvenHub(
      T3EvenG2Protocol.rebuildText("Preparing dictation…", magic: nextMagic())
    )

    let speech = T3EvenG2SpeechTranscriber()
    do {
      try await speech.start { [weak self] text, isFinal in
        guard let self else { return }
        self.latestTranscript = text
        self.onTranscript?(["text": text, "isFinal": isFinal])
        if !isFinal {
          self.scheduleListeningDisplay(text)
        }
      }
      speechSession = speech
      decoder = T3EvenG2LC3Decoder()
      let displayMagic = nextMagic()
      await sendEvenHub(
        T3EvenG2Protocol.rebuildText("Listening…\n\nTap R1 again to send", magic: displayMagic)
      )
      let audioMagic = nextMagic()
      guard await sendEvenHub(
        T3EvenG2Protocol.audioControl(enabled: true, magic: audioMagic),
        expectedAckMagic: audioMagic,
        timeout: .seconds(3)
      ) else {
        await speech.cancel()
        speechSession = nil
        decoder = nil
        setStatus(.ready, detail: "G2 microphone did not start")
        await sendEvenHub(
          T3EvenG2Protocol.rebuildText(
            "G2 microphone did not start\n\nTap R1 to retry",
            magic: nextMagic()
          )
        )
        return
      }
      listening = true
      emitStatus()
      setStatus(.ready, detail: "Listening through G2 microphone")
    } catch {
      speechSession = nil
      decoder = nil
      listening = false
      if !requestedDisconnect, left.ready, right.ready {
        setStatus(.ready, detail: error.localizedDescription)
        await sendEvenHub(
          T3EvenG2Protocol.rebuildText(
            "Dictation unavailable\n\n\(error.localizedDescription)",
            magic: nextMagic()
          )
        )
      }
    }
  }

  @MainActor
  func finishDictation() async {
    await stopDictation(cancelled: false)
  }

  @MainActor
  func cancelDictation() async {
    await stopDictation(cancelled: true)
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    switch central.state {
    case .poweredOn:
      if status == .scanning { beginScan() }
    case .poweredOff:
      setStatus(.error, detail: "Bluetooth is off")
    case .unauthorized:
      setStatus(.error, detail: "Bluetooth permission denied")
    case .unsupported:
      setStatus(.error, detail: "Bluetooth is unavailable")
    default:
      break
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
    let name = peripheral.name ?? advertisedName ?? ""
    let upper = name.uppercased()
    guard upper.contains("G2_"), let arm = armForName(upper), arm.peripheral == nil else { return }

    arm.peripheral = peripheral
    peripheral.delegate = self
    central.connect(peripheral, options: nil)
    setStatus(.connecting, detail: "Found G2 \(arm.side) arm")
    if left.peripheral != nil, right.peripheral != nil {
      central.stopScan()
      scanTimeoutTask?.cancel()
    }
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    peripheral.discoverServices(nil)
  }

  func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    setStatus(.error, detail: error?.localizedDescription ?? "Could not connect to G2")
  }

  func centralManager(
    _ central: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    guard let arm = arm(for: peripheral) else { return }
    arm.resetCharacteristics()
    stopTasks()
    cancelSpeechAfterDisconnect()
    if requestedDisconnect {
      setStatus(.disconnected)
      return
    }
    setStatus(.connecting, detail: "Reconnecting G2 \(arm.side) arm")
    central.connect(peripheral, options: nil)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard let arm = arm(for: peripheral) else { return }
    if let error {
      setStatus(.error, detail: error.localizedDescription)
      return
    }
    let services = peripheral.services ?? []
    arm.servicesExpected = services.count
    arm.servicesDiscovered = 0
    for service in services {
      peripheral.discoverCharacteristics(nil, for: service)
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    guard let arm = arm(for: peripheral) else { return }
    if let error {
      setStatus(.error, detail: error.localizedDescription)
      return
    }

    for characteristic in service.characteristics ?? [] {
      let uuid = characteristic.uuid.uuidString.uppercased()
      if uuid == T3EvenG2Protocol.writeUUID.uppercased() {
        arm.write = characteristic
      } else if uuid == T3EvenG2Protocol.notifyUUID.uppercased() {
        arm.notify = characteristic
        peripheral.setNotifyValue(true, for: characteristic)
      } else if uuid == T3EvenG2Protocol.renderNotifyUUID.uppercased() {
        arm.renderNotify = characteristic
        peripheral.setNotifyValue(true, for: characteristic)
      }
    }

    arm.servicesDiscovered += 1
    guard arm.servicesDiscovered >= arm.servicesExpected else { return }
    arm.ready = arm.write != nil && arm.notify != nil
    if !arm.ready {
      setStatus(.error, detail: "G2 \(arm.side) protocol characteristics missing")
    } else if left.ready, right.ready {
      bootstrap()
    } else {
      setStatus(.connecting, detail: "Waiting for other G2 arm")
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard error == nil, let data = characteristic.value, let arm = arm(for: peripheral) else { return }
    if characteristic.uuid.uuidString.uppercased() == T3EvenG2Protocol.renderNotifyUUID.uppercased() {
      if arm.side == "L" { consumeAudioPacket(data) }
      return
    }
    if let acknowledgement = T3EvenG2Protocol.acknowledgement(from: data) {
      let key = ackKey(service: acknowledgement.service, magic: acknowledgement.magic)
      if pendingAckKeys.contains(key) {
        receivedAckKeys.insert(key)
      }
    }
    guard let gesture = T3EvenG2Protocol.gesture(from: data) else { return }
    onGesture?(["kind": gesture.kind, "source": gesture.source])
    handleGesture(gesture)
  }

  private func beginScan() {
    left.peripheral = nil
    right.peripheral = nil
    left.resetCharacteristics()
    right.resetCharacteristics()
    central?.scanForPeripherals(
      withServices: nil,
      options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
    )
    scanTimeoutTask?.cancel()
    scanTimeoutTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(20))
      guard let self, !Task.isCancelled, !(self.left.ready && self.right.ready) else { return }
      self.central?.stopScan()
      self.setStatus(.error, detail: "G2 scan timed out. Quit the Even app and retry.")
    }
  }

  private func bootstrap() {
    guard bootstrapTask == nil else { return }
    setStatus(.starting, detail: "Starting direct G2 session")
    bootstrapTask = Task { @MainActor [weak self] in
      guard let self else { return }
      try? await Task.sleep(for: .milliseconds(800))
      guard let peripheral = self.right.peripheral, let write = self.right.write else { return }
      let preludeKey = self.ackKey(service: 0x01, magic: 156)
      self.pendingAckKeys.insert(preludeKey)
      peripheral.writeValue(T3EvenG2Protocol.sessionPrelude, for: write, type: .withoutResponse)
      guard await self.waitForAck(key: preludeKey, timeout: .seconds(5)) else {
        self.bootstrapTask = nil
        self.setStatus(.error, detail: "G2 session handshake timed out")
        return
      }
      let createMagic = self.nextMagic()
      guard await self.sendEvenHub(
        T3EvenG2Protocol.createPage(magic: createMagic),
        expectedAckMagic: createMagic
      ) else {
        self.bootstrapTask = nil
        self.setStatus(.error, detail: "G2 page creation timed out")
        return
      }
      let displayMagic = self.nextMagic()
      guard await self.sendEvenHub(
        T3EvenG2Protocol.rebuildText(self.restingDisplayText, magic: displayMagic),
        expectedAckMagic: displayMagic
      ) else {
        self.bootstrapTask = nil
        self.setStatus(.error, detail: "G2 display startup timed out")
        return
      }
      self.setStatus(.ready, detail: "G2 and R1 ready")
      self.startHeartbeat()
      self.bootstrapTask = nil
    }
  }

  private func startHeartbeat() {
    heartbeatTask?.cancel()
    heartbeatTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(5))
        guard let self, self.status == .ready, !self.transportBusy else { continue }
        await self.sendEvenHub(T3EvenG2Protocol.heartbeat(magic: self.nextMagic()))
      }
    }
  }

  private func scheduleDisplay(_ text: String) {
    displayTask?.cancel()
    displayTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(300))
      guard let self, !Task.isCancelled, !self.listening else { return }
      await self.sendEvenHub(T3EvenG2Protocol.rebuildText(text, magic: self.nextMagic()))
    }
  }

  private var restingDisplayText: String {
    if !inputEnabled {
      return "T3 Code\n\nOpen a thread to dictate"
    }
    if displayPages.indices.contains(displayPageIndex) {
      return displayPages[displayPageIndex]
    }
    return "T3 Code\n\nTap R1 to dictate"
  }

  private func scheduleListeningDisplay(_ transcript: String) {
    let text = transcript.isEmpty ? "Listening…" : "Listening…\n\n\(transcript)"
    displayTask?.cancel()
    displayTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(450))
      guard let self, !Task.isCancelled, self.listening else { return }
      await self.sendEvenHub(T3EvenG2Protocol.rebuildText(text, magic: self.nextMagic()))
    }
  }

  @MainActor
  @discardableResult
  private func sendEvenHub(
    _ payload: [UInt8],
    expectedAckMagic: Int? = nil,
    timeout: Duration = .seconds(5)
  ) async -> Bool {
    guard let peripheral = right.peripheral, let write = right.write else { return false }
    let expectedAckKey = expectedAckMagic.map { ackKey(service: 0xE0, magic: $0) }
    if let expectedAckKey {
      pendingAckKeys.insert(expectedAckKey)
    }
    while transportBusy {
      do {
        try await Task.sleep(for: .milliseconds(10))
      } catch {
        clearAck(expectedAckKey)
        return false
      }
    }
    transportBusy = true
    defer { transportBusy = false }
    let sequence = transportSequence
    transportSequence &+= 1
    let maximumWriteLength = peripheral.maximumWriteValueLength(for: .withoutResponse)
    let chunkSize = max(1, min(232, maximumWriteLength - 8))
    for frame in T3EvenG2Protocol.frames(
      payload: payload,
      sequence: sequence,
      chunkSize: chunkSize
    ) {
      while !peripheral.canSendWriteWithoutResponse {
        do {
          try await Task.sleep(for: .milliseconds(5))
        } catch {
          clearAck(expectedAckKey)
          return false
        }
      }
      peripheral.writeValue(frame, for: write, type: .withoutResponse)
      do {
        try await Task.sleep(for: .milliseconds(14))
      } catch {
        clearAck(expectedAckKey)
        return false
      }
    }
    guard let expectedAckKey else { return true }
    return await waitForAck(key: expectedAckKey, timeout: timeout)
  }

  private func waitForAck(key: String, timeout: Duration) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
      if receivedAckKeys.remove(key) != nil {
        pendingAckKeys.remove(key)
        return true
      }
      do {
        try await Task.sleep(for: .milliseconds(10))
      } catch {
        break
      }
    }
    clearAck(key)
    return false
  }

  private func clearAck(_ key: String?) {
    guard let key else { return }
    pendingAckKeys.remove(key)
    receivedAckKeys.remove(key)
  }

  private func ackKey(service: UInt8, magic: Int) -> String {
    "\(service):\(magic)"
  }

  private func consumeAudioPacket(_ packet: Data) {
    guard listening, packet.count == 205, let decoder else { return }
    do {
      let pcm = try decoder.decodePacket(packet)
      if let speech = speechSession as? T3EvenG2SpeechTranscriber {
        Task { @MainActor [weak self] in
          guard let self, self.speechSession === speech else { return }
          do {
            try speech.appendPCM(pcm)
          } catch {
            self.setStatus(.ready, detail: error.localizedDescription)
          }
        }
      }
    } catch {
      setStatus(.ready, detail: error.localizedDescription)
    }
  }

  private func handleGesture(_ gesture: T3EvenG2Protocol.Gesture) {
    guard inputEnabled else { return }
    let now = Date()
    guard now.timeIntervalSince(lastGestureAt) > 0.4 else { return }
    lastGestureAt = now
    if T3EvenG2Protocol.lensPageOffset(for: gesture.kind) != nil {
      Task { @MainActor [weak self] in
        self?.scrollDisplay(gesture.kind)
      }
      return
    }
    guard gesture.kind == "click" || gesture.kind == "doubleClick" else { return }
    Task { @MainActor [weak self] in
      guard let self else { return }
      let sourceLabel = switch gesture.source {
      case "ring": "R1"
      case "rightTemple": "right temple"
      case "leftTemple": "left temple"
      default: gesture.source
      }
      let inputAccepted = T3EvenG2Protocol.isDictationSource(gesture.source)
      let feedback = inputAccepted ? "Tap received" : "Input detected"
      await self.sendEvenHub(
        T3EvenG2Protocol.rebuildText(
          "\(feedback)\n\n\(sourceLabel) · \(gesture.kind)",
          magic: self.nextMagic()
        )
      )
      self.setStatus(.ready, detail: "Input: \(sourceLabel) \(gesture.kind)")
      guard inputAccepted else { return }
      try? await Task.sleep(for: .milliseconds(450))
      if gesture.kind == "click" {
        if self.listening { await self.finishDictation() } else { await self.beginDictation() }
      } else if gesture.kind == "doubleClick", self.listening {
        await self.cancelDictation()
      }
    }
  }

  @MainActor
  private func scrollDisplay(_ gestureKind: String) {
    guard
      !listening,
      displayPages.count > 1,
      let offset = T3EvenG2Protocol.lensPageOffset(for: gestureKind)
    else { return }
    let nextIndex = min(max(displayPageIndex + offset, 0), displayPages.count - 1)
    guard nextIndex != displayPageIndex else { return }
    displayPageIndex = nextIndex
    scheduleDisplay(restingDisplayText)
    setStatus(.ready, detail: "G2 page \(displayPageIndex + 1) of \(displayPages.count)")
  }

  @MainActor
  private func stopDictation(cancelled: Bool) async {
    guard listening || speechSession != nil, !stoppingDictation else { return }
    stoppingDictation = true
    defer { stoppingDictation = false }
    var finalCancelled = cancelled
    displayTask?.cancel()
    let audioMagic = nextMagic()
    await sendEvenHub(
      T3EvenG2Protocol.audioControl(enabled: false, magic: audioMagic),
      expectedAckMagic: audioMagic,
      timeout: .seconds(2)
    )
    listening = false
    emitStatus()

    if let speech = speechSession as? T3EvenG2SpeechTranscriber {
      if cancelled {
        await speech.cancel()
      } else {
        do {
          let text = try await speech.finish()
          latestTranscript = text
        } catch {
          finalCancelled = true
          latestTranscript = ""
          setStatus(.ready, detail: error.localizedDescription)
        }
      }
    }
    speechSession = nil
    decoder = nil

    if finalCancelled {
      onTranscript?(["text": "", "isFinal": true, "cancelled": true])
      displayText(pendingDisplayText ?? "Dictation cancelled")
    } else if latestTranscript.isEmpty {
      displayText("No speech recognized\n\nTap R1 to try again")
    } else {
      displayText("Sending to T3 Code…")
    }
    if status != .error, !requestedDisconnect, left.ready, right.ready {
      setStatus(.ready, detail: "G2 and R1 ready")
    }
  }

  private func armForName(_ name: String) -> Arm? {
    if name.contains("_L_") { return left }
    if name.contains("_R_") { return right }
    return nil
  }

  private func arm(for peripheral: CBPeripheral) -> Arm? {
    if left.peripheral?.identifier == peripheral.identifier { return left }
    if right.peripheral?.identifier == peripheral.identifier { return right }
    return nil
  }

  private func nextMagic() -> Int {
    magic = magic >= 255 ? 100 : magic + 1
    return magic
  }

  private func setStatus(_ next: Status, detail: String = "") {
    status = next
    self.detail = detail
    emitStatus()
  }

  private func emitStatus() {
    onStatus?(snapshot)
  }

  private func stopTasks() {
    heartbeatTask?.cancel()
    heartbeatTask = nil
    displayTask?.cancel()
    displayTask = nil
    bootstrapTask?.cancel()
    bootstrapTask = nil
    scanTimeoutTask?.cancel()
    scanTimeoutTask = nil
    pendingAckKeys.removeAll()
    receivedAckKeys.removeAll()
  }

  private func cancelSpeechAfterDisconnect() {
    guard listening || speechSession != nil else { return }
    listening = false
    let speech = speechSession as? T3EvenG2SpeechTranscriber
    speechSession = nil
    decoder = nil
    onTranscript?(["text": "", "isFinal": true, "cancelled": true])
    Task { @MainActor in await speech?.cancel() }
  }
}
