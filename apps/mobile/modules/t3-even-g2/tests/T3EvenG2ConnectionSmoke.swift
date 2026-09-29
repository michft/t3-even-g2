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

  init(connectionTimeout: Duration = .seconds(20), rememberedLeft: CBPeripheral? = nil) {
    connection = T3EvenG2Connection(connectionTimeout: connectionTimeout)
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
        // Transport ACK echoes the command's magic, including the fixed prelude.
        guard bytes.count > 12, bytes[4] == 1, let offset = bytes[8...].firstIndex(of: 0x10) else {
          return
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
}

@main
struct Smoke {
  @MainActor
  static func main() async {
    let watchdog = Task {
      try? await Task.sleep(for: .seconds(15))
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
    let competingLeft = CBPeripheral("G2_OTHER_L_ARM")
    recovering.connection.centralManager(
      recoveringCentral, didDiscover: competingLeft, advertisementData: [:], rssi: -40)
    precondition(!recoveringCentral.connections.contains { $0 === competingLeft })
    await recovering.wait { $0["status"] as? String == "error" }
    precondition((recovering.connection.snapshot["detail"] as? String)?.contains("G2 right arm not ready") == true)
    precondition(!recoveringCentral.isScanning && recoveringCentral.cancelled.count == 1)
    recovering.subscribe(recovering.right)
    await recovering.wait { $0["status"] as? String == "ready" }
    // Reconnect gets its own deadline and leaves the healthy arm subscribed.
    recovering.right.state = .disconnected
    recovering.connection.centralManager(
      recoveringCentral, didDisconnectPeripheral: recovering.right, error: nil)
    precondition(recoveringCentral.isScanning)
    await recovering.wait { $0["status"] as? String == "error" }
    precondition(recovering.left.services?.first?.characteristics?.dropFirst().first?.isNotifying == true)
    precondition(recoveringCentral.cancelled.count == 1 && recovering.right.state == .connecting)
    recovering.discover(recovering.right)
    recovering.subscribe(recovering.right)
    await recovering.wait { $0["status"] as? String == "ready" }
    recovering.connection.disconnect()

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
    precondition(!cancelledCentral.isScanning)

    let fixture = Fixture()
    fixture.connection.setThreadChoices([
      ["key": "mini:a", "title": "First thread", "subtitle": "Mini"],
      ["key": "moorbeef:b", "title": "Second thread", "subtitle": "Moorbeef"],
    ])
    precondition(fixture.connection.snapshot["status"] as? String != "starting")
    fixture.subscribe(fixture.left)
    precondition(fixture.connection.snapshot["status"] as? String != "starting")
    fixture.subscribe(fixture.right)
    await fixture.wait { $0["status"] as? String == "ready" }
    precondition(cancelled.connection.snapshot["status"] as? String == "disconnected")
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
    fixture.connection.disconnect()
    precondition(fixture.connection.snapshot["status"] as? String == "disconnected")
    print(
      "G2 native driver: readiness deadlines, stale arm replacement, late recovery, cancellation, thread picker, dictation, and reconnect passed"
    )
  }
}
