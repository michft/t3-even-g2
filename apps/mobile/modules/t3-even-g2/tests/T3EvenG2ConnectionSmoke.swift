import CoreBluetooth
import Foundation

@MainActor
final class T3EvenG2SpeechTranscriber {
  static weak var current: T3EvenG2SpeechTranscriber?
  static var finalText = "test dictation"
  static var startCount = 0
  static var beforeFinish: (() async -> Void)?
  private var update: ((String, Bool) -> Void)?
  /// Captures the transcript callback and records recognition starts.
  func start(onUpdate: @escaping (String, Bool) -> Void) async throws {
    Self.current = self
    Self.startCount += 1
    update = onUpdate
  }
  /// Emits recognized words through the same callback as the device recognizer.
  func publish(_ text: String) { update?(text, false) }
  /// Accepts audio without decoding it in the speech fixture.
  func appendPCM(_ pcm: Data) throws {}
  /// Waits for the optional test gate, then publishes the configured final transcript.
  func finish() async throws -> String {
    await Self.beforeFinish?()
    update?(Self.finalText, true)
    return Self.finalText
  }
  /// Detaches transcript delivery for a cancelled fixture session.
  func cancel() async { update = nil }
}
final class T3EvenG2LC3Decoder {
  /// Returns empty PCM because these checks exercise connection state, not codec output.
  func decodePacket(_ packet: Data) throws -> Data { Data() }
}

@MainActor
final class Fixture {
  static var waitingAtLine = 0
  let connection: T3EvenG2Connection
  let diagnostics = T3EvenG2Diagnostics(
    directory: FileManager.default.temporaryDirectory.appendingPathComponent("g2-test-\(UUID().uuidString)"))
  let left = CBPeripheral("G2_TEST_L_ARM")
  let right = CBPeripheral("G2_TEST_R_ARM")
  var transcripts: [[String: Any]] = []
  var selectedKeys: [String] = []
  var historyRequests: [[String: Any]] = []
  var historyWaiter: (() -> Void)?
  var waiter: (([String: Any]) -> Void)?
  var pageOccupied = true
  var sessionLaunched = false
  var shutdownPending = false
  var shutdownCount = 0
  var preludeCount = 0
  var createCount = 0
  var rejectPageCreation = false
  var authenticationCounts: [String: Int] = [:]
  var baseHeartbeatCounts: [String: Int] = [:]
  var baseHeartbeatStates: Set<String> = []
  var baseHeartbeatWaiter: (() -> Void)?
  var baseHeartbeatTaskStarts = 0
  var baseHeartbeatTaskEnds = 0
  var baseHeartbeatTaskWaiter: (() -> Void)?
  var pageHeartbeatResponses: [Bool] = []
  var pageHeartbeatAttempts = 0
  var pageHeartbeatAcks = 0
  var pageHeartbeatWaiter: (() -> Void)?
  var displayFrame: [UInt8] = []
  var lastDisplayPayload = Data()
  var displayPayloads: [Data] = []
  var displayWaiter: (() -> Void)?

  /// Connects simulated arms and scripts firmware acknowledgements with configurable heartbeat timing.
  init(
    connectionTimeout: Duration = .seconds(20),
    baseHeartbeatInterval: Duration = .milliseconds(20),
    pageHeartbeatInterval: Duration = .seconds(30),
    pageHeartbeatTimeout: Duration = .seconds(20),
    rememberedLeft: CBPeripheral? = nil
  ) {
    connection = T3EvenG2Connection(
      connectionTimeout: connectionTimeout,
      baseHeartbeatInterval: baseHeartbeatInterval,
      pageHeartbeatInterval: pageHeartbeatInterval,
      pageHeartbeatTimeout: pageHeartbeatTimeout,
      diagnostics: diagnostics
    )
    connection.onBaseHeartbeatTaskStart = { [weak self] in self?.baseHeartbeatTaskStarts += 1 }
    connection.onBaseHeartbeatTaskEnd = { [weak self] in
      guard let self else { return }
      self.baseHeartbeatTaskEnds += 1
      self.baseHeartbeatTaskWaiter?()
    }
    connection.setNaturalScrolling(false)
    connection.onStatus = { [weak self] state in self?.waiter?(state) }
    connection.onTranscript = { [weak self] event in self?.transcripts.append(event) }
    connection.onThreadSelected = { [weak self] event in
      if let key = event["key"] as? String { self?.selectedKeys.append(key) }
    }
    connection.onHistoryRequest = { [weak self] event in
      self?.historyRequests.append(event)
      self?.historyWaiter?()
    }
    connection.connect()
    if let rememberedLeft {
      CBCentralManager.latest.retrievable = [rememberedLeft, right]
      UserDefaults.standard.set(rememberedLeft.identifier.uuidString, forKey: "T3EvenG2ArmL")
      UserDefaults.standard.set(right.identifier.uuidString, forKey: "T3EvenG2ArmR")
    }
    connection.centralManagerDidUpdateState(CBCentralManager.latest)
    precondition(CBCentralManager.latest.isScanning)
    for peripheral in [left, right] {
      connection.centralManager(
        CBCentralManager.latest, didDiscover: peripheral, advertisementData: [:], rssi: -40)
      peripheral.onWrite = { [weak self, weak peripheral] frame in
        guard let self, let peripheral else { return }
        let bytes = Array(frame)
        if bytes.count > 9, bytes[6] == 0xE0 {
          if bytes[5] == 1 {
            self.displayFrame = bytes[8] == 8 && bytes[9] == 7 ? Array(bytes.dropFirst(8)) : []
          } else if !self.displayFrame.isEmpty {
            self.displayFrame += bytes.dropFirst(8)
          }
          if bytes[4] == bytes[5], !self.displayFrame.isEmpty {
            self.lastDisplayPayload = Data(self.displayFrame)
            self.displayPayloads.append(self.lastDisplayPayload)
            self.displayFrame = []
            self.displayWaiter?()
          }
        }
        if bytes.count >= 14, bytes[6] == 0x80 {
          precondition(bytes[7] == 0 && bytes[8] == 8)
          let side = peripheral === self.left ? "L" : "R"
          if bytes[9] == 4 {
            self.authenticationCounts[side, default: 0] += 1
            // Neither explicit false nor an empty AuthMgr should block startup
            // or trigger repeated authentication on a working BLE connection.
            var magicEnd = 11
            while bytes[magicEnd] & 0x80 != 0 { magicEnd += 1 }
            let auth: [UInt8] = side == "L" ? [0x1A, 2, 0x08, 0] : [0x1A, 0]
            let payload = Array(bytes[8...magicEnd]) + auth
            var reply = T3EvenG2Protocol.frames(
              payload: payload, sequence: bytes[2], service: 0x80, flag: 0)[0]
            reply[1] = 0x12
            let notify = peripheral.services![0].characteristics![1]
            notify.value = reply
            self.connection.peripheral(peripheral, didUpdateValueFor: notify, error: nil)
            return
          }
          precondition(bytes[9] == 14 && self.authenticationCounts[side, default: 0] > 0)
          self.baseHeartbeatCounts[side, default: 0] += 1
          self.baseHeartbeatStates.insert(self.connection.snapshot["status"] as? String ?? "")
          self.baseHeartbeatWaiter?()
          return
        }
        // Transport ACK echoes the command's magic, including the fixed prelude.
        guard bytes.count > 12, bytes[4] == 1, let offset = bytes[8...].firstIndex(of: 0x10) else {
          return
        }
        let pageHeartbeat = bytes[6] == 0xE0 && bytes[9] == 12
        if pageHeartbeat {
          self.pageHeartbeatAttempts += 1
          self.pageHeartbeatWaiter?()
          if !self.pageHeartbeatResponses.isEmpty, !self.pageHeartbeatResponses.removeFirst() {
            return
          }
        }
        if bytes[6] == 0x01 {
          guard !self.shutdownPending else { return }
          self.preludeCount += 1
          self.sessionLaunched = true
        } else if bytes[6] == 0xE0 {
          let command = bytes[8] == 0x08 ? bytes[9] : 0
          guard self.sessionLaunched else { return }
          if command == 9 {
            self.shutdownCount += 1
            self.sessionLaunched = false
            self.shutdownPending = self.pageOccupied
            if self.shutdownPending {
              // Firmware ACKs immediately but tears down the old page later.
              Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(100))
                guard let self else { return }
                self.pageOccupied = false
                self.shutdownPending = false
                self.gesture(7)
              }
            }
          } else if command == 0 {
            // Model the physical failure: an old page silently rejects CREATE.
            guard !self.pageOccupied, !self.rejectPageCreation else { return }
            self.createCount += 1
            self.pageOccupied = true
          }
        }
        var end = offset + 1
        while end < bytes.count - 2 && bytes[end] & 0x80 != 0 { end += 1 }
        let payload = [UInt8(0x10)] + Array(bytes[(offset + 1)...end])
        let notify = peripheral.services![0].characteristics![1]
        notify.value = Data(
          [0xAA, 0x12, 0, UInt8(payload.count + 2), 1, 1, bytes[6], 0x20] + payload + [0, 0])
        self.connection.peripheral(peripheral, didUpdateValueFor: notify, error: nil)
        if pageHeartbeat {
          self.pageHeartbeatAcks += 1
          self.pageHeartbeatWaiter?()
        }
      }
      discover(peripheral)
    }
  }

  deinit {
    diagnostics.flush()
    try? FileManager.default.removeItem(at: diagnostics.directory)
  }

  /// Completes connection and characteristic discovery for one simulated arm.
  func discover(_ peripheral: CBPeripheral) {
    peripheral.state = .connected
    connection.centralManager(CBCentralManager.latest, didConnect: peripheral)
    let service = CBService([
      CBCharacteristic(T3EvenG2Protocol.writeUUID),
      CBCharacteristic(T3EvenG2Protocol.notifyUUID),
      CBCharacteristic(T3EvenG2Protocol.renderNotifyUUID),
    ])
    peripheral.services = [service]
    connection.peripheral(peripheral, didDiscoverServices: nil)
    connection.peripheral(peripheral, didDiscoverCharacteristicsFor: service, error: nil)
  }

  /// Confirms notification subscriptions so the driver can mark an arm ready.
  func subscribe(_ peripheral: CBPeripheral) {
    for characteristic in peripheral.services![0].characteristics!.dropFirst() {
      characteristic.isNotifying = true
      connection.peripheral(peripheral, didUpdateNotificationStateFor: characteristic, error: nil)
    }
  }

  /// Delivers a firmware gesture through the real notification parser.
  func gesture(_ event: UInt8, container: Bool = false) {
    let inner: [UInt8] = container ? [0x12, 2, 0x18, event] : [0x1A, 4, 0x08, event, 0x10, 2]
    let payload: [UInt8] = [0x08, 2, 0x6A, UInt8(inner.count)] + inner
    let notify = right.services![0].characteristics![1]
    notify.value = Data(
      [0xAA, 0x21, 0, UInt8(payload.count + 2), 1, 1, 0xE0, 1] + payload + [0, 0])
    connection.peripheral(right, didUpdateValueFor: notify, error: nil)
  }

  /// Waits for a matching status callback, recording the caller for watchdog diagnostics.
  func wait(line: Int = #line, _ predicate: @escaping ([String: Any]) -> Bool) async {
    if predicate(connection.snapshot) { return }
    Self.waitingAtLine = line
    await withCheckedContinuation { continuation in
      waiter = { [weak self] state in
        if predicate(state) {
          self?.waiter = nil
          continuation.resume()
        }
      }
    }
  }

  /// Delivers the firmware Back gesture.
  func holdBack() { gesture(9) }

  /// Waits for the next completed lens frame after a transcript update.
  func waitForNextDisplay(after count: Int, line: Int = #line) async {
    if displayPayloads.count > count { return }
    Self.waitingAtLine = line
    await withCheckedContinuation { continuation in
      displayWaiter = { [weak self] in
        guard let self, self.displayPayloads.count > count else { return }
        self.displayWaiter = nil
        continuation.resume()
      }
    }
  }

  /// Waits until a completed text frame contains the expected visible text.
  func waitForDisplay(_ text: String, line: Int = #line) async {
    let expected = Data(text.utf8)
    if lastDisplayPayload.range(of: expected) != nil { return }
    Self.waitingAtLine = line
    await withCheckedContinuation { continuation in
      displayWaiter = { [weak self] in
        guard let self, self.lastDisplayPayload.range(of: expected) != nil else { return }
        self.displayWaiter = nil
        continuation.resume()
      }
    }
  }

  /// Waits for an arm heartbeat write that satisfies the supplied condition.
  func waitForBaseHeartbeat(_ predicate: @escaping () -> Bool) async {
    if predicate() { return }
    await withCheckedContinuation { continuation in
      baseHeartbeatWaiter = { [weak self] in
        if predicate() {
          self?.baseHeartbeatWaiter = nil
          continuation.resume()
        }
      }
    }
  }

  /// Waits for the requested number of heartbeat tasks to finish cleanup.
  func waitForBaseHeartbeatTaskEnd(_ count: Int) async {
    if baseHeartbeatTaskEnds >= count { return }
    await withCheckedContinuation { continuation in
      baseHeartbeatTaskWaiter = { [weak self] in
        guard let self, self.baseHeartbeatTaskEnds >= count else { return }
        self.baseHeartbeatTaskWaiter = nil
        continuation.resume()
      }
    }
  }

  /// Waits for a scripted page heartbeat attempt or acknowledgement.
  func waitForPageHeartbeat(_ predicate: @escaping () -> Bool) async {
    if predicate() { return }
    await withCheckedContinuation { continuation in
      pageHeartbeatWaiter = { [weak self] in
        if predicate() {
          self?.pageHeartbeatWaiter = nil
          continuation.resume()
        }
      }
    }
  }

  /// Waits for a boundary gesture to request another history window.
  func waitForHistoryRequest(_ count: Int) async {
    if historyRequests.count >= count { return }
    await withCheckedContinuation { continuation in
      historyWaiter = { [weak self] in
        guard let self, self.historyRequests.count >= count else { return }
        self.historyWaiter = nil
        continuation.resume()
      }
    }
  }
}

@main
struct Smoke {
  /// Exercises real connection, recovery, dictation, and navigation behavior with simulated firmware.
  @MainActor
  static func main() async throws {
    let savedScrolling = UserDefaults.standard.object(forKey: "T3EvenG2NaturalScrolling")
    defer { UserDefaults.standard.set(savedScrolling, forKey: "T3EvenG2NaturalScrolling") }
    let watchdog = Task {
      // Covers the full suite's deliberate gesture debounce and firmware deadlines.
      try? await Task.sleep(for: .seconds(40))
      guard !Task.isCancelled else { return }
      fatalError("G2 connection test timed out waiting for a lifecycle callback at line \(Fixture.waitingAtLine)")
    }
    defer { watchdog.cancel() }
    if CommandLine.arguments.contains("--listening") {
      await verifyListeningTranscript()
      print("G2 transcript tail, swipe isolation, full send, and interruption checks passed")
      return
    }
    if CommandLine.arguments.contains("--heartbeats") {
      await verifyHeartbeats()
      print("G2 heartbeat restart, stale-task cleanup, and consecutive ACK checks passed")
      return
    }
    if CommandLine.arguments.contains("--history") {
      await verifyReplyHistory()
      await verifyOpenAtLatest()
      print("G2 history paging, modal return, Latest shortcut, and stale-window checks passed")
      return
    }
    if CommandLine.arguments.contains("--startup-input") {
      try await verifyStartupSwipeBack()
      print("G2 startup swipes and explicit Back checks passed")
      return
    }
    if CommandLine.arguments.contains("--diagnostics") {
      try verifyDiagnostics()
      print("G2 diagnostic persistence, rotation, and restart checks passed")
      return
    }
    var picker = T3EvenG2ThreadPicker()
    let first = T3EvenG2ThreadPicker.Choice(key: "mini:a", title: "First", subtitle: "Mini")
    let second = T3EvenG2ThreadPicker.Choice(key: "moorbeef:a", title: "Second", subtitle: "Moorbeef")
    picker.update([first, second])
    picker.move(1)
    picker.update([second, first])
    precondition(picker.highlighted?.key == second.key)
    picker.update([first])
    precondition(picker.highlighted?.key == first.key)
    picker.move(-1)
    precondition(picker.index == 0)
    picker.update([])
    precondition(picker.highlighted == nil && picker.text.contains("No threads"))
    // Test process gets a separate preferences domain; no real pairing state.
    let staleLeft = CBPeripheral("G2_OLD_L_ARM")
    let recovering = Fixture(connectionTimeout: .milliseconds(20), rememberedLeft: staleLeft)
    guard let recoveringCentral = CBCentralManager.latest else { fatalError("Missing recovery central") }
    precondition(recoveringCentral.connections.contains { $0 === staleLeft })
    precondition(recoveringCentral.cancelled.count == 1 && recoveringCentral.cancelled[0] === staleLeft)
    precondition(recoveringCentral.isScanning)
    recovering.connection.centralManager(
      recoveringCentral, didDisconnectPeripheral: staleLeft, error: nil)
    recovering.subscribe(recovering.left)
    precondition(recovering.authenticationCounts["L"] == 1)
    precondition(recovering.baseHeartbeatCounts["L"] == nil)
    precondition(recovering.baseHeartbeatCounts["R"] == nil)
    let competingLeft = CBPeripheral("G2_OTHER_L_ARM")
    recovering.connection.centralManager(
      recoveringCentral, didDiscover: competingLeft, advertisementData: [:], rssi: -40)
    precondition(!recoveringCentral.connections.contains { $0 === competingLeft })
    await recovering.wait { $0["status"] as? String == "error" }
    precondition((recovering.connection.snapshot["detail"] as? String)?.contains("G2 right arm not ready") == true)
    precondition(!recoveringCentral.isScanning && recoveringCentral.cancelled.count == 1)
    await recovering.waitForBaseHeartbeat { recovering.baseHeartbeatStates.contains("error") }
    recovering.subscribe(recovering.right)
    precondition(recovering.authenticationCounts["R"] == 1)
    recovering.subscribe(recovering.right)
    precondition(recovering.authenticationCounts["R"] == 1)
    await recovering.wait { $0["status"] as? String == "ready" }
    precondition(recovering.authenticationCounts == ["L": 1, "R": 1],
                 "false/empty auth replies must allow readiness without resending authentication")
    precondition(recovering.shutdownCount == 1 && recovering.preludeCount == 2 && recovering.createCount == 1)
    // Reconnect gets its own deadline and leaves the healthy arm subscribed.
    recovering.right.state = .disconnected
    recovering.connection.centralManager(
      recoveringCentral, didDisconnectPeripheral: recovering.right, error: nil)
    precondition(recoveringCentral.isScanning)
    await recovering.wait { $0["status"] as? String == "error" }
    precondition(recovering.left.services?.first?.characteristics?.dropFirst().first?.isNotifying == true)
    precondition(recoveringCentral.cancelled.count == 1 && recovering.right.state == .connecting)
    let healthyCount = recovering.baseHeartbeatCounts["L", default: 0]
    let disconnectedCount = recovering.baseHeartbeatCounts["R", default: 0]
    await recovering.waitForBaseHeartbeat {
      recovering.baseHeartbeatCounts["L", default: 0] > healthyCount
    }
    precondition(recovering.baseHeartbeatCounts["R", default: 0] == disconnectedCount)
    let previousRightWrites = recovering.right.writes.count
    recovering.discover(recovering.right)
    recovering.subscribe(recovering.right)
    await recovering.wait { $0["status"] as? String == "ready" }
    precondition(recovering.authenticationCounts == ["L": 1, "R": 2])
    let reconnectFirstWrite = Array(recovering.right.writes[previousRightWrites])
    precondition(reconnectFirstWrite[6] == 0x80 && reconnectFirstWrite[9] == 4)
    recovering.connection.disconnect()
    let disconnectedCounts = recovering.baseHeartbeatCounts
    let disconnectedAuthCounts = recovering.authenticationCounts

    let cancelled = Fixture(connectionTimeout: .milliseconds(20))
    guard let cancelledCentral = CBCentralManager.latest else { fatalError("Missing cancellation central") }
    await cancelled.wait { $0["status"] as? String == "error" }
    cancelled.connection.connect()
    precondition(cancelledCentral.isScanning)
    cancelled.connection.disconnect()
    // Late Bluetooth callbacks cannot restart a manually disconnected session.
    cancelled.connection.centralManager(
      cancelledCentral, didDiscover: cancelled.left, advertisementData: [:], rssi: -40)
    cancelled.discover(cancelled.left)
    cancelled.subscribe(cancelled.left)
    cancelled.discover(cancelled.right)
    cancelled.subscribe(cancelled.right)
    precondition(cancelled.connection.snapshot["status"] as? String == "disconnected")
    precondition(cancelled.authenticationCounts.isEmpty)
    precondition(!cancelledCentral.isScanning)

    let fixture = Fixture()
    // A cold session has no page to tear down and therefore emits no exit.
    fixture.pageOccupied = false
    fixture.connection.setThreadChoices([
      ["key": "mini:a", "title": "First thread", "subtitle": "Mini"],
      ["key": "moorbeef:b", "title": "Second thread", "subtitle": "Moorbeef"],
    ])
    precondition(fixture.connection.snapshot["status"] as? String != "starting")
    fixture.subscribe(fixture.left)
    precondition(fixture.connection.snapshot["status"] as? String != "starting")
    fixture.subscribe(fixture.right)
    await fixture.wait { $0["status"] as? String == "ready" }
    precondition(recovering.baseHeartbeatCounts == disconnectedCounts)
    precondition(recovering.authenticationCounts == disconnectedAuthCounts)
    precondition(fixture.baseHeartbeatStates.contains("starting"))
    precondition(cancelled.connection.snapshot["status"] as? String == "disconnected")
    precondition(fixture.shutdownCount == 1 && fixture.preludeCount == 2 && fixture.createCount == 1)

    fixture.gesture(2, container: true)
    // Simulate deliberate, separate gestures outside the hardware debounce.
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(0, container: true)
    precondition(fixture.selectedKeys == ["moorbeef:b"])
    precondition(fixture.connection.snapshot["listening"] as? Bool == false)
    fixture.connection.setActiveThread("moorbeef:b", enabled: true)
    fixture.connection.setActiveThread("mini:a", enabled: false)
    let longReply = (1...25).map { "Reply line \($0)" }.joined(separator: "\n")
    fixture.connection.displayText(longReply)
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(0, container: true)
    await fixture.wait { $0["listening"] as? Bool == true }
    let createsBeforeCancel = fixture.createCount
    fixture.gesture(1)
    precondition(fixture.connection.snapshot["listening"] as? Bool == true)
    fixture.gesture(9) // Explicit Back cancels without waiting for debounce.
    precondition(fixture.connection.snapshot["listening"] as? Bool == false)
    precondition(fixture.connection.snapshot["status"] as? String == "ready")
    precondition(fixture.createCount == createsBeforeCancel)
    precondition(fixture.transcripts.count == 1 && fixture.transcripts[0]["cancelled"] as? Bool == true)
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(0)
    await fixture.wait { $0["listening"] as? Bool == true }
    // Firmware exits must still stop recording safely, while dictating.
    fixture.gesture(3)
    precondition(fixture.connection.snapshot["status"] as? String == "paused")
    await fixture.waitForBaseHeartbeat { fixture.baseHeartbeatStates.contains("paused") }
    precondition(
      fixture.transcripts.count == 2 && fixture.transcripts[1]["cancelled"] as? Bool == true)
    await fixture.wait { $0["status"] as? String == "ready" }
    precondition(fixture.connection.snapshot["listening"] as? Bool == false)
    fixture.gesture(0)
    await fixture.wait { $0["listening"] as? Bool == true }
    // Let the gesture task finish before explicitly ending this second session.
    await Task.yield()
    await fixture.connection.finishDictation()
    precondition(fixture.transcripts.count == 3)
    precondition(fixture.transcripts[2]["text"] as? String == "test dictation")
    fixture.gesture(3)
    await fixture.wait { $0["status"] as? String == "ready" }
    fixture.gesture(0)
    precondition(fixture.selectedKeys == ["moorbeef:b", "moorbeef:b"])
    precondition(fixture.connection.snapshot["listening"] as? Bool == false)
    // Swiping a short reply stays there; holding goes Back. The picker still scrolls.
    fixture.connection.displayText("Short reply")
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(9)
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(0)
    precondition(fixture.selectedKeys.last == "mini:a" && fixture.selectedKeys.count == 3)
    fixture.connection.setActiveThread("mini:a", enabled: true)
    fixture.connection.displayText(longReply)
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(2)
    await fixture.wait { ($0["detail"] as? String)?.hasPrefix("G2 page 2 of") == true }
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    await fixture.wait { ($0["detail"] as? String)?.hasPrefix("G2 page 1 of") == true }
    // At the first page, another up must stay in the thread rather than go Back.
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(0)
    await fixture.wait { $0["listening"] as? Bool == true }
    precondition(fixture.selectedKeys.count == 3)
    fixture.gesture(9)
    precondition(fixture.transcripts.count == 4 && fixture.transcripts[3]["cancelled"] as? Bool == true)
    fixture.connection.setNaturalScrolling(true)
    precondition(T3EvenG2Connection(diagnostics: fixture.diagnostics).snapshot["naturalScrolling"] as? Bool == true)
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    await fixture.wait { ($0["detail"] as? String)?.hasPrefix("G2 page 2 of") == true }
    try? await Task.sleep(for: .milliseconds(450))
    fixture.holdBack()
    fixture.gesture(10) // Release must not act as another Back or a tap.
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1) // Natural scrolling moves the picker to the second thread.
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(0)
    precondition(fixture.selectedKeys.last == "moorbeef:b" && fixture.selectedKeys.count == 4)
    fixture.connection.setActiveThread("moorbeef:b", enabled: true)
    fixture.connection.showThreadPicker()
    try? await Task.sleep(for: .milliseconds(450))
    fixture.holdBack() // Back from a scrollable picker restores the active thread.
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(0)
    await fixture.wait { $0["listening"] as? Bool == true }
    fixture.gesture(1)
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(9) // Explicit Back is independent of scrolling direction.
    precondition(fixture.transcripts.count == 5 && fixture.transcripts[4]["cancelled"] as? Bool == true)
    // Dictation errors are one level above the same reply and reading position.
    try? await Task.sleep(for: .milliseconds(450))
    fixture.connection.displayText(longReply)
    fixture.gesture(1)
    await fixture.wait { ($0["detail"] as? String)?.hasPrefix("G2 page 2 of") == true }
    let secondPage = T3EvenG2Protocol.lensTextPages(longReply)[1]
    await fixture.waitForDisplay(secondPage)
    T3EvenG2SpeechTranscriber.finalText = ""
    await fixture.connection.beginDictation()
    await fixture.connection.finishDictation()
    await fixture.waitForDisplay("No speech recognized")
    T3EvenG2SpeechTranscriber.finalText = "test dictation"
    fixture.holdBack()
    fixture.gesture(10)
    await fixture.waitForDisplay(secondPage)
    precondition(fixture.selectedKeys.count == 4)
    // A second Back goes to selection; Back there returns to the same output.
    try? await Task.sleep(for: .milliseconds(450))
    fixture.holdBack()
    await fixture.waitForDisplay("T3 threads")
    try? await Task.sleep(for: .milliseconds(450))
    fixture.holdBack()
    await fixture.waitForDisplay(secondPage)
    precondition(fixture.connection.snapshot["listening"] as? Bool == false)
    // Back must invalidate a direct start before its first display write finishes.
    try? await Task.sleep(for: .milliseconds(450))
    fixture.right.canSendWriteWithoutResponse = false
    let startsBeforeBack = T3EvenG2SpeechTranscriber.startCount
    let preparing = Task { await fixture.connection.beginDictation() }
    await fixture.wait { $0["detail"] as? String == "Preparing on-device speech" }
    fixture.holdBack()
    fixture.right.canSendWriteWithoutResponse = true
    await preparing.value
    precondition(T3EvenG2SpeechTranscriber.startCount == startsBeforeBack)
    precondition(fixture.connection.snapshot["listening"] as? Bool == false)
    // A cancelled finish may return late. It must neither block nor reset a new session.
    try? await Task.sleep(for: .milliseconds(450))
    await fixture.connection.beginDictation()
    var releaseFinish: CheckedContinuation<Void, Never>?
    var oldFinish: Task<Void, Never>?
    await withCheckedContinuation { entered in
      T3EvenG2SpeechTranscriber.beforeFinish = {
        await withCheckedContinuation { continuation in
          releaseFinish = continuation
          entered.resume()
        }
      }
      oldFinish = Task { await fixture.connection.finishDictation() }
    }
    fixture.holdBack()
    T3EvenG2SpeechTranscriber.beforeFinish = nil
    await fixture.connection.beginDictation()
    precondition(fixture.connection.snapshot["listening"] as? Bool == true)
    releaseFinish?.resume()
    await oldFinish?.value
    precondition(fixture.connection.snapshot["listening"] as? Bool == true)
    await fixture.connection.cancelDictation()
    fixture.right.state = .disconnected
    fixture.connection.centralManager(
      CBCentralManager.latest, didDisconnectPeripheral: fixture.right, error: nil)
    precondition(fixture.connection.snapshot["status"] as? String == "connecting")
    fixture.discover(fixture.right)
    fixture.subscribe(fixture.right)
    await fixture.wait { $0["status"] as? String == "ready" }
    fixture.rejectPageCreation = true
    fixture.gesture(7)
    await fixture.wait { $0["detail"] as? String == "G2 page creation timed out. Tap to retry." }
    let failedPageCounts = fixture.baseHeartbeatCounts
    await fixture.waitForBaseHeartbeat {
      fixture.baseHeartbeatCounts["L", default: 0] > failedPageCounts["L", default: 0]
        && fixture.baseHeartbeatCounts["R", default: 0] > failedPageCounts["R", default: 0]
    }
    fixture.rejectPageCreation = false
    fixture.holdBack()
    await fixture.wait { $0["status"] as? String == "ready" }
    // The base connection timer also ends when Bluetooth powers off.
    let poweredOffCounts = fixture.baseHeartbeatCounts
    CBCentralManager.latest.state = .poweredOff
    fixture.connection.centralManagerDidUpdateState(CBCentralManager.latest)
    let clockFixture = Fixture(connectionTimeout: .milliseconds(20))
    clockFixture.left.canSendWriteWithoutResponse = false
    clockFixture.subscribe(clockFixture.left)
    await clockFixture.wait { $0["status"] as? String == "error" }
    precondition(clockFixture.authenticationCounts.isEmpty)
    precondition(clockFixture.baseHeartbeatCounts.isEmpty)
    clockFixture.left.canSendWriteWithoutResponse = true
    await clockFixture.waitForBaseHeartbeat {
      clockFixture.baseHeartbeatCounts["L", default: 0] >= 3
    }
    precondition(clockFixture.authenticationCounts == ["L": 1])
    precondition(fixture.baseHeartbeatCounts == poweredOffCounts)
    clockFixture.connection.disconnect()
    fixture.connection.disconnect()
    precondition(fixture.connection.snapshot["status"] as? String == "disconnected")
    print(
      "G2 native driver: per-arm auth, base heartbeats, occupied-page reset, readiness deadlines, stale arm replacement, late recovery, cancellation, thread picker, dictation, and reconnect passed"
    )
  }

  /// Keeps the latest recognized rows visible without truncating the submitted transcript.
  @MainActor
  private static func verifyListeningTranscript() async {
    let fixture = Fixture()
    fixture.pageOccupied = false
    fixture.subscribe(fixture.left)
    fixture.subscribe(fixture.right)
    await fixture.wait { $0["status"] as? String == "ready" }
    fixture.connection.setActiveThread("mini:transcript", enabled: true)
    await fixture.connection.beginDictation()
    let rows = (1...30).map { "Recognized row \($0)" }.joined(separator: "\n")
    let samples = [
      (rows, "Recognized row 30"),
      (String(repeating: "continuous speech ", count: 100) + "newest words", "words"),
      (String(repeating: "👩🏽‍💻", count: 200) + " newest emoji", "emoji"),
    ]
    for (transcript, ending) in samples {
      let frames = fixture.displayPayloads.count
      T3EvenG2SpeechTranscriber.current?.publish(transcript)
      await fixture.waitForNextDisplay(after: frames)
      precondition(fixture.lastDisplayPayload.range(of: Data(ending.utf8)) != nil,
                   "Latest recognized row must remain visible: \(ending)")
      precondition(fixture.lastDisplayPayload.range(of: Data("Recognized row 1\n".utf8)) == nil)
      precondition(fixture.transcripts.last?["text"] as? String == transcript)
    }
    let transcript = samples.last!.0
    fixture.gesture(1)
    fixture.gesture(2)
    precondition(fixture.connection.snapshot["listening"] as? Bool == true,
                 "Swipe reversal must not cancel dictation")
    T3EvenG2SpeechTranscriber.finalText = transcript
    await fixture.connection.finishDictation()
    precondition(fixture.transcripts.last?["text"] as? String == transcript)
    precondition(fixture.transcripts.last?["isFinal"] as? Bool == true)
    await fixture.connection.beginDictation()
    T3EvenG2SpeechTranscriber.current?.publish("Keep these unsent words")
    fixture.gesture(3)
    precondition(fixture.transcripts.last?["interrupted"] as? Bool == true)
    precondition(fixture.transcripts.last?["text"] as? String == "Keep these unsent words")
    fixture.connection.disconnect()
    T3EvenG2SpeechTranscriber.finalText = "test dictation"
  }

  /// Swipes never cancel startup; supported firmware Back still cancels explicitly.
  @MainActor
  private static func verifyStartupSwipeBack() async throws {
    for container in [false, true] {
      let fixture = Fixture()
      fixture.pageOccupied = false
      fixture.subscribe(fixture.left)
      fixture.subscribe(fixture.right)
      await fixture.wait { $0["status"] as? String == "ready" }
      fixture.connection.setActiveThread("mini:startup", enabled: true)
      fixture.connection.displayText("Startup reply")
      await fixture.waitForDisplay("Startup reply")
      for phase in ["immediate", "preparing", "transition"] {
        if phase != "immediate" { try await Task.sleep(for: .milliseconds(450)) }
        let firstFrame = fixture.displayPayloads.count
        fixture.gesture(0, container: container)
        if phase != "immediate" {
          await fixture.waitForDisplay("Preparing dictation")
          precondition(fixture.displayPayloads[firstFrame].range(of: Data("Preparing dictation".utf8)) != nil)
        }
        fixture.gesture(1, container: container)
        if phase == "transition" { await fixture.waitForDisplay("Listening") }
        fixture.gesture(2, container: container)
        await fixture.wait { $0["listening"] as? Bool == true }
        fixture.gesture(9, container: container)
        precondition(fixture.connection.snapshot["detail"] as? String == "Dictation cancelled")
        await fixture.waitForDisplay("Startup reply")
        precondition(fixture.transcripts.last?["cancelled"] as? Bool == true)
        precondition(fixture.transcripts.last?["interrupted"] as? Bool == false)
      }
      fixture.connection.disconnect()
    }
  }

  /// Verifies readable, ordered, bounded records survive creating a new logger instance.
  private static func verifyDiagnostics() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("g2-log-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let logger = T3EvenG2Diagnostics(directory: directory, maxBytes: 1_024)
    for index in 0..<20 { logger.record("gesture.received", fields: ["index": index]) }
    logger.flush()
    let restarted = T3EvenG2Diagnostics(directory: directory, maxBytes: 1_024)
    restarted.record("connection.created")
    restarted.flush()
    let entries = try ["previous.jsonl", "current.jsonl"].flatMap { name -> [[String: Any]] in
      let data = try Data(contentsOf: directory.appendingPathComponent(name))
      precondition(data.count <= 1_024)
      return try data.split(separator: 0x0A).map {
        guard let entry = try JSONSerialization.jsonObject(with: Data($0)) as? [String: Any] else {
          fatalError("Invalid diagnostic record")
        }
        return entry
      }
    }
    precondition(entries.last?["event"] as? String == "connection.created")
    precondition(Set(entries.compactMap { $0["run"] as? String }).count == 2)
    let indices = entries.compactMap { $0["index"] as? Int }
    precondition(indices == indices.sorted() && indices.last == 19)
    precondition(entries.allSatisfy { $0["uptimeMs"] is Double && $0["schema"] as? Int == 1 })
  }

  /// Reopening selects latest, while duplicate active-thread updates preserve browsing.
  @MainActor
  private static func verifyOpenAtLatest() async {
    let fixture = Fixture()
    fixture.pageOccupied = false
    fixture.subscribe(fixture.left)
    fixture.subscribe(fixture.right)
    await fixture.wait { $0["status"] as? String == "ready" }
    fixture.connection.setThreadChoices([
      ["key": "mini:reopen", "title": "Reopen thread", "subtitle": "Mini"],
      ["key": "mini:other", "title": "Other thread", "subtitle": "Mini"],
    ])
    fixture.connection.setActiveThread("mini:reopen", enabled: true)
    let replies = [
      ["id": "old", "text": "Old reading position", "prompt": ""],
      ["id": "new", "text": "Newest reply", "prompt": ""],
    ]
    let payload = historyPayload(replies, key: "mini:reopen")
    fixture.connection.setReplyHistory(payload)
    await fixture.waitForDisplay("Newest reply")
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    await fixture.waitForDisplay("Old reading position")
    fixture.connection.setActiveThread("mini:reopen", enabled: true)
    fixture.connection.setReplyHistory(payload)
    await fixture.waitForDisplay("Old reading position")
    fixture.connection.setActiveThread("mini:other", enabled: true)
    fixture.connection.setActiveThread("mini:reopen", enabled: true)
    fixture.connection.setReplyHistory(payload)
    await fixture.waitForDisplay("Newest reply")
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    await fixture.waitForDisplay("Old reading position")
    fixture.connection.setActiveThread("mini:reopen", enabled: false)
    fixture.connection.setActiveThread("mini:reopen", enabled: true)
    fixture.connection.setReplyHistory(payload)
    await fixture.waitForDisplay("Newest reply")

    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    await fixture.waitForDisplay("Old reading position")
    fixture.connection.showThreadPicker()
    await fixture.waitForDisplay("T3 quick action")
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(2)
    await fixture.waitForDisplay("T3 threads 1/2")
    fixture.gesture(0)
    await fixture.waitForDisplay("Newest reply")

    fixture.connection.setActiveThread("mini:unloaded-latest", enabled: true)
    var oldWindow = historyPayload([replies[0]], key: "mini:unloaded-latest")
    oldWindow["latestReplyId"] = "new"
    oldWindow["totalReplies"] = 2
    oldWindow["hasNewer"] = true
    fixture.connection.setReplyHistory(oldWindow)
    precondition(fixture.historyRequests.count == 1)
    precondition(fixture.historyRequests[0]["direction"] as? String == "latest")
    oldWindow["requestId"] = fixture.historyRequests[0]["requestId"]
    fixture.connection.setReplyHistory(oldWindow)
    precondition(fixture.historyRequests.count == 1, "Unavailable latest must not cause a request loop")
    fixture.connection.setReplyHistory(historyPayload(replies, key: "mini:unloaded-latest"))
    await fixture.waitForDisplay("Newest reply")
    fixture.connection.disconnect()
  }

  /// Exercises history through real ring events and firmware display writes.
  @MainActor
  private static func verifyReplyHistory() async {
    let fixture = Fixture()
    fixture.pageOccupied = false
    fixture.subscribe(fixture.left)
    fixture.subscribe(fixture.right)
    await fixture.wait { $0["status"] as? String == "ready" }
    fixture.connection.setActiveThread("mini:history", enabled: true)
    let longReply = (1...17).map { "Older line \($0)" }.joined(separator: "\n")
    var replies = [
      ["id": "old", "text": longReply, "prompt": "Earlier question"],
      ["id": "latest", "text": "Latest original reply", "prompt": "Current question"],
    ]
    fixture.connection.setReplyHistory(historyPayload(replies))
    await fixture.waitForDisplay("Latest original reply")
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    await fixture.waitForDisplay("Older line 17")
    await fixture.connection.beginDictation()
    replies.append(["id": "new", "text": "New arrival", "prompt": "Next question"])
    fixture.connection.setReplyHistory(historyPayload(replies))
    await fixture.connection.cancelDictation()
    await fixture.waitForDisplay("Older line 17")
    T3EvenG2SpeechTranscriber.finalText = ""
    await fixture.connection.beginDictation()
    await fixture.connection.finishDictation()
    await fixture.waitForDisplay("No speech recognized")
    fixture.holdBack()
    await fixture.waitForDisplay("Older line 17")
    // These are separate user gestures, outside the hardware debounce.
    try? await Task.sleep(for: .milliseconds(450))
    fixture.holdBack()
    // Tap immediately after Back, before its picker frame or input debounce expires.
    fixture.gesture(0)
    await fixture.waitForDisplay("New arrival")
    precondition(fixture.selectedKeys.isEmpty, "Latest must not navigate to a synthetic thread")

    fixture.connection.setActiveThread("mini:window", enabled: true)
    let current = ["id": "20", "text": "Window anchor", "prompt": ""]
    var window = historyPayload([current], key: "mini:window")
    window["startIndex"] = 20
    window["totalReplies"] = 21
    window["hasOlder"] = true
    fixture.connection.setReplyHistory(window)
    await fixture.waitForDisplay("Window anchor")
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    await fixture.waitForHistoryRequest(1)
    let request = fixture.historyRequests[0]
    precondition(request["direction"] as? String == "older")
    var loaded = historyPayload([
      ["id": "19", "text": "Loaded older reply", "prompt": ""], current,
    ], key: "mini:window")
    loaded["startIndex"] = 19
    loaded["totalReplies"] = 21
    loaded["hasOlder"] = true
    loaded["requestId"] = request["requestId"]
    fixture.connection.setReplyHistory(loaded)
    await fixture.waitForDisplay("Loaded older reply")
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    await fixture.waitForHistoryRequest(2)
    await fixture.connection.beginDictation() // Cancels the pending window request.
    loaded["replies"] = [["id": "wrong", "text": "STALE", "prompt": ""]]
    loaded["requestId"] = fixture.historyRequests[1]["requestId"]
    fixture.connection.setReplyHistory(loaded)
    await fixture.connection.cancelDictation()
    await fixture.waitForDisplay("Loaded older reply")
    fixture.connection.setActiveThread("mini:history", enabled: true)
    await fixture.waitForDisplay("New arrival")
    // A late snapshot from another environment/thread must not replace this output.
    fixture.connection.setReplyHistory(loaded)
    fixture.connection.setActiveThread("mini:empty", enabled: true)
    var emptyWindow = historyPayload([], key: "mini:empty")
    emptyWindow["hasOlder"] = true
    fixture.connection.setReplyHistory(emptyWindow)
    await fixture.waitForDisplay("No replies available")
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(1)
    await fixture.waitForHistoryRequest(3)
    var firstLoaded = historyPayload([
      ["id": "older-empty", "text": "Earlier fetched reply", "prompt": ""],
      ["id": "latest-empty", "text": "Closest fetched reply", "prompt": ""],
    ], key: "mini:empty")
    firstLoaded["requestId"] = fixture.historyRequests[2]["requestId"]
    fixture.connection.setReplyHistory(firstLoaded)
    await fixture.waitForDisplay("Closest fetched reply")
    firstLoaded.removeValue(forKey: "requestId")
    firstLoaded["latestReplyId"] = "beyond-window"
    firstLoaded["totalReplies"] = 3
    firstLoaded["hasNewer"] = true
    fixture.connection.setReplyHistory(firstLoaded)
    await fixture.waitForHistoryRequest(4)
    precondition(fixture.historyRequests[3]["direction"] as? String == "latest")
    var newest = historyPayload([
      ["id": "latest-empty", "text": "Closest fetched reply", "prompt": ""],
      ["id": "beyond-window", "text": "Live reply beyond window", "prompt": ""],
    ], key: "mini:empty")
    newest["startIndex"] = 1
    newest["totalReplies"] = 3
    newest["hasOlder"] = true
    newest["requestId"] = fixture.historyRequests[3]["requestId"]
    fixture.connection.setReplyHistory(newest)
    await fixture.waitForDisplay("Live reply beyond window")
    fixture.connection.disconnect()
    T3EvenG2SpeechTranscriber.finalText = "test dictation"
  }

  /// Builds a native history snapshot for a complete test reply window.
  private static func historyPayload(_ replies: [[String: String]], key: String = "mini:history") -> [String: Any] {
    ["threadKey": key, "replies": replies, "startIndex": 0, "totalReplies": replies.count,
     "hasOlder": false, "hasNewer": false, "latestReplyId": replies.last?["id"] ?? "", "loading": false]
  }

  /// Verifies task replacement and missed-ACK recovery separately from navigation timing checks.
  @MainActor
  private static func verifyHeartbeats() async {
    let heartbeat = Fixture(
      pageHeartbeatInterval: .milliseconds(60), pageHeartbeatTimeout: .milliseconds(15))
    heartbeat.pageOccupied = false
    heartbeat.subscribe(heartbeat.left)
    heartbeat.subscribe(heartbeat.right)
    await heartbeat.wait { $0["status"] as? String == "ready" }
    heartbeat.pageHeartbeatResponses = [false, true, false, false]
    await heartbeat.waitForPageHeartbeat { heartbeat.pageHeartbeatAttempts >= 1 }
    await heartbeat.waitForPageHeartbeat { heartbeat.pageHeartbeatAttempts >= 2 }
    await heartbeat.waitForPageHeartbeat { heartbeat.pageHeartbeatAttempts >= 3 }
    precondition(heartbeat.pageHeartbeatAcks == 1)
    precondition(heartbeat.connection.snapshot["status"] as? String == "ready")
    await heartbeat.wait { $0["status"] as? String == "paused" }
    precondition(heartbeat.pageHeartbeatAttempts == 4)
    heartbeat.connection.disconnect()

    let lifecycle = Fixture(pageHeartbeatInterval: .seconds(30))
    lifecycle.pageOccupied = false
    lifecycle.subscribe(lifecycle.left)
    lifecycle.subscribe(lifecycle.right)
    await lifecycle.wait { $0["status"] as? String == "ready" }
    let lifecycleCentral = CBCentralManager.latest!
    lifecycleCentral.state = .unknown
    await lifecycle.waitForBaseHeartbeatTaskEnd(1)
    lifecycleCentral.state = .poweredOn
    lifecycle.subscribe(lifecycle.left)
    precondition(lifecycle.baseHeartbeatTaskStarts == 2)
    let naturalRestartCount = lifecycle.baseHeartbeatCounts["L", default: 0]
    await lifecycle.waitForBaseHeartbeat {
      lifecycle.baseHeartbeatCounts["L", default: 0] > naturalRestartCount
    }
    lifecycle.connection.disconnect()

    let staleTask = Fixture(connectionTimeout: .milliseconds(60))
    staleTask.pageOccupied = false
    staleTask.subscribe(staleTask.left)
    await staleTask.wait { $0["status"] as? String == "error" }
    precondition(staleTask.baseHeartbeatTaskStarts == 1)
    staleTask.connection.connect()
    guard let staleCentral = CBCentralManager.latest else { fatalError("Missing stale-task central") }
    for peripheral in [staleTask.left, staleTask.right] {
      staleTask.connection.centralManager(
        staleCentral, didDiscover: peripheral, advertisementData: [:], rssi: -40)
      staleTask.discover(peripheral)
      staleTask.subscribe(peripheral)
    }
    await staleTask.wait { $0["status"] as? String == "ready" }
    precondition(staleTask.baseHeartbeatTaskStarts == 2)
    await staleTask.waitForBaseHeartbeatTaskEnd(1)
    staleTask.subscribe(staleTask.left)
    precondition(staleTask.baseHeartbeatTaskStarts == 2)
    staleTask.connection.disconnect()
  }
}
