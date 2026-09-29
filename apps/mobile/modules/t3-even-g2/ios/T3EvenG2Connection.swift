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
  var onHistoryPosition: (([String: Any]) -> Void)?
  var onHistoryRequest: (([String: Any]) -> Void)?

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

    /// Creates the state holder for one physical glasses arm.
    init(side: String) {
      self.side = side
    }

    /// Clears discovered GATT characteristics and per-arm readiness state.
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
  private var baseHeartbeatTaskID: UUID?
  private let baseHeartbeatInterval: Duration
  private let pageHeartbeatInterval: Duration
  private let pageHeartbeatTimeout: Duration
  /// Test hook called when the base-heartbeat task starts; not a user-facing API.
  var onBaseHeartbeatTaskStart: (() -> Void)?
  /// Test hook called when a base-heartbeat task exits; not a user-facing API.
  var onBaseHeartbeatTaskEnd: (() -> Void)?
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
  private var naturalScrolling = UserDefaults.standard.object(forKey: "T3EvenG2NaturalScrolling") as? Bool ?? true
  private var fastBackGesture = UserDefaults.standard.bool(forKey: "T3EvenG2FastBackGesture")
  private var activeThreadKey: String?
  private var threadPicker = T3EvenG2ThreadPicker()
  private var availableThreadChoices: [T3EvenG2ThreadPicker.Choice] = []
  private var historyByThread: [String: T3EvenG2History] = [:]
  private var historyRecency: [String] = []
  private var historyNotice: String?
  private var historyRequestTask: Task<Void, Never>?
  private var pendingHistoryRequest: (id: String, direction: String)?
  private var listening = false
  private var stoppingDictation = false
  private var latestTranscript = ""
  private var dictationNotice: String?
  private var displayPages: [String] = []
  private var displayPageIndex = 0
  private var lastGestureAt = Date.distantPast
  private var pendingSwipeUp: T3EvenG2Protocol.Gesture?
  private var pendingSwipeDeadline: ContinuousClock.Instant?
  private var swipeUpTask: Task<Void, Never>?
  private var pendingAckKeys: Set<String> = []
  private var receivedAckKeys: Set<String> = []

  /// Returns the current connection, dictation, and scrolling state for the client.
  var snapshot: [String: Any] {
    [
      "status": status.rawValue,
      "detail": detail,
      "connected": status == .ready || status == .paused,
      "listening": listening,
      "autoConnect": UserDefaults.standard.bool(forKey: Self.autoConnectKey),
      "naturalScrolling": naturalScrolling,
      "fastBackGesture": fastBackGesture,
    ]
  }

  static let autoConnectKey = "T3EvenG2AutoConnect"

  /// Creates a connection controller with configurable lifecycle timing intervals.
  init(
    connectionTimeout: Duration = .seconds(20),
    baseHeartbeatInterval: Duration = .seconds(5),
    pageHeartbeatInterval: Duration = .seconds(5),
    pageHeartbeatTimeout: Duration = .seconds(2)
  ) {
    self.connectionTimeout = connectionTimeout
    self.baseHeartbeatInterval = baseHeartbeatInterval
    self.pageHeartbeatInterval = pageHeartbeatInterval
    self.pageHeartbeatTimeout = pageHeartbeatTimeout
    super.init()
  }

  /// Starts scanning or reconnects remembered arms unless already active.
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

  /// Stops Bluetooth work, cancels dictation, resets both arms, and reports disconnected.
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

  /// Restarts the display handshake when both arms are ready and the page is paused.
  func resumeDisplay() {
    guard status == .paused, left.ready, right.ready else { return }
    bootstrap(resuming: true)
  }

  /// Stops active work and schedules display recovery after a page failure or exit.
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

  /// Stores paginated text and displays it when the connection is ready and idle.
  func displayText(_ text: String) {
    let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleaned.isEmpty else { return }
    if let activeThreadKey { historyByThread.removeValue(forKey: activeThreadKey) }
    cancelHistoryRequest()
    refreshThreadChoices()
    dictationNotice = nil
    displayPages = T3EvenG2Protocol.lensTextPages(cleaned)
    displayPageIndex = 0
    guard !listening, !threadPicker.isPresented, status == .ready else { return }
    scheduleDisplay(restingDisplayText)
  }

  /// Clears stored display pages and sends shutdown when the page is ready.
  func clearDisplay() {
    if let activeThreadKey { historyByThread.removeValue(forKey: activeThreadKey) }
    cancelHistoryRequest()
    refreshThreadChoices()
    dictationNotice = nil
    displayPages = []
    displayPageIndex = 0
    displayTask?.cancel()
    guard status == .ready else { return }
    displayTask = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.sendEvenHub(T3EvenG2Protocol.shutdown(magic: self.nextMagic()))
    }
  }

  /// Enables thread input or cancels dictation when input is disabled.
  func setInputEnabled(_ enabled: Bool) {
    if inputEnabled != enabled { clearPendingSwipe() }
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

  /// Persists the scrolling direction preference and publishes updated status.
  func setNaturalScrolling(_ enabled: Bool) {
    naturalScrolling = enabled
    UserDefaults.standard.set(enabled, forKey: "T3EvenG2NaturalScrolling")
    emitStatus()
  }

  /// Selects a shorter escape window to reduce accidental Back gestures while browsing.
  func setFastBackGesture(_ enabled: Bool) {
    clearPendingSwipe()
    fastBackGesture = enabled
    UserDefaults.standard.set(enabled, forKey: "T3EvenG2FastBackGesture")
    emitStatus()
  }

  /// Selects or clears the active thread and updates the input picker state.
  func setActiveThread(_ key: String, enabled: Bool) {
    if activeThreadKey != key || !enabled {
      clearPendingSwipe()
      cancelHistoryRequest()
    }
    if enabled {
      if activeThreadKey != key {
        dictationNotice = nil
        displayPages = []
        displayPageIndex = 0
      }
      activeThreadKey = key
      refreshThreadChoices()
      threadPicker.highlight(key)
      threadPicker.openingKey = nil
      setInputEnabled(true)
    } else if activeThreadKey == key {
      activeThreadKey = nil
      refreshThreadChoices()
      setInputEnabled(false)
    }
  }

  /// Replaces picker choices from client dictionaries, dropping entries without keys.
  func setThreadChoices(_ choices: [[String: String]]) {
    let next = choices.compactMap { item -> T3EvenG2ThreadPicker.Choice? in
      guard let key = item["key"], !key.isEmpty else { return nil }
      return .init(key: key, title: item["title"] ?? "Untitled", subtitle: item["subtitle"] ?? "")
    }
    guard next != threadPicker.choices else { return }
    availableThreadChoices = next
    refreshThreadChoices()
    if threadPicker.isPresented, status == .ready { scheduleDisplay(restingDisplayText) }
  }

  /// Accepts a bounded window only for the active thread and the current history request.
  func setReplyHistory(_ payload: [String: Any]) {
    guard let key = payload["threadKey"] as? String, key == activeThreadKey,
      let values = payload["replies"] as? [[String: String]]
    else { return }
    let requestID = payload["requestId"] as? String
    if let requestID, requestID != pendingHistoryRequest?.id { return }
    let replies = values.compactMap { value -> T3EvenG2History.Reply? in
      guard let id = value["id"], !id.isEmpty, let text = value["text"] else { return nil }
      return .init(id: id, text: text, prompt: value["prompt"] ?? "")
    }
    var history = historyByThread[key] ?? T3EvenG2History()
    let previousID = history.currentID
    let previousLatest = history.latestReplyID
    let followLatest = history.currentID != nil && history.currentID == previousLatest
      && history.pageIndex == 0 && !listening && speechSession == nil
      && (dictationNotice == nil || dictationNotice == "Sending to T3 Code…")
      && pendingHistoryRequest == nil
    history.updateSnapshot(.init(
      replies: replies,
      startIndex: max(0, payload["startIndex"] as? Int ?? 0),
      totalReplies: max(0, payload["totalReplies"] as? Int ?? replies.count),
      hasOlder: payload["hasOlder"] as? Bool ?? false,
      hasNewer: payload["hasNewer"] as? Bool ?? false,
      latestReplyID: payload["latestReplyId"] as? String,
      loading: payload["loading"] as? Bool ?? false
    ))
    let latestChanged = history.latestReplyID != previousLatest
    let requestLatest = latestChanged && followLatest && history.jumpToLatest() != nil
    if latestChanged, dictationNotice == "Sending to T3 Code…" {
      dictationNotice = nil
    }
    let fulfilled = requestID != nil && requestID == pendingHistoryRequest?.id
      && !(payload["loading"] as? Bool ?? false)
    if fulfilled, let request = pendingHistoryRequest {
      cancelHistoryRequest()
      let remaining = moveLoadedHistory(&history, from: previousID, direction: request.direction)
      if remaining != nil { historyNotice = "History unavailable · swipe to retry" }
    }
    storeHistory(history, for: key)
    refreshThreadChoices()
    if requestLatest { requestHistory("latest") }
    if pendingHistoryRequest == nil { publishHistoryPosition() }
    if !listening, speechSession == nil, status == .ready { scheduleDisplay(restingDisplayText) }
  }

  /// Completes a requested move without skipping a newly selected replacement or first reply.
  private func moveLoadedHistory(
    _ history: inout T3EvenG2History, from previousID: String?, direction: String
  ) -> Int? {
    if direction == "latest" { return history.jumpToLatest() }
    if previousID != nil, history.currentID == previousID {
      return history.move(direction == "older" ? -1 : 1)
    }
    return history.currentID == nil ? -1 : nil
  }

  /// Retains at most eight recently used thread windows in this app session.
  private func storeHistory(_ history: T3EvenG2History, for key: String) {
    historyByThread[key] = history
    historyRecency.removeAll { $0 == key }
    historyRecency.append(key)
    while historyRecency.count > 8 {
      historyByThread.removeValue(forKey: historyRecency.removeFirst())
    }
  }

  /// Adds a distinct Latest output action without inventing a thread identifier.
  private func refreshThreadChoices() {
    var choices = availableThreadChoices
    if let key = activeThreadKey, historyByThread[key]?.currentID != nil {
      let title = choices.first(where: { $0.key == key })?.title ?? "Current thread"
      choices.insert(.init(key: key, title: "Latest output", subtitle: title, isLatestOutput: true), at: 0)
    }
    threadPicker.update(choices)
  }

  /// Reports the reading anchor so JavaScript can retain its window across updates and remounts.
  private func publishHistoryPosition() {
    guard let key = activeThreadKey else { return }
    let id = historyByThread[key]?.currentID ?? ""
    onHistoryPosition?(["threadKey": key, "messageId": id])
  }

  /// Requests an adjacent window and bounds waiting without blocking Back or dictation.
  private func requestHistory(_ direction: String) {
    guard pendingHistoryRequest == nil, let key = activeThreadKey else { return }
    let anchor = historyByThread[key]?.currentID ?? ""
    let id = UUID().uuidString
    pendingHistoryRequest = (id, direction)
    historyNotice = "Loading \(direction == "latest" ? "latest" : direction) replies…"
    historyRequestTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(8))
      guard let self, !Task.isCancelled, self.pendingHistoryRequest?.id == id else { return }
      self.cancelHistoryRequest()
      self.historyNotice = "History unavailable · swipe to retry"
      self.publishHistoryPosition()
      if self.status == .ready, !self.listening, self.speechSession == nil {
        self.scheduleDisplay(self.restingDisplayText)
      }
    }
    onHistoryRequest?(["requestId": id, "threadKey": key, "anchorId": anchor, "direction": direction])
  }

  /// Invalidates pending loads so their delayed snapshots cannot move the reader afterward.
  private func cancelHistoryRequest() {
    historyRequestTask?.cancel()
    historyRequestTask = nil
    pendingHistoryRequest = nil
    historyNotice = nil
  }

  /// Jumps to the newest cached reply, requesting a newer window when necessary.
  private func showLatestOutput() {
    guard let key = activeThreadKey, var history = historyByThread[key] else { return }
    cancelHistoryRequest()
    threadPicker.isPresented = false
    dictationNotice = nil
    let request = history.jumpToLatest()
    storeHistory(history, for: key)
    if request != nil { requestHistory("latest") } else { publishHistoryPosition() }
    scheduleDisplay(restingDisplayText)
  }

  /// Opens the thread picker when speech capture is not active.
  func showThreadPicker() {
    guard !listening, speechSession == nil else { return }
    dictationNotice = nil
    cancelHistoryRequest()
    publishHistoryPosition()
    clearPendingSwipe()
    refreshThreadChoices()
    threadPicker.highlightLatestOutput()
    threadPicker.isPresented = true
    threadPicker.openingKey = nil
    if status == .ready { scheduleDisplay(restingDisplayText) }
  }

  /// Starts speech analysis and requires the microphone command to be acknowledged.
  @MainActor
  func beginDictation() async {
    guard
      status == .ready, inputEnabled, !threadPicker.isPresented,
      !listening, !stoppingDictation, speechSession == nil, !Task.isCancelled
    else { return }
    cancelHistoryRequest()
    publishHistoryPosition()
    clearPendingSwipe()
    dictationNotice = nil
    displayTask?.cancel()
    latestTranscript = ""
    let speech = T3EvenG2SpeechTranscriber()
    speechSession = speech
    setStatus(.ready, detail: "Preparing on-device speech")
    await sendEvenHub(
      textPayload("Preparing dictation…", magic: nextMagic())
    )
    guard speechSession === speech, status == .ready, !Task.isCancelled else { return }
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
        textPayload(listeningDisplayText(), magic: displayMagic)
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
      showDictationNotice("Dictation unavailable\n\n\(error.localizedDescription)\n\nSwipe up then down: back")
    }
  }

  /// Cancels the attempted speech session and displays a retry notice.
  @MainActor
  private func handleMicrophoneStartFailure(_ speech: T3EvenG2SpeechTranscriber) async {
    await speech.cancel()
    guard speechSession === speech, status == .ready, !Task.isCancelled else { return }
    speechSession = nil
    decoder = nil
    setStatus(.ready, detail: "G2 microphone did not start")
    showDictationNotice("G2 microphone did not start\n\nTap R1 to retry\nSwipe up then down: back")
  }

  /// Stops microphone capture and finalizes the current transcript.
  @MainActor
  func finishDictation() async {
    await stopDictation(cancelled: false)
  }

  /// Stops microphone capture and discards the current transcript.
  @MainActor
  func cancelDictation() async {
    await stopDictation(cancelled: true)
  }

  /// Handles Bluetooth power changes by starting discovery or ending active work.
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

  /// Reattaches restored peripherals and waits for Bluetooth readiness before resuming.
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

  /// Assigns a discovered G2 peripheral to its arm and begins connecting to it.
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

  /// Clears stale arm characteristics and starts service discovery after connection.
  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard !requestedDisconnect, let arm = arm(for: peripheral) else { return }
    arm.resetCharacteristics()
    peripheral.discoverServices(nil)
  }

  /// Schedules a retry when a requested G2 arm connection fails.
  func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    guard !requestedDisconnect, arm(for: peripheral) != nil else { return }
    retryConnection(detail: error?.localizedDescription ?? "Could not connect to G2")
  }

  /// Resets a disconnected arm and either reports disconnect or resumes scanning.
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

  /// Starts characteristic discovery for each service found on a known arm.
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

  /// Records required G2 characteristics and updates readiness after all services arrive.
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

  /// Retries the connection if notifications fail, otherwise updates arm readiness.
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

  /// Marks an arm ready when its services and both notification streams are active.
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

  /// Cancels current tasks, reports the error, and reconnects after a short delay.
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

  /// Routes render audio, acknowledgements, and decoded gestures from notifications.
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

  /// Reconnects remembered peripherals, scans for missing arms, and enforces a timeout.
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

  /// Resets the previous page, creates a fresh one, and displays its resting content.
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

  /// Builds a page-rebuild payload using this connection's current container name.
  private func textPayload(_ text: String, magic: Int) -> [UInt8] {
    T3EvenG2Protocol.rebuildText(text, magic: magic, name: pageName)
  }

  /// Sends the session prelude, shuts down any prior page, and sends the prelude again.
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

  /// Writes the fixed session prelude to the right arm and waits for its ACK.
  @MainActor
  private func sendSessionPrelude() async -> Bool {
    guard let peripheral = right.peripheral, let write = right.write else { return false }
    let key = ackKey(service: 0x01, magic: 156)
    pendingAckKeys.insert(key)
    peripheral.writeValue(T3EvenG2Protocol.sessionPrelude, for: write, type: .withoutResponse)
    return await waitForAck(key: key, timeout: .seconds(5))
  }

  /// Sends an immediate arm heartbeat and starts the shared periodic heartbeat task.
  private func startBaseHeartbeat(for arm: Arm) {
    guard !requestedDisconnect, central?.state == .poweredOn else { return }
    sendBaseHeartbeat(to: arm)
    guard baseHeartbeatTask == nil else { return }
    let interval = baseHeartbeatInterval
    let taskID = UUID()
    baseHeartbeatTaskID = taskID
    baseHeartbeatTask = Task { @MainActor [weak self] in
      defer { self?.finishBaseHeartbeat(taskID) }
      while !Task.isCancelled {
        try? await Task.sleep(for: interval)
        guard !Task.isCancelled, let active = self?.sendBaseHeartbeats(), active else { break }
      }
    }
    onBaseHeartbeatTaskStart?()
  }

  /// Sends one heartbeat to each arm and reports whether the connection remains active.
  private func sendBaseHeartbeats() -> Bool {
    guard !requestedDisconnect, central?.state == .poweredOn else { return false }
    for arm in [left, right] { sendBaseHeartbeat(to: arm) }
    return true
  }

  /// Sends authentication once, then liveness heartbeats when BLE transport is available.
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

  /// Cancels the base-heartbeat task and clears its active task identifier.
  private func stopBaseHeartbeat() {
    baseHeartbeatTask?.cancel()
    baseHeartbeatTask = nil
    baseHeartbeatTaskID = nil
  }

  /// Reports task completion and clears state only when this is still the active task.
  private func finishBaseHeartbeat(_ taskID: UUID) {
    onBaseHeartbeatTaskEnd?()
    guard baseHeartbeatTaskID == taskID else { return }
    baseHeartbeatTask = nil
    baseHeartbeatTaskID = nil
  }

  /// Monitors page acknowledgements and pauses display after two consecutive misses.
  private func startHeartbeat() {
    heartbeatTask?.cancel()
    let interval = pageHeartbeatInterval
    let timeout = pageHeartbeatTimeout
    heartbeatTask = Task { @MainActor [weak self] in
      var consecutiveMisses = 0
      while !Task.isCancelled {
        try? await Task.sleep(for: interval)
        guard let self, !Task.isCancelled else { return }
        guard self.status == .ready, !self.transportBusy else { continue }
        let magic = self.nextMagic()
        let alive = await self.sendEvenHub(
          T3EvenG2Protocol.heartbeat(magic: magic),
          expectedAckMagic: magic,
          timeout: timeout
        )
        guard !Task.isCancelled else { return }
        if !alive {
          consecutiveMisses += 1
          if consecutiveMisses == 2 {
            self.pauseDisplay()
            return
          }
        } else {
          consecutiveMisses = 0
        }
      }
    }
  }

  /// Debounces a resting display update and sends it if the connection stays ready.
  private func scheduleDisplay(_ text: String) {
    displayTask?.cancel()
    displayTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(300))
      guard let self, !Task.isCancelled, !self.listening, self.status == .ready else { return }
      await self.sendEvenHub(self.textPayload(text, magic: self.nextMagic()))
    }
  }

  /// Selects picker, empty-state, notice, paginated reply, or active-thread text.
  private var restingDisplayText: String {
    if threadPicker.isPresented { return threadPicker.text }
    if !inputEnabled {
      return "T3 Code\n\nOpen a thread to dictate"
    }
    if let dictationNotice { return dictationNotice }
    if let key = activeThreadKey, let history = historyByThread[key] {
      guard let historyNotice else { return history.text }
      var lines = history.text.components(separatedBy: "\n")
      if !lines.isEmpty { lines.removeLast() }
      return (lines + [historyNotice]).joined(separator: "\n")
    }
    if displayPages.indices.contains(displayPageIndex) {
      return displayPages[displayPageIndex]
    }
    let title = threadPicker.choices.first(where: { $0.key == activeThreadKey })?.title ?? "T3 Code"
    return "\(String(title.replacingOccurrences(of: "\n", with: " ").prefix(92)))\n\nTap R1 to dictate"
  }

  /// Stores a notice and schedules it for display.
  private func showDictationNotice(_ text: String) {
    dictationNotice = text
    scheduleDisplay(restingDisplayText)
  }

  /// Debounces transcript display updates while listening remains active.
  private func scheduleListeningDisplay(_ transcript: String) {
    let text = listeningDisplayText(transcript)
    displayTask?.cancel()
    displayTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(450))
      guard let self, !Task.isCancelled, self.listening, self.status == .ready else { return }
      await self.sendEvenHub(self.textPayload(text, magic: self.nextMagic()))
    }
  }

  /// Formats listening controls and optional recognized transcript for the lens.
  private func listeningDisplayText(_ transcript: String = "") -> String {
    let instructions = "Listening…\n\nTap R1: send\nSwipe up then down: cancel"
    return transcript.isEmpty ? instructions : "\(instructions)\n\n\(transcript)"
  }

  /// Serializes an EvenHub payload, writes its frames, and optionally waits for its ACK.
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

  /// Frames a payload and writes each chunk while observing BLE readiness and deadline.
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

  /// Waits until the keyed ACK arrives or timeout or cancellation ends the wait.
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

  /// Removes pending and received ACK entries when a key exists.
  private func clearAck(_ key: String?) {
    guard let key else { return }
    pendingAckKeys.remove(key)
    receivedAckKeys.remove(key)
  }

  /// Combines a protocol service and magic value into the acknowledgement lookup key.
  private func ackKey(service: UInt8, magic: Int) -> String {
    "\(service):\(magic)"
  }

  /// Decodes one audio packet and appends its PCM to the active speech session.
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

  /// Routes gestures through recovery, back, picker, and active-thread handling.
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
    if handleSwipeEscape(gesture) { return }
    if handleRecoveryInput(gesture) { return }
    guard status == .ready else { return }
    guard ["click", "scrollUp", "scrollDown", "longPress"].contains(gesture.kind) else { return }
    let now = Date()
    guard now.timeIntervalSince(lastGestureAt) > 0.4 else { return }
    lastGestureAt = now
    if handleBackGesture(gesture) { return }
    if threadPicker.isPresented {
      handlePickerGesture(gesture)
      return
    }
    handleThreadGesture(gesture)
  }

  /// Defers swipe-up and treats a following swipe-down as the dictation back gesture.
  private func handleSwipeEscape(_ gesture: T3EvenG2Protocol.Gesture) -> Bool {
    guard status == .ready || ((status == .paused || status == .error) && left.ready && right.ready),
      T3EvenG2Protocol.isDictationSource(gesture.source),
      ["click", "scrollUp", "scrollDown", "longPress"].contains(gesture.kind)
    else { return false }
    if gesture.kind == "scrollDown", let deadline = pendingSwipeDeadline, ContinuousClock.now < deadline {
      clearPendingSwipe()
      lastGestureAt = Date()
      let back = T3EvenG2Protocol.Gesture(kind: "longPress", source: gesture.source)
      if !handleRecoveryInput(back) { _ = handleBackGesture(back) }
      return true
    }
    guard gesture.kind == "scrollUp" else {
      flushPendingSwipe()
      return false
    }
    let now = Date()
    guard now.timeIntervalSince(lastGestureAt) > 0.4 else { return true }
    lastGestureAt = now
    flushPendingSwipe()
    pendingSwipeUp = gesture
    let escapeWindow: Duration = .milliseconds(fastBackGesture ? 350 : 650)
    pendingSwipeDeadline = .now + escapeWindow
    swipeUpTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: escapeWindow)
      guard !Task.isCancelled else { return }
      self?.flushPendingSwipe()
    }
    return true
  }

  /// Cancels the swipe-up delay and clears its pending gesture and deadline.
  private func clearPendingSwipe() {
    swipeUpTask?.cancel()
    swipeUpTask = nil
    pendingSwipeUp = nil
    pendingSwipeDeadline = nil
  }

  /// Routes a deferred swipe-up to the picker or active-thread gesture handler.
  private func flushPendingSwipe() {
    guard let gesture = pendingSwipeUp else { return }
    clearPendingSwipe()
    guard status == .ready else { return }
    if threadPicker.isPresented { handlePickerGesture(gesture) } else { handleThreadGesture(gesture) }
  }

  /// Restarts display bootstrap for valid input received while paused or errored.
  private func handleRecoveryInput(_ gesture: T3EvenG2Protocol.Gesture) -> Bool {
    guard status == .paused || status == .error, left.ready, right.ready,
      ["click", "longPress"].contains(gesture.kind),
      T3EvenG2Protocol.isDictationSource(gesture.source)
    else { return false }
    if gesture.kind != "click" { _ = handleBackGesture(gesture) }
    bootstrap(resuming: true)
    return true
  }

  /// Scrolls displayed pages or schedules handling for a click gesture.
  private func handleThreadGesture(_ gesture: T3EvenG2Protocol.Gesture) {
    guard inputEnabled else { return }
    if T3EvenG2Protocol.lensPageOffset(for: gesture.kind) != nil {
      Task { @MainActor [weak self] in
        self?.scrollDisplay(gesture.kind)
      }
      return
    }
    guard gesture.kind == "click", gestureTask == nil else { return }
    gestureTask = Task { @MainActor [weak self] in
      await self?.handleClick(gesture)
    }
  }

  /// Handles long-press back across dictation, picker, notice, and thread states.
  private func handleBackGesture(_ gesture: T3EvenG2Protocol.Gesture) -> Bool {
    guard gesture.kind == "longPress",
      T3EvenG2Protocol.isDictationSource(gesture.source)
    else { return false }
    cancelHistoryRequest()
    publishHistoryPosition()
    // Dictation is modal: Back cancels even when the underlying reply scrolls.
    if listening || speechSession != nil || (!threadPicker.isPresented && gestureTask != nil) {
      gestureTask?.cancel()
      gestureTask = nil
      dictationNotice = nil
      cancelSpeechAfterDisconnect()
      setStatus(.ready, detail: "Dictation cancelled")
      scheduleDisplay(restingDisplayText)
      gestureTask = Task { @MainActor [weak self] in
        guard let self else { return }
        await self.sendEvenHub(T3EvenG2Protocol.audioControl(enabled: false, magic: self.nextMagic()))
        if !Task.isCancelled { self.gestureTask = nil }
      }
      return true
    }
    if threadPicker.isPresented {
      threadPicker.openingKey = nil
      if inputEnabled, activeThreadKey != nil { threadPicker.isPresented = false }
      scheduleDisplay(restingDisplayText)
      return true
    }
    if dictationNotice != nil {
      dictationNotice = nil
      scheduleDisplay(restingDisplayText)
      return true
    }
    guard inputEnabled else { return false }
    showThreadPicker()
    return true
  }

  /// Moves the picker selection or emits the selected thread key on click.
  private func handlePickerGesture(_ gesture: T3EvenG2Protocol.Gesture) {
    guard T3EvenG2Protocol.isDictationSource(gesture.source), threadPicker.openingKey == nil else { return }
    if let offset = T3EvenG2Protocol.lensPageOffset(for: gesture.kind, naturalScrolling: naturalScrolling) {
      threadPicker.move(offset)
      scheduleDisplay(restingDisplayText)
    } else if gesture.kind == "click", let choice = threadPicker.highlighted {
      if choice.isLatestOutput {
        showLatestOutput()
        return
      }
      if inputEnabled, activeThreadKey == choice.key {
        threadPicker.isPresented = false
      } else {
        threadPicker.openingKey = choice.key
      }
      scheduleDisplay(restingDisplayText)
      onThreadSelected?(["key": choice.key])
    }
  }

  /// Shows input feedback, then starts or finishes dictation for accepted input.
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

  /// Converts protocol input-source names to labels shown on the glasses.
  private func gestureSourceLabel(_ source: String) -> String {
    switch source {
    case "ring": "R1"
    case "rightTemple": "right temple"
    case "leftTemple": "left temple"
    case "textContainer", "listContainer": "G2 input"
    default: source
    }
  }

  /// Changes the visible reply page in the configured scroll direction.
  @MainActor
  private func scrollDisplay(_ gestureKind: String) {
    guard
      status == .ready,
      !listening, speechSession == nil, dictationNotice == nil,
      let offset = T3EvenG2Protocol.lensPageOffset(for: gestureKind, naturalScrolling: naturalScrolling)
    else { return }
    if let key = activeThreadKey, var history = historyByThread[key] {
      guard pendingHistoryRequest == nil else { return }
      historyNotice = nil
      let request = history.move(offset)
      storeHistory(history, for: key)
      publishHistoryPosition()
      if let request { requestHistory(request < 0 ? "older" : "newer") }
      scheduleDisplay(restingDisplayText)
      setStatus(.ready, detail: history.positionDescription)
      return
    }
    guard displayPages.count > 1 else { return }
    let nextIndex = min(max(displayPageIndex + offset, 0), displayPages.count - 1)
    guard nextIndex != displayPageIndex else { return }
    displayPageIndex = nextIndex
    scheduleDisplay(restingDisplayText)
    setStatus(.ready, detail: "G2 page \(displayPageIndex + 1) of \(displayPages.count)")
  }

  /// Stops microphone capture and either discards speech or finalizes and reports it.
  @MainActor
  private func stopDictation(cancelled: Bool) async {
    guard listening || speechSession != nil, !stoppingDictation else { return }
    let session = speechSession
    stoppingDictation = true
    defer { clearStoppingDictation(for: session) }
    var finalCancelled = cancelled
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
    stoppingDictation = false
    speechSession = nil
    decoder = nil

    if finalCancelled {
      onTranscript?(["text": "", "isFinal": true, "cancelled": true])
      dictationNotice = nil
      scheduleDisplay(restingDisplayText)
    } else if latestTranscript.isEmpty {
      showDictationNotice("No speech recognized\n\nTap R1 to try again\nSwipe up then down: back")
    } else {
      showDictationNotice("Sending to T3 Code…")
    }
    if status != .error, !requestedDisconnect, left.ready, right.ready {
      setStatus(.ready, detail: "G2 and R1 ready")
    }
  }

  /// Clears the stopping flag only if the finishing session remains current.
  private func clearStoppingDictation(for session: AnyObject?) {
    // A cancelled finish can return after another session has started stopping.
    if speechSession === session { stoppingDictation = false }
  }

  /// Resolves an arm from a peripheral name containing its `_L_` or `_R_` marker.
  private func armForName(_ name: String) -> Arm? {
    if name.contains("_L_") { return left }
    if name.contains("_R_") { return right }
    return nil
  }

  /// Finds which tracked arm owns the peripheral identifier.
  private func arm(for peripheral: CBPeripheral) -> Arm? {
    if left.peripheral?.identifier == peripheral.identifier { return left }
    if right.peripheral?.identifier == peripheral.identifier { return right }
    return nil
  }

  /// Advances the session magic, wrapping from 255 back to 101.
  private func nextMagic() -> Int {
    magic = magic >= 255 ? 100 : magic + 1
    return magic
  }

  /// Updates connection status and detail, then emits the resulting snapshot.
  private func setStatus(_ next: Status, detail: String = "", connectionTimedOut: Bool = false) {
    self.connectionTimedOut = connectionTimedOut
    status = next
    self.detail = detail
    emitStatus()
  }

  /// Sends the current status snapshot to the registered observer.
  private func emitStatus() {
    onStatus?(snapshot)
  }

  /// Cancels scheduled connection, display, gesture, heartbeat, recovery, and ACK work.
  private func stopTasks() {
    cancelHistoryRequest()
    publishHistoryPosition()
    clearPendingSwipe()
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

  /// Clears active speech state, emits cancellation, and asynchronously cancels analysis.
  private func cancelSpeechAfterDisconnect() {
    guard listening || speechSession != nil else { return }
    listening = false
    stoppingDictation = false
    let speech = speechSession as? T3EvenG2SpeechTranscriber
    speechSession = nil
    decoder = nil
    onTranscript?(["text": "", "isFinal": true, "cancelled": true])
    Task { @MainActor in await speech?.cancel() }
  }
}
