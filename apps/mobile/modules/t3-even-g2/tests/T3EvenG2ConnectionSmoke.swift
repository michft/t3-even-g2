import CoreBluetooth
import Foundation

@MainActor
final class T3EvenG2SpeechTranscriber {
  private var update: ((String, Bool) -> Void)?
  func start(onUpdate: @escaping (String, Bool) -> Void) async throws { update = onUpdate }
  func appendPCM(_ pcm: Data) throws {}
  func finish() async throws -> String {
    update?("test dictation", true)
    return "test dictation"
  }
  func cancel() async { update = nil }
}
final class T3EvenG2LC3Decoder {
  func decodePacket(_ packet: Data) throws -> Data { Data() }
}

@MainActor
final class Fixture {
  let connection: T3EvenG2Connection
  let left = CBPeripheral("G2_TEST_L_ARM")
  let right = CBPeripheral("G2_TEST_R_ARM")
  var transcripts: [[String: Any]] = []
  var selectedKeys: [String] = []
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

  init(connectionTimeout: Duration = .seconds(20), rememberedLeft: CBPeripheral? = nil) {
    connection = T3EvenG2Connection(
      connectionTimeout: connectionTimeout, baseHeartbeatInterval: .milliseconds(20))
    connection.onStatus = { [weak self] state in self?.waiter?(state) }
    connection.onTranscript = { [weak self] event in self?.transcripts.append(event) }
    connection.onThreadSelected = { [weak self] event in
      if let key = event["key"] as? String { self?.selectedKeys.append(key) }
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
      }
      discover(peripheral)
    }
  }

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

  func subscribe(_ peripheral: CBPeripheral) {
    for characteristic in peripheral.services![0].characteristics!.dropFirst() {
      characteristic.isNotifying = true
      connection.peripheral(peripheral, didUpdateNotificationStateFor: characteristic, error: nil)
    }
  }

  func gesture(_ event: UInt8, container: Bool = false) {
    let inner: [UInt8] = container ? [0x12, 2, 0x18, event] : [0x1A, 4, 0x08, event, 0x10, 2]
    let payload: [UInt8] = [0x08, 2, 0x6A, UInt8(inner.count)] + inner
    let notify = right.services![0].characteristics![1]
    notify.value = Data(
      [0xAA, 0x21, 0, UInt8(payload.count + 2), 1, 1, 0xE0, 1] + payload + [0, 0])
    connection.peripheral(right, didUpdateValueFor: notify, error: nil)
  }

  func wait(_ predicate: @escaping ([String: Any]) -> Bool) async {
    if predicate(connection.snapshot) { return }
    await withCheckedContinuation { continuation in
      waiter = { [weak self] state in
        if predicate(state) {
          self?.waiter = nil
          continuation.resume()
        }
      }
    }
  }

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
}

@main
struct Smoke {
  @MainActor
  static func main() async {
    let watchdog = Task {
      try? await Task.sleep(for: .seconds(25))
      guard !Task.isCancelled else { return }
      fatalError("G2 connection test timed out waiting for a lifecycle callback")
    }
    defer { watchdog.cancel() }
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
    try? await Task.sleep(for: .milliseconds(450))
    fixture.gesture(0, container: true)
    await fixture.wait { $0["listening"] as? Bool == true }
    fixture.gesture(3)
    precondition(fixture.connection.snapshot["status"] as? String == "paused")
    await fixture.waitForBaseHeartbeat { fixture.baseHeartbeatStates.contains("paused") }
    precondition(
      fixture.transcripts.count == 1 && fixture.transcripts[0]["cancelled"] as? Bool == true)
    await fixture.wait { $0["status"] as? String == "ready" }
    precondition(fixture.connection.snapshot["listening"] as? Bool == false)
    fixture.gesture(0)
    await fixture.wait { $0["listening"] as? Bool == true }
    // Let the gesture task finish before explicitly ending this second session.
    await Task.yield()
    await fixture.connection.finishDictation()
    precondition(fixture.transcripts.count == 2)
    precondition(fixture.transcripts[1]["text"] as? String == "test dictation")
    fixture.gesture(3)
    await fixture.wait { $0["status"] as? String == "ready" }
    fixture.gesture(0)
    precondition(fixture.selectedKeys == ["moorbeef:b", "moorbeef:b"])
    precondition(fixture.connection.snapshot["listening"] as? Bool == false)
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
}
