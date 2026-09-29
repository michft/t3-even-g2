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
  private var displayIdleTask: Task<Void, Never>?
  private let waitForDisplayIdle: @MainActor (Duration) async throws -> Void
  private var displayIsSleeping = false
  private var lastWakeAt = Date.distantPast
  private var bootstrapTask: Task<Void, Never>?
  private var shutdownExitObserved = false
  private var scanTimeoutTask: Task<Void, Never>?
  private let connectionTimeout: Duration
  private var connectionTimedOut = false
  private var gestureTask: Task<Void, Never>?
  private var startingDictation = false
  private var inputAttempt = 0
  private let diagnostics: T3EvenG2Diagnostics
  private var pauseTask: Task<Void, Never>?
  private var recoveryTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var speechSession: AnyObject?
  private var decoder: T3EvenG2LC3Decoder?
  private var requestedDisconnect = false
  private var transportBusy = false
  private var inputEnabled = false
  private var naturalScrolling = UserDefaults.standard.object(forKey: "T3EvenG2NaturalScrolling") as? Bool ?? true
  private var activeThreadKey: String?
  private var openAtLatest = false
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
  private var threadActivityText = ""
  private var displayPages: [String] = []
  private var displayPageIndex = 0
  private var lastGestureAt = Date.distantPast
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
    ]
  }

  static let autoConnectKey = "T3EvenG2AutoConnect"

  /// Creates a connection controller with configurable lifecycle timing intervals.
  init(
    connectionTimeout: Duration = .seconds(20),
    baseHeartbeatInterval: Duration = .seconds(5),
    pageHeartbeatInterval: Duration = .seconds(5),
    pageHeartbeatTimeout: Duration = .seconds(2),
    waitForDisplayIdle: @escaping @MainActor (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    diagnostics: T3EvenG2Diagnostics = T3EvenG2Diagnostics()
  ) {
    self.connectionTimeout = connectionTimeout
    self.baseHeartbeatInterval = baseHeartbeatInterval
    self.pageHeartbeatInterval = pageHeartbeatInterval
    self.pageHeartbeatTimeout = pageHeartbeatTimeout
    self.waitForDisplayIdle = waitForDisplayIdle
    self.diagnostics = diagnostics
    super.init()
    trace("connection.created")
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
    displayIsSleeping = false
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
    displayIsSleeping = false
    bootstrap(resuming: true)
  }

  /// Stops active work and schedules display recovery after a page failure or exit.
  private func pauseDisplay() {
    guard status == .ready || status == .starting else { return }
    stopTasks()
    cancelSpeechAfterDisconnect()
    setStatus(.paused, detail: "Restoring T3 display; dictation stopped")
    pauseTask = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.sendEvenHub(T3EvenG2Protocol.audioControl(enabled: false, magic: self.nextMagic()))
    }
    guard !displayIsSleeping else { return }
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
    guard status == .ready, !displayIsSleeping else { return }
    displayTask = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.sendEvenHub(T3EvenG2Protocol.shutdown(magic: self.nextMagic()))
    }
  }

  /// Enables thread input or cancels dictation when input is disabled.
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

  /// Persists the scrolling direction preference and publishes updated status.
  func setNaturalScrolling(_ enabled: Bool) {
    naturalScrolling = enabled
    UserDefaults.standard.set(enabled, forKey: "T3EvenG2NaturalScrolling")
    emitStatus()
  }

  /// Selects or clears the active thread and updates the input picker state.
  func setActiveThread(_ key: String, enabled: Bool) {
    if activeThreadKey != key || inputEnabled != enabled {
      trace("thread.selection", ["targetThread": key, "enabled": enabled])
    }
    if activeThreadKey != key || !enabled {
      cancelHistoryRequest()
    }
    if enabled {
      if activeThreadKey != key || !inputEnabled {
        openAtLatest = true
        if var history = historyByThread[key] {
          history.jumpToLatest()
          storeHistory(history, for: key)
        }
      }
      if activeThreadKey != key {
        dictationNotice = nil
        threadActivityText = ""
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
      threadActivityText = ""
      refreshThreadChoices()
      setInputEnabled(false)
    }
  }

  /// Updates a waiting submission from phone state without reopening a dismissed notice.
  func setThreadActivity(_ key: String, text: String) {
    guard key == activeThreadKey else { return }
    let wasActive = !threadActivityText.isEmpty
    threadActivityText = text
    guard isWaitingForReply else { return }
    if wasActive, text.isEmpty { dictationNotice = nil }
    if status == .ready, !listening, speechSession == nil {
      scheduleDisplay(restingDisplayText)
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
      && (dictationNotice == nil || isWaitingForReply)
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
    let jumpToLatest = openAtLatest || (latestChanged && followLatest)
    let requestLatest = jumpToLatest && history.jumpToLatest() != nil
    if openAtLatest, !requestLatest, !(payload["loading"] as? Bool ?? false) { openAtLatest = false }
    if latestChanged, isWaitingForReply {
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
    if requestLatest, requestID == nil { requestHistory("latest") }
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
    trace("history.position")
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
    openAtLatest = false
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
    displayIsSleeping = false
    restartDisplayIdleTimer()
    cancelHistoryRequest()
    publishHistoryPosition()
    dictationNotice = nil
    displayTask?.cancel()
    latestTranscript = ""
    let speech = T3EvenG2SpeechTranscriber()
    speechSession = speech
    trace("dictation.preparing")
    setStatus(.ready, detail: "Preparing on-device speech")
    trace("display.request", ["screen": "preparing"])
    await sendVisibleText("Preparing dictation…")
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
      trace("display.request", ["screen": "listening"])
      await sendVisibleText(listeningDisplayText())
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
      trace("dictation.listening")
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
      showDictationNotice("Dictation unavailable\n\n\(error.localizedDescription)\n\nL arm tap: back")
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
    showDictationNotice("G2 microphone did not start\n\nTap R1 to retry\nL arm tap: back")
  }

  /// Stops microphone capture and finalizes the current transcript.
  @MainActor
  func finishDictation() async {
    trace("dictation.finish-requested")
    await stopDictation(cancelled: false)
  }

  /// Stops microphone capture and discards the current transcript.
  @MainActor
  func cancelDictation() async {
    trace("dictation.cancelled", ["reason": "client"])
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
    trace("gesture.received", ["kind": gesture.kind, "source": gesture.source, "arm": arm.side])
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
    guard !displayIsSleeping else {
      setStatus(.paused, detail: "Display asleep; tap either arm or R1 to wake")
      return
    }
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
      self.restartDisplayIdleTimer()
      self.bootstrapTask = nil
    }
  }

  /// Builds a page-rebuild payload using this connection's current container name.
  private func textPayload(_ text: String, magic: Int) -> [UInt8] {
    T3EvenG2Protocol.rebuildText(text, magic: magic, name: pageName)
  }

  /// Writes current content only while the lenses are awake, including during dictation startup.
  @MainActor
  @discardableResult
  private func sendVisibleText(_ text: String) async -> Bool {
    guard !displayIsSleeping else { return false }
    return await sendEvenHub(textPayload(text, magic: nextMagic()))
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

  /// Keeps the input page alive but blanks the lenses after fifteen seconds without input.
  private func restartDisplayIdleTimer() {
    displayIdleTask?.cancel()
    displayIdleTask = nil
    guard status == .ready, !displayIsSleeping else { return }
    let wait = waitForDisplayIdle
    displayIdleTask = Task { @MainActor [weak self] in
      do {
        try await wait(.seconds(15))
      } catch { return }
      guard let self, !Task.isCancelled, self.status == .ready else { return }
      self.displayIsSleeping = true
      self.displayTask?.cancel()
      self.trace("display.sleep")
      // Shutting down the page loses input capture and triggers automatic recovery.
      // A blank page preserves tap delivery without showing incoming reply updates.
      let written = await self.sendEvenHub(self.textPayload("\n", magic: self.nextMagic()))
      guard !Task.isCancelled, self.displayIsSleeping else { return }
      if written {
        self.setStatus(.ready, detail: "Display asleep; tap either arm or R1 to wake")
      } else {
        self.displayIsSleeping = false
        if self.status == .paused {
          self.resumeDisplay()
        } else {
          self.pauseDisplay()
        }
      }
    }
  }

  /// Resets the idle deadline on input and consumes wake taps without running their actions.
  private func handleDisplayIdleInput(_ gesture: T3EvenG2Protocol.Gesture) -> Bool {
    if !displayIsSleeping {
      // Firmware can deliver the wake tap through more than one container or arm.
      if Date().timeIntervalSince(lastWakeAt) <= 0.4,
        ["click", "doubleClick", "scrollUp", "scrollDown"].contains(gesture.kind) { return true }
      if status == .ready, ["click", "scrollUp", "scrollDown"].contains(gesture.kind),
        gesture.isBack || T3EvenG2Protocol.isControlSource(gesture.source) {
        restartDisplayIdleTimer()
      }
      return false
    }
    guard gesture.kind == "click" else {
      return !["systemExit", "abnormalExit"].contains(gesture.kind)
    }
    guard gesture.isBack || T3EvenG2Protocol.isControlSource(gesture.source),
      left.ready, right.ready, [.ready, .paused, .error].contains(status) else { return true }
    displayIsSleeping = false
    lastWakeAt = Date()
    lastGestureAt = lastWakeAt
    trace("display.wake", ["source": gesture.source])
    if status == .ready {
      restartDisplayIdleTimer()
      if listening {
        scheduleListeningDisplay(latestTranscript)
      } else {
        scheduleDisplay(speechSession != nil || startingDictation ? "Preparing dictation…" : restingDisplayText)
      }
      setStatus(.ready, detail: "G2 and R1 ready")
    } else {
      bootstrap(resuming: true)
    }
    return true
  }

  /// Debounces a resting display update without waking an idle display.
  private func scheduleDisplay(_ text: String) {
    displayTask?.cancel()
    guard !displayIsSleeping else { return }
    let position: [String: Any] = [
      "displayReply": activeThreadKey.flatMap { historyByThread[$0]?.currentID } ?? "",
      "displayPage": activeThreadKey.flatMap { historyByThread[$0]?.pageIndex }.map { $0 + 1 } ?? 0,
      "displayPicker": threadPicker.isPresented,
    ]
    trace("display.scheduled", position)
    displayTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(300))
      guard let self, !Task.isCancelled, !self.listening, self.status == .ready else { return }
      let written = await self.sendVisibleText(text)
      self.trace("display.write-completed", position.merging(["written": written]) { _, new in new })
    }
  }

  /// Selects picker, empty-state, notice, paginated reply, or active-thread text.
  private var restingDisplayText: String {
    if threadPicker.isPresented { return threadPicker.text }
    if !inputEnabled {
      return "T3 Code\n\nOpen a thread to dictate"
    }
    if isWaitingForReply {
      let activity = threadActivityText.isEmpty ? "Sending to T3 Code…" : threadActivityText
      return "\(activity)\n\nSwipe up: replies\nL arm tap: threads"
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

  /// Separates post-send progress from errors and active speech capture.
  private var isWaitingForReply: Bool { dictationNotice == "Sending to T3 Code…" }

  /// Stores a notice and schedules it for display.
  private func showDictationNotice(_ text: String) {
    dictationNotice = text
    scheduleDisplay(restingDisplayText)
  }

  /// Debounces transcript display updates while listening remains active.
  private func scheduleListeningDisplay(_ transcript: String) {
    guard !displayIsSleeping else { return }
    let text = listeningDisplayText(transcript)
    displayTask?.cancel()
    displayTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(450))
      guard let self, !Task.isCancelled, self.listening, self.status == .ready else { return }
      await self.sendVisibleText(text)
    }
  }

  /// Shows the newest wrapped transcript rows at the bottom, retaining full speech for sending.
  private func listeningDisplayText(_ transcript: String = "") -> String {
    let heading = "Listening…\nTap R1: send"
    guard !transcript.isEmpty else { return heading }
    let maxBytes = 820 - heading.utf8.count - 2
    let lines = T3EvenG2Protocol.lensTextPages(transcript, maxBytes: maxBytes, includeFooter: false)
      .flatMap { $0.components(separatedBy: "\n") }
    var tail = Array(lines.suffix(6))
    while tail.count > 1, tail.joined(separator: "\n").utf8.count > maxBytes { tail.removeFirst() }
    let padding = Array(repeating: "", count: 6 - tail.count)
    return heading + "\n\n" + (padding + tail).joined(separator: "\n")
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
    if handleDisplayIdleInput(gesture) { return }
    // Handle exits before input gating and debounce: a double-tap can follow
    // a click immediately, or arrive while Settings is open.
    if T3EvenG2Protocol.requiresDisplayRecovery(for: gesture.kind) {
      if gesture.kind == "doubleClick", !listening, speechSession == nil {
        showThreadPicker()
      }
      pauseDisplay()
      return
    }
    if handleRecoveryInput(gesture) { return }
    guard status == .ready else {
      trace("gesture.ignored", ["reason": "not-ready", "kind": gesture.kind])
      return
    }
    guard ["click", "scrollUp", "scrollDown"].contains(gesture.kind) else { return }
    let now = Date()
    let cancelsDictation = gesture.isBack && (startingDictation || listening || speechSession != nil)
    guard now.timeIntervalSince(lastGestureAt) > 0.4 || cancelsDictation
      || (threadPicker.isPresented && gesture.kind == "click" && !gesture.isBack) else {
      trace("gesture.ignored", ["reason": "debounce", "kind": gesture.kind])
      return
    }
    lastGestureAt = now
    if handleBackGesture(gesture) { return }
    if threadPicker.isPresented {
      handlePickerGesture(gesture)
      return
    }
    handleThreadGesture(gesture)
  }

  /// Restarts display bootstrap for valid input received while paused or errored.
  private func handleRecoveryInput(_ gesture: T3EvenG2Protocol.Gesture) -> Bool {
    guard status == .paused || status == .error, left.ready, right.ready,
      gesture.kind == "click",
      gesture.isBack || T3EvenG2Protocol.isControlSource(gesture.source)
    else { return false }
    _ = handleBackGesture(gesture)
    bootstrap(resuming: true)
    return true
  }

  /// Scrolls displayed pages or schedules handling for a click gesture.
  private func handleThreadGesture(_ gesture: T3EvenG2Protocol.Gesture) {
    guard inputEnabled else {
      trace("gesture.ignored", ["reason": "input-disabled", "kind": gesture.kind])
      return
    }
    if T3EvenG2Protocol.lensPageOffset(for: gesture.kind) != nil {
      Task { @MainActor [weak self] in
        self?.scrollDisplay(gesture.kind)
      }
      return
    }
    guard gesture.kind == "click" else { return }
    guard gestureTask == nil else {
      trace("gesture.ignored", ["reason": "input-pending", "kind": gesture.kind])
      return
    }
    if gesture.source == "rightTemple" {
      guard !startingDictation, !listening, speechSession == nil else { return }
      showLatestOutput()
      return
    }
    inputAttempt += 1
    startingDictation = !listening && speechSession == nil && T3EvenG2Protocol.isDictationSource(gesture.source)
    trace("tap.accepted", ["kind": gesture.kind, "source": gesture.source])
    gestureTask = Task { @MainActor [weak self] in
      await self?.handleClick(gesture)
    }
  }

  /// Handles left-arm tap Back across dictation, picker, notice, and thread states.
  private func handleBackGesture(_ gesture: T3EvenG2Protocol.Gesture) -> Bool {
    guard gesture.isBack else { return false }
    cancelHistoryRequest()
    publishHistoryPosition()
    // Dictation is modal: Back cancels even when the underlying reply scrolls.
    if listening || speechSession != nil || (!threadPicker.isPresented && gestureTask != nil) {
      trace("dictation.cancelled", ["reason": "back"])
      startingDictation = false
      gestureTask?.cancel()
      gestureTask = nil
      dictationNotice = nil
      cancelSpeechAfterDisconnect(preserveDraft: false)
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
    if isWaitingForReply {
      showThreadPicker()
      return true
    }
    if dictationNotice != nil {
      dictationNotice = nil
      scheduleDisplay(restingDisplayText)
      return true
    }
    guard inputEnabled else { return true }
    showThreadPicker()
    return true
  }

  /// Moves the picker selection or emits the selected thread key on click.
  private func handlePickerGesture(_ gesture: T3EvenG2Protocol.Gesture) {
    guard T3EvenG2Protocol.isControlSource(gesture.source), threadPicker.openingKey == nil else { return }
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
        if historyByThread[choice.key] != nil {
          showLatestOutput()
          return
        }
      } else {
        threadPicker.openingKey = choice.key
      }
      scheduleDisplay(restingDisplayText)
      onThreadSelected?(["key": choice.key])
    }
  }

  /// Starts or finishes dictation directly; tap diagnostics must not replace the active input page.
  @MainActor
  private func handleClick(_ gesture: T3EvenG2Protocol.Gesture) async {
    defer {
      if !Task.isCancelled {
        gestureTask = nil
        startingDictation = false
      }
    }
    guard T3EvenG2Protocol.isDictationSource(gesture.source) else {
      trace("gesture.ignored", ["reason": "unsupported-source", "source": gesture.source])
      return
    }
    guard !Task.isCancelled, status == .ready, inputEnabled else { return }
    if listening {
      // Keep the double-tap cancellation window without replacing the listening page.
      try? await Task.sleep(for: .milliseconds(450))
      guard !Task.isCancelled, status == .ready, inputEnabled else { return }
      await finishDictation()
    } else {
      await beginDictation()
    }
  }

  /// Changes the visible reply page in the configured scroll direction.
  @MainActor
  private func scrollDisplay(_ gestureKind: String) {
    if status == .ready, !listening, speechSession == nil,
      gestureKind == "scrollUp", isWaitingForReply {
      dictationNotice = nil
      scheduleDisplay(restingDisplayText)
      return
    }
    guard
      status == .ready,
      !listening, speechSession == nil, dictationNotice == nil,
      let offset = T3EvenG2Protocol.lensPageOffset(for: gestureKind, naturalScrolling: naturalScrolling)
    else { return }
    openAtLatest = false
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
    // Install before finishing: a reply can arrive while the final transcript crosses the bridge.
    if !cancelled { dictationNotice = "Sending to T3 Code…" }
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
    trace("dictation.completed", ["cancelled": finalCancelled, "hasText": !latestTranscript.isEmpty])
    decoder = nil

    showStoppedDictation(cancelled: finalCancelled)
    if status != .error, !requestedDisconnect, left.ready, right.ready {
      setStatus(.ready, detail: "G2 and R1 ready")
    }
  }

  /// Reports cancellation or shows the final dictation result on the glasses.
  @MainActor
  private func showStoppedDictation(cancelled: Bool) {
    if cancelled {
      onTranscript?(["text": "", "isFinal": true, "cancelled": true])
      dictationNotice = nil
      scheduleDisplay(restingDisplayText)
    } else if latestTranscript.isEmpty {
      showDictationNotice("No speech recognized\n\nTap R1 to try again\nL arm tap: back")
    } else {
      scheduleDisplay(restingDisplayText)
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
    trace("status.changed")
    emitStatus()
  }

  /// Sends the current status snapshot to the registered observer.
  private func emitStatus() {
    onStatus?(snapshot)
  }

  /// Records input decisions without speech, reply text, device identifiers, or credentials.
  private func trace(_ event: String, _ fields: [String: Any] = [:]) {
    var state: [String: Any] = [
      "attempt": inputAttempt, "status": status.rawValue,
      "phase": stoppingDictation ? "stopping" : listening ? "listening"
        : speechSession != nil ? "preparing" : startingDictation ? "pending-start" : "idle",
      "inputEnabled": inputEnabled, "picker": threadPicker.isPresented,
      "sinceInputMs": min(60_000, Int(max(0, Date().timeIntervalSince(lastGestureAt) * 1_000))),
    ]
    if let activeThreadKey { state["thread"] = activeThreadKey }
    if let history = activeThreadKey.flatMap({ historyByThread[$0] }) {
      state["reply"] = history.currentID
      state["page"] = history.pageIndex + 1
    }
    state.merge(fields) { _, new in new }
    diagnostics.record(event, fields: state)
  }

  /// Cancels scheduled connection, display, gesture, heartbeat, recovery, and ACK work.
  private func stopTasks() {
    cancelHistoryRequest()
    publishHistoryPosition()
    connectionTimedOut = false
    shutdownExitObserved = false
    reconnectTask?.cancel()
    reconnectTask = nil
    recoveryTask?.cancel()
    recoveryTask = nil
    gestureTask?.cancel()
    gestureTask = nil
    startingDictation = false
    pauseTask?.cancel()
    pauseTask = nil
    heartbeatTask?.cancel()
    heartbeatTask = nil
    displayTask?.cancel()
    displayTask = nil
    displayIdleTask?.cancel()
    displayIdleTask = nil
    bootstrapTask?.cancel()
    bootstrapTask = nil
    scanTimeoutTask?.cancel()
    scanTimeoutTask = nil
    pendingAckKeys.removeAll()
    receivedAckKeys.removeAll()
  }

  /// Stops recognition, keeping interrupted speech as a draft unless Back explicitly discards it.
  private func cancelSpeechAfterDisconnect(preserveDraft: Bool = true) {
    guard listening || speechSession != nil else { return }
    trace("dictation.session-cleared", ["preserved": preserveDraft, "hasText": !latestTranscript.isEmpty])
    listening = false
    stoppingDictation = false
    let speech = speechSession as? T3EvenG2SpeechTranscriber
    speechSession = nil
    decoder = nil
    onTranscript?(["text": preserveDraft ? latestTranscript : "", "isFinal": true,
                   "cancelled": true, "interrupted": preserveDraft])
    Task { @MainActor in await speech?.cancel() }
  }
}

/// Keeps the current and previous JSONL segment locally, independent of Metro or a console attachment.
/// Formatter access is locked; directoryPrepared is accessed only on the write queue.
final class T3EvenG2Diagnostics: @unchecked Sendable {
  let directory: URL
  private let maxBytes: Int
  private let queue = DispatchQueue(label: "com.t3code.even-g2.diagnostics", qos: .utility)
  private let run = UUID().uuidString
  private let formatterLock = NSLock()
  private let formatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
  private var directoryPrepared = false

  /// Allows fixtures to use temporary storage and a smaller rotation limit.
  init(directory: URL? = nil, maxBytes: Int = 512 * 1_024) {
    self.directory = directory ?? (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory).appendingPathComponent("EvenG2Diagnostics", isDirectory: true)
    self.maxBytes = maxBytes
  }

  /// Captures event time at the call site; serial disk writes never block Bluetooth callbacks.
  func record(_ event: String, fields: [String: Any] = [:]) {
    var entry = fields
    entry["schema"] = 1
    entry["run"] = run
    entry["event"] = event
    let time = Date()
    entry["time"] = formatterLock.withLock { formatter.string(from: time) }
    entry["uptimeMs"] = ProcessInfo.processInfo.systemUptime * 1_000
    entry["version"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "test"
    guard var data = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) else { return }
    data.append(0x0A)
    let line = data
    queue.async { [self] in
      do {
        let files = FileManager.default
        if !directoryPrepared {
          try files.createDirectory(at: directory, withIntermediateDirectories: true)
          var localDirectory = directory
          var values = URLResourceValues()
          values.isExcludedFromBackup = true
          try localDirectory.setResourceValues(values)
          directoryPrepared = true
        }
        let current = directory.appendingPathComponent("current.jsonl")
        let previous = directory.appendingPathComponent("previous.jsonl")
        let size = (try? files.attributesOfItem(atPath: current.path)[.size] as? Int) ?? 0
        if size > 0, size + line.count > maxBytes {
          if files.fileExists(atPath: previous.path) { try files.removeItem(at: previous) }
          try files.moveItem(at: current, to: previous)
        }
        if !files.fileExists(atPath: current.path) { files.createFile(atPath: current.path, contents: nil) }
        let file = try FileHandle(forWritingTo: current)
        defer { try? file.close() }
        try file.seekToEnd()
        try file.write(contentsOf: line)
      } catch {
        NSLog("[even-g2-diagnostics] Could not persist event: %@", error.localizedDescription)
      }
    }
  }

  /// Waits for queued records when a test or export needs a complete snapshot.
  func flush() { queue.sync {} }
}
