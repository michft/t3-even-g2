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
    case paused
    case error
  }

  var onStatus: (([String: Any]) -> Void)?
  var onTranscript: (([String: Any]) -> Void)?
  var onGesture: (([String: Any]) -> Void)?
  var onThreadSelected: (([String: Any]) -> Void)?

  private final class Arm {
    let side: String
    var peripheral: CBPeripheral?
    var write: CBCharacteristic?
    var notify: CBCharacteristic?
    var renderNotify: CBCharacteristic?
    var servicesExpected = 0
    var servicesDiscovered = 0
    var ready = false
    var didSendAuthentication = false

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
      didSendAuthentication = false
    }
  }

  private let left = Arm(side: "L")
  private let right = Arm(side: "R")
  private var central: CBCentralManager?
  private var status: Status = .disconnected
  private var detail = ""
  private var transportSequence: UInt8 = 0x40
  private var magic = 100
  private var pageName = "t3code"
  private var heartbeatTask: Task<Void, Never>?
  private var baseHeartbeatTask: Task<Void, Never>?
  private let baseHeartbeatInterval: Duration
  private var displayTask: Task<Void, Never>?
  private var bootstrapTask: Task<Void, Never>?
  private var shutdownExitObserved = false
  private var scanTimeoutTask: Task<Void, Never>?
  private let connectionTimeout: Duration
  private var connectionTimedOut = false
  private var gestureTask: Task<Void, Never>?
  private var pauseTask: Task<Void, Never>?
  private var recoveryTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var speechSession: AnyObject?
  private var decoder: T3EvenG2LC3Decoder?
  private var requestedDisconnect = false
  private var transportBusy = false
  private var inputEnabled = false
  private var activeThreadKey: String?
  private var threadPicker = T3EvenG2ThreadPicker()
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
      "connected": status == .ready || status == .paused,
      "listening": listening,
      "autoConnect": UserDefaults.standard.bool(forKey: Self.autoConnectKey),
    ]
  }

  static let autoConnectKey = "T3EvenG2AutoConnect"

  init(connectionTimeout: Duration = .seconds(20), baseHeartbeatInterval: Duration = .seconds(5)) {
    self.connectionTimeout = connectionTimeout
    self.baseHeartbeatInterval = baseHeartbeatInterval
    super.init()
  }

  func connect() {
    guard status == .disconnected || status == .error else { return }
    if status == .error {
      requestedDisconnect = true
      stopBaseHeartbeat()
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
      central = CBCentralManager(
        delegate: self,
        queue: .main,
        options: [CBCentralManagerOptionRestoreIdentifierKey: "T3EvenG2Central"]
      )
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
    stopBaseHeartbeat()
    central?.stopScan()
    stopTasks()
    cancelSpeechAfterDisconnect()
    for arm in [left, right] {
      if let peripheral = arm.peripheral {
        central?.cancelPeripheralConnection(peripheral)
      }
      arm.peripheral = nil
      arm.resetCharacteristics()
    }
    setStatus(.disconnected)
  }

  func resumeDisplay() {
    guard status == .paused, left.ready, right.ready else { return }
    bootstrap(resuming: true)
  }

  private func pauseDisplay() {
    guard status == .ready || status == .starting else { return }
    stopTasks()
    cancelSpeechAfterDisconnect()
    setStatus(.paused, detail: "Restoring T3 display; dictation cancelled")
    pauseTask = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.sendEvenHub(T3EvenG2Protocol.audioControl(enabled: false, magic: self.nextMagic()))
    }
    recoveryTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(1))
      guard let self, !Task.isCancelled, !self.requestedDisconnect else { return }
      self.resumeDisplay()
      self.recoveryTask = nil
    }
  }

  func displayText(_ text: String) {
    let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleaned.isEmpty else { return }
    pendingDisplayText = cleaned
    displayPages = T3EvenG2Protocol.lensTextPages(cleaned)
    displayPageIndex = 0
    guard !listening, !threadPicker.isPresented, status == .ready else { return }
    scheduleDisplay(restingDisplayText)
  }

  func clearDisplay() {
    pendingDisplayText = nil
    displayPages = []
    displayPageIndex = 0
    displayTask?.cancel()
    guard status == .ready else { return }
    displayTask = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.sendEvenHub(T3EvenG2Protocol.shutdown(magic: self.nextMagic()))
    }
  }

  func setInputEnabled(_ enabled: Bool) {
    inputEnabled = enabled
    threadPicker.isPresented = !enabled
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

  func setActiveThread(_ key: String, enabled: Bool) {
    if enabled {
      if activeThreadKey != key {
        pendingDisplayText = nil
        displayPages = []
        displayPageIndex = 0
      }
      activeThreadKey = key
      threadPicker.highlight(key)
      threadPicker.openingKey = nil
      setInputEnabled(true)
    } else if activeThreadKey == key {
      activeThreadKey = nil
      setInputEnabled(false)
    }
  }

  func setThreadChoices(_ choices: [[String: String]]) {
    let next = choices.compactMap { item -> T3EvenG2ThreadPicker.Choice? in
      guard let key = item["key"], !key.isEmpty else { return nil }
      return .init(key: key, title: item["title"] ?? "Untitled", subtitle: item["subtitle"] ?? "")
    }
    guard next != threadPicker.choices else { return }
    threadPicker.update(next)
    if threadPicker.isPresented, status == .ready { scheduleDisplay(restingDisplayText) }
  }

  func showThreadPicker() {
    guard !listening, speechSession == nil else { return }
    threadPicker.isPresented = true
    threadPicker.openingKey = nil
    if status == .ready { scheduleDisplay(restingDisplayText) }
  }

  @MainActor
  func beginDictation() async {
    guard
      status == .ready, inputEnabled, !threadPicker.isPresented,
      !listening, !stoppingDictation, speechSession == nil, !Task.isCancelled
    else { return }
    displayTask?.cancel()
    latestTranscript = ""
    setStatus(.ready, detail: "Preparing on-device speech")
    await sendEvenHub(
      textPayload("Preparing dictation…", magic: nextMagic())
    )
    guard status == .ready, !Task.isCancelled else { return }

    let speech = T3EvenG2SpeechTranscriber()
    speechSession = speech
    do {
      try await speech.start { [weak self, weak speech] text, isFinal in
        guard let self, let speech, self.speechSession === speech, self.status == .ready else { return }
        self.latestTranscript = text
        self.onTranscript?(["text": text, "isFinal": isFinal])
        if !isFinal {
          self.scheduleListeningDisplay(text)
        }
      }
      guard speechSession === speech, status == .ready, !Task.isCancelled else {
        await speech.cancel()
        return
      }
      decoder = T3EvenG2LC3Decoder()
      let displayMagic = nextMagic()
      await sendEvenHub(
        textPayload("Listening…\n\nTap R1 again to send", magic: displayMagic)
      )
      guard speechSession === speech, status == .ready, !Task.isCancelled else { return }
      let audioMagic = nextMagic()
      let microphoneStarted = await sendEvenHub(
        T3EvenG2Protocol.audioControl(enabled: true, magic: audioMagic),
        expectedAckMagic: audioMagic,
        timeout: .seconds(3)
      )
      guard speechSession === speech, status == .ready, !Task.isCancelled else { return }
      guard microphoneStarted else {
        await handleMicrophoneStartFailure(speech)
        return
      }
      listening = true
      emitStatus()
      setStatus(.ready, detail: "Listening through G2 microphone")
    } catch {
      guard speechSession === speech, status == .ready, !Task.isCancelled else {
        await speech.cancel()
        return
      }
      speechSession = nil
      decoder = nil
      listening = false
      setStatus(.ready, detail: error.localizedDescription)
      await sendEvenHub(
        textPayload(
          "Dictation unavailable\n\n\(error.localizedDescription)",
          magic: nextMagic()
        )
      )
    }
  }

  @MainActor
  private func handleMicrophoneStartFailure(_ speech: T3EvenG2SpeechTranscriber) async {
    await speech.cancel()
    guard speechSession === speech, status == .ready, !Task.isCancelled else { return }
    speechSession = nil
    decoder = nil
    setStatus(.ready, detail: "G2 microphone did not start")
    await sendEvenHub(
      textPayload(
        "G2 microphone did not start\n\nTap R1 to retry",
        magic: nextMagic()
      )
    )
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
      if status == .scanning { beginScan() } else if status == .error, !requestedDisconnect { connect() }
    case .poweredOff:
      stopBaseHeartbeat()
      stopTasks()
      cancelSpeechAfterDisconnect()
      left.resetCharacteristics()
      right.resetCharacteristics()
      setStatus(.error, detail: "Bluetooth is off")
    case .unauthorized:
      setStatus(.error, detail: "Bluetooth permission denied")
    case .unsupported:
      setStatus(.error, detail: "Bluetooth is unavailable")
    default:
      break
    }
  }

  func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    guard !requestedDisconnect else { return }
    for peripheral in dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? [] {
      guard let arm = armForName((peripheral.name ?? "").uppercased()) else { continue }
      arm.peripheral = peripheral
      peripheral.delegate = self
    }
    // poweredOn follows restoration; only then may discovery/connect resume.
    setStatus(.scanning, detail: "Restoring G2 connection")
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
    guard
      !requestedDisconnect, status == .scanning || status == .connecting,
      upper.contains("G2_"), let arm = armForName(upper), !arm.ready,
      arm.peripheral?.identifier != peripheral.identifier
    else { return }

    let previous = arm.peripheral
    arm.peripheral = peripheral
    arm.resetCharacteristics()
    if let previous { central.cancelPeripheralConnection(previous) }
    UserDefaults.standard.set(peripheral.identifier.uuidString, forKey: "T3EvenG2Arm\(arm.side)")
    peripheral.delegate = self
    central.connect(peripheral, options: nil)
    setStatus(.connecting, detail: "Found G2 \(arm.side) arm")
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard !requestedDisconnect, let arm = arm(for: peripheral) else { return }
    arm.resetCharacteristics()
    peripheral.discoverServices(nil)
  }

  func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    guard !requestedDisconnect, arm(for: peripheral) != nil else { return }
    retryConnection(detail: error?.localizedDescription ?? "Could not connect to G2")
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
    guard central.state == .poweredOn else {
      setStatus(.error, detail: "Waiting for Bluetooth")
      return
    }
    setStatus(.connecting, detail: "Reconnecting G2 \(arm.side) arm")
    beginScan()
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
    guard arm.write != nil, arm.notify != nil, arm.renderNotify != nil else {
      setStatus(.error, detail: "G2 \(arm.side) protocol characteristics missing")
      return
    }
    updateReadiness(arm)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard let arm = arm(for: peripheral) else { return }
    if error != nil || !characteristic.isNotifying {
      arm.ready = false
      retryConnection(detail: "G2 \(arm.side) notifications unavailable")
      return
    }
    updateReadiness(arm)
  }

  private func updateReadiness(_ arm: Arm) {
    guard arm.servicesDiscovered >= arm.servicesExpected, arm.servicesExpected > 0 else { return }
    arm.ready = arm.write != nil && arm.notify?.isNotifying == true && arm.renderNotify?.isNotifying == true
    guard arm.ready else { return }
    startBaseHeartbeat(for: arm)
    if left.ready, right.ready {
      guard status == .connecting || status == .scanning || connectionTimedOut else { return }
      central?.stopScan()
      scanTimeoutTask?.cancel()
      scanTimeoutTask = nil
      connectionTimedOut = false
      bootstrap()
    } else if !connectionTimedOut, status == .connecting || status == .scanning {
      setStatus(.connecting, detail: "Waiting for other G2 arm")
    }
  }

  private func retryConnection(detail: String) {
    stopTasks()
    cancelSpeechAfterDisconnect()
    setStatus(.error, detail: "\(detail). Reconnecting…")
    reconnectTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(2))
      guard let self, !Task.isCancelled, !self.requestedDisconnect, self.central?.state == .poweredOn else { return }
      self.reconnectTask = nil
      self.connect()
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
    // The shutdown ACK can precede teardown. Relaunch only after its exit event.
    if status == .starting, gesture.kind == "systemExit" {
      shutdownExitObserved = true
      return
    }
    handleGesture(gesture)
  }

  private func beginScan() {
    guard let central, !requestedDisconnect else { return }
    connectionTimedOut = false
    for arm in [left, right] {
      guard !arm.ready else { continue }
      if arm.peripheral == nil,
         let saved = UserDefaults.standard.string(forKey: "T3EvenG2Arm\(arm.side)"),
         let identifier = UUID(uuidString: saved) {
        arm.peripheral = central.retrievePeripherals(withIdentifiers: [identifier]).first
      }
      guard let peripheral = arm.peripheral else { continue }
      peripheral.delegate = self
      if peripheral.state == .connected {
        arm.resetCharacteristics()
        peripheral.discoverServices(nil)
      } else if peripheral.state == .disconnected {
        central.connect(peripheral, options: nil)
      }
    }
    if left.peripheral != nil, right.peripheral != nil {
      setStatus(.connecting, detail: "Waiting for remembered G2 arms")
    }
    central.scanForPeripherals(
      withServices: nil,
      options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
    )
    scanTimeoutTask?.cancel()
    let timeout = connectionTimeout
    scanTimeoutTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: timeout)
      guard
        let self, !Task.isCancelled, !self.requestedDisconnect,
        self.status == .scanning || self.status == .connecting,
        !(self.left.ready && self.right.ready)
      else { return }
      self.scanTimeoutTask = nil
      self.central?.stopScan()
      // Pending CoreBluetooth connects survive the discovery window so sleeping
      // arms can still return while the app is in the background.
      let missing = [self.left, self.right].filter { !$0.ready }.map { $0.side == "L" ? "left" : "right" }
      self.setStatus(
        .error,
        detail: "G2 \(missing.joined(separator: " and ")) arm not ready. Release G2 from other apps or devices, wake both arms, then retry.",
        connectionTimedOut: true
      )
    }
  }

  private func bootstrap(resuming: Bool = false) {
    guard bootstrapTask == nil else { return }
    setStatus(.starting, detail: "Starting direct G2 session")
    bootstrapTask = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.pauseTask?.value
      try? await Task.sleep(for: .milliseconds(800))
      guard !Task.isCancelled else { return }
      let acknowledged = await self.resetSessionPage()
      guard !Task.isCancelled else { return }
      guard acknowledged else {
        self.bootstrapTask = nil
        self.setStatus(resuming ? .paused : .error, detail: "G2 session handshake timed out")
        return
      }
      // Firmware can retain old container names after exit and omit CREATE's
      // acknowledgement. Each session gets a fresh name (under 14 bytes).
      self.pageName = "t3-\(UUID().uuidString.prefix(8))"
      let createMagic = self.nextMagic()
      let created = await self.sendEvenHub(
        T3EvenG2Protocol.createPage(magic: createMagic, name: self.pageName),
        expectedAckMagic: createMagic
      )
      guard !Task.isCancelled else { return }
      guard created else {
        self.bootstrapTask = nil
        self.setStatus(resuming ? .paused : .error, detail: "G2 page creation timed out. Tap to retry.")
        return
      }
      let displayMagic = self.nextMagic()
      let displayed = await self.sendEvenHub(
        self.textPayload(self.restingDisplayText, magic: displayMagic),
        expectedAckMagic: displayMagic
      )
      guard !Task.isCancelled else { return }
      guard displayed else {
        self.bootstrapTask = nil
        self.setStatus(resuming ? .paused : .error, detail: "G2 display startup timed out. Tap to retry.")
        return
      }
      self.setStatus(.ready, detail: "G2 and R1 ready")
      self.startHeartbeat()
      self.bootstrapTask = nil
    }
  }

  private func textPayload(_ text: String, magic: Int) -> [UInt8] {
    T3EvenG2Protocol.rebuildText(text, magic: magic, name: pageName)
  }

  @MainActor
  private func resetSessionPage() async -> Bool {
    guard await sendSessionPrelude(), !Task.isCancelled else { return false }
    // A previous page can survive the BLE connection and block a fresh CREATE.
    // A missing shutdown ACK must not block startup when no page is active.
    let shutdownMagic = nextMagic()
    shutdownExitObserved = false
    let shutdownDeadline = ContinuousClock.now + .seconds(2)
    _ = await sendEvenHub(
      T3EvenG2Protocol.shutdown(magic: shutdownMagic),
      expectedAckMagic: shutdownMagic,
      timeout: .seconds(2)
    )
    guard !Task.isCancelled else { return false }
    while !shutdownExitObserved, ContinuousClock.now < shutdownDeadline {
      do {
        try await Task.sleep(for: .milliseconds(10))
      } catch {
        return false
      }
    }
    guard !Task.isCancelled else { return false }
    return await sendSessionPrelude()
  }

  @MainActor
  private func sendSessionPrelude() async -> Bool {
    guard let peripheral = right.peripheral, let write = right.write else { return false }
    let key = ackKey(service: 0x01, magic: 156)
    pendingAckKeys.insert(key)
    peripheral.writeValue(T3EvenG2Protocol.sessionPrelude, for: write, type: .withoutResponse)
    return await waitForAck(key: key, timeout: .seconds(5))
  }

  private func startBaseHeartbeat(for arm: Arm) {
    guard !requestedDisconnect, central?.state == .poweredOn else { return }
    sendBaseHeartbeat(to: arm)
    guard baseHeartbeatTask == nil else { return }
    let interval = baseHeartbeatInterval
    baseHeartbeatTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: interval)
        guard !Task.isCancelled, let active = self?.sendBaseHeartbeats(), active else { return }
      }
    }
  }

  private func sendBaseHeartbeats() -> Bool {
    guard !requestedDisconnect, central?.state == .poweredOn else { return false }
    for arm in [left, right] { sendBaseHeartbeat(to: arm) }
    return true
  }

  private func sendBaseHeartbeat(to arm: Arm) {
    guard
      arm.ready, let peripheral = arm.peripheral, peripheral.state == .connected,
      let write = arm.write, peripheral.canSendWriteWithoutResponse,
      arm.side != "R" || !transportBusy
    else { return }
    // One short frame; retry next tick if BLE is backpressured or a right-arm
    // page write is in flight. Never splice into a fragmented EvenHub message.
    let authenticating = !arm.didSendAuthentication
    let magic = nextMagic()
    let payload = authenticating
      ? T3EvenG2Protocol.authenticate(magic: magic)
      : T3EvenG2Protocol.baseHeartbeat(magic: magic)
    let frame = T3EvenG2Protocol.frames(
      payload: payload,
      sequence: transportSequence, service: 0x80, flag: 0x00
    )[0]
    transportSequence &+= 1
    // Record only after the write guard passes; a blocked arm retries next tick.
    // Successful hardware sessions return false/empty auth fields; do not gate startup on them.
    if authenticating { arm.didSendAuthentication = true }
    peripheral.writeValue(frame, for: write, type: .withoutResponse)
  }

  private func stopBaseHeartbeat() {
    baseHeartbeatTask?.cancel()
    baseHeartbeatTask = nil
  }

  private func startHeartbeat() {
    heartbeatTask?.cancel()
    heartbeatTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(5))
        guard let self, !Task.isCancelled else { return }
        guard self.status == .ready, !self.transportBusy else { continue }
        let magic = self.nextMagic()
        let alive = await self.sendEvenHub(
          T3EvenG2Protocol.heartbeat(magic: magic),
          expectedAckMagic: magic,
          timeout: .seconds(2)
        )
        guard !Task.isCancelled else { return }
        if !alive {
          self.pauseDisplay()
          return
        }
      }
    }
  }

  private func scheduleDisplay(_ text: String) {
    displayTask?.cancel()
    displayTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(300))
      guard let self, !Task.isCancelled, !self.listening, self.status == .ready else { return }
      await self.sendEvenHub(self.textPayload(text, magic: self.nextMagic()))
    }
  }

  private var restingDisplayText: String {
    if threadPicker.isPresented { return threadPicker.text }
    if !inputEnabled {
      return "T3 Code\n\nOpen a thread to dictate"
    }
    if displayPages.indices.contains(displayPageIndex) {
      return displayPages[displayPageIndex]
    }
    let title = threadPicker.choices.first(where: { $0.key == activeThreadKey })?.title ?? "T3 Code"
    return "\(String(title.replacingOccurrences(of: "\n", with: " ").prefix(92)))\n\nTap R1 to dictate"
  }

  private func scheduleListeningDisplay(_ transcript: String) {
    let text = transcript.isEmpty ? "Listening…" : "Listening…\n\n\(transcript)"
    displayTask?.cancel()
    displayTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(450))
      guard let self, !Task.isCancelled, self.listening, self.status == .ready else { return }
      await self.sendEvenHub(self.textPayload(text, magic: self.nextMagic()))
    }
  }

  @MainActor
  @discardableResult
  private func sendEvenHub(
    _ payload: [UInt8],
    expectedAckMagic: Int? = nil,
    timeout: Duration = .seconds(5)
  ) async -> Bool {
    guard !Task.isCancelled else { return false }
    guard let peripheral = right.peripheral, peripheral.state == .connected, let write = right.write else { return false }
    let deadline = ContinuousClock.now + timeout
    let expectedAckKey = expectedAckMagic.map { ackKey(service: 0xE0, magic: $0) }
    if let expectedAckKey {
      pendingAckKeys.insert(expectedAckKey)
    }
    while transportBusy {
      guard ContinuousClock.now < deadline else {
        clearAck(expectedAckKey)
        return false
      }
      do {
        try await Task.sleep(for: .milliseconds(10))
      } catch {
        clearAck(expectedAckKey)
        return false
      }
    }
    transportBusy = true
    defer { transportBusy = false }
    do {
      try await writeFrames(payload, to: peripheral, characteristic: write, deadline: deadline)
    } catch {
      clearAck(expectedAckKey)
      return false
    }
    guard let expectedAckKey else { return true }
    return await waitForAck(key: expectedAckKey, timeout: timeout)
  }

  @MainActor
  private func writeFrames(
    _ payload: [UInt8],
    to peripheral: CBPeripheral,
    characteristic: CBCharacteristic,
    deadline: ContinuousClock.Instant
  ) async throws {
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
        guard ContinuousClock.now < deadline, peripheral.state == .connected else { throw CancellationError() }
        try await Task.sleep(for: .milliseconds(5))
      }
      try Task.checkCancellation()
      guard peripheral === right.peripheral, peripheral.state == .connected else { throw CancellationError() }
      peripheral.writeValue(frame, for: characteristic, type: .withoutResponse)
      try await Task.sleep(for: .milliseconds(14))
    }
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
    // Handle exits before input gating and debounce: a double-tap can follow
    // a click immediately, or arrive while Settings is open.
    if T3EvenG2Protocol.requiresDisplayRecovery(for: gesture.kind) {
      if gesture.kind == "doubleClick", !listening, speechSession == nil {
        showThreadPicker()
      }
      pauseDisplay()
      return
    }
    if status == .paused, gesture.kind == "click", T3EvenG2Protocol.isDictationSource(gesture.source) {
      resumeDisplay()
      return
    }
    guard status == .ready else { return }
    guard gesture.kind == "click" || T3EvenG2Protocol.lensPageOffset(for: gesture.kind) != nil else { return }
    let now = Date()
    guard now.timeIntervalSince(lastGestureAt) > 0.4 else { return }
    lastGestureAt = now
    if threadPicker.isPresented {
      handlePickerGesture(gesture)
      return
    }
    guard inputEnabled else { return }
    if T3EvenG2Protocol.lensPageOffset(for: gesture.kind) != nil {
      Task { @MainActor [weak self] in
        self?.scrollDisplay(gesture.kind)
      }
      return
    }
    guard gestureTask == nil else { return }
    gestureTask = Task { @MainActor [weak self] in
      await self?.handleClick(gesture)
    }
  }

  private func handlePickerGesture(_ gesture: T3EvenG2Protocol.Gesture) {
    guard T3EvenG2Protocol.isDictationSource(gesture.source), threadPicker.openingKey == nil else { return }
    if let offset = T3EvenG2Protocol.lensPageOffset(for: gesture.kind) {
      threadPicker.move(offset)
      scheduleDisplay(restingDisplayText)
    } else if gesture.kind == "click", let choice = threadPicker.highlighted {
      if inputEnabled, activeThreadKey == choice.key {
        threadPicker.isPresented = false
      } else {
        threadPicker.openingKey = choice.key
      }
      scheduleDisplay(restingDisplayText)
      onThreadSelected?(["key": choice.key])
    }
  }

  @MainActor
  private func handleClick(_ gesture: T3EvenG2Protocol.Gesture) async {
    defer { if !Task.isCancelled { gestureTask = nil } }
    let sourceLabel = gestureSourceLabel(gesture.source)
    let inputAccepted = T3EvenG2Protocol.isDictationSource(gesture.source)
    let feedback = inputAccepted ? "Tap received" : "Input detected"
    await sendEvenHub(
      textPayload(
        "\(feedback)\n\n\(sourceLabel) · \(gesture.kind)",
        magic: nextMagic()
      )
    )
    guard !Task.isCancelled, status == .ready else { return }
    setStatus(.ready, detail: "Input: \(sourceLabel) \(gesture.kind)")
    guard inputAccepted else { return }
    try? await Task.sleep(for: .milliseconds(450))
    guard !Task.isCancelled, status == .ready, inputEnabled else { return }
    if listening { await finishDictation() } else { await beginDictation() }
  }

  private func gestureSourceLabel(_ source: String) -> String {
    switch source {
    case "ring": "R1"
    case "rightTemple": "right temple"
    case "leftTemple": "left temple"
    case "textContainer", "listContainer": "G2 input"
    default: source
    }
  }

  @MainActor
  private func scrollDisplay(_ gestureKind: String) {
    guard
      status == .ready,
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
    let session = speechSession
    displayTask?.cancel()
    let audioMagic = nextMagic()
    await sendEvenHub(
      T3EvenG2Protocol.audioControl(enabled: false, magic: audioMagic),
      expectedAckMagic: audioMagic,
      timeout: .seconds(2)
    )
    guard status == .ready, speechSession === session, !Task.isCancelled else { return }
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
          guard status == .ready, speechSession === session, !Task.isCancelled else { return }
          finalCancelled = true
          latestTranscript = ""
          setStatus(.ready, detail: error.localizedDescription)
        }
      }
    }
    guard status == .ready, speechSession === session, !Task.isCancelled else { return }
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

  private func setStatus(_ next: Status, detail: String = "", connectionTimedOut: Bool = false) {
    self.connectionTimedOut = connectionTimedOut
    status = next
    self.detail = detail
    emitStatus()
  }

  private func emitStatus() {
    onStatus?(snapshot)
  }

  private func stopTasks() {
    connectionTimedOut = false
    shutdownExitObserved = false
    reconnectTask?.cancel()
    reconnectTask = nil
    recoveryTask?.cancel()
    recoveryTask = nil
    gestureTask?.cancel()
    gestureTask = nil
    pauseTask?.cancel()
    pauseTask = nil
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
