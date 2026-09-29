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
  let connection = T3EvenG2Connection()
  let left = CBPeripheral("G2_TEST_L_ARM")
  let right = CBPeripheral("G2_TEST_R_ARM")
  var transcripts: [[String: Any]] = []
  var waiter: (([String: Any]) -> Void)?

  init() {
    connection.onStatus = { [weak self] state in self?.waiter?(state) }
    connection.onTranscript = { [weak self] event in self?.transcripts.append(event) }
    connection.connect()
    connection.centralManagerDidUpdateState(CBCentralManager.latest)
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
    // Test process gets a separate preferences domain; no real pairing state.
    let fixture = Fixture()
    precondition(fixture.connection.snapshot["status"] as? String != "starting")
    fixture.subscribe(fixture.left)
    precondition(fixture.connection.snapshot["status"] as? String != "starting")
    fixture.subscribe(fixture.right)
    await fixture.wait { $0["status"] as? String == "ready" }
    fixture.connection.setInputEnabled(true)
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
      "G2 native driver: notification readiness, container tap, exit cancellation, automatic recovery, second dictation, and arm reconnect passed"
    )
  }
}
