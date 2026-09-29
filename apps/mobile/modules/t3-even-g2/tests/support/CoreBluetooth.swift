import Foundation

public let CBCentralManagerOptionRestoreIdentifierKey = "restore"
public let CBCentralManagerRestoredStatePeripheralsKey = "peripherals"
public let CBAdvertisementDataLocalNameKey = "name"
public let CBCentralManagerScanOptionAllowDuplicatesKey = "duplicates"
public enum CBManagerState { case poweredOn, poweredOff, unauthorized, unsupported, unknown }
public enum CBPeripheralState { case connected, disconnected, connecting, disconnecting }
public enum CBCharacteristicWriteType { case withoutResponse }
public protocol CBCentralManagerDelegate: AnyObject {}
public protocol CBPeripheralDelegate: AnyObject {}
public final class CBUUID {
  public let uuidString: String
  /// Creates a UUID wrapper with the supplied canonical string.
  public init(string: String) { uuidString = string }
}
public final class CBCharacteristic {
  public let uuid: CBUUID
  public var isNotifying = false
  public var value: Data?
  /// Creates a characteristic stub with the given UUID string.
  public init(_ uuid: String) { self.uuid = CBUUID(string: uuid) }
}
public final class CBService {
  public var characteristics: [CBCharacteristic]?
  /// Creates a service stub containing the supplied characteristics.
  public init(_ characteristics: [CBCharacteristic]) { self.characteristics = characteristics }
}
public final class CBPeripheral {
  public var name: String?
  public let identifier = UUID()
  public weak var delegate: CBPeripheralDelegate?
  public var services: [CBService]?
  public var state = CBPeripheralState.disconnected
  public var canSendWriteWithoutResponse = true
  public var onWrite: ((Data) -> Void)?
  public var writes: [Data] = []
  /// Creates a peripheral stub with a display name.
  public init(_ name: String) { self.name = name }
  /// Stubs service discovery; tests drive delegate callbacks directly.
  public func discoverServices(_ services: [CBUUID]?) {}
  /// Stubs characteristic discovery; tests drive delegate callbacks directly.
  public func discoverCharacteristics(_ characteristics: [CBUUID]?, for service: CBService) {}
  /// Stubs notification setup; tests drive delegate callbacks directly.
  public func setNotifyValue(_ value: Bool, for characteristic: CBCharacteristic) {}
  /// Returns the simulated maximum BLE write size.
  public func maximumWriteValueLength(for type: CBCharacteristicWriteType) -> Int { 244 }
  /// Records a write and invokes the optional test hook.
  public func writeValue(
    _ data: Data, for characteristic: CBCharacteristic, type: CBCharacteristicWriteType
  ) {
    writes.append(data)
    onWrite?(data)
  }
}
public final class CBCentralManager {
  public static var latest: CBCentralManager!
  public var state = CBManagerState.poweredOn
  public var connections: [CBPeripheral] = []
  public var cancelled: [CBPeripheral] = []
  public var retrievable: [CBPeripheral] = []
  public var isScanning = false
  /// Creates the latest central stub; other parameters mirror CoreBluetooth's initializer.
  public init(delegate: CBCentralManagerDelegate, queue: DispatchQueue?, options: [String: Any]?) {
    Self.latest = self
  }
  /// Records a connection request and marks the peripheral as connecting.
  public func connect(_ peripheral: CBPeripheral, options: [String: Any]?) {
    connections.append(peripheral)
    peripheral.state = .connecting
  }
  /// Records cancellation and marks the peripheral disconnected.
  public func cancelPeripheralConnection(_ peripheral: CBPeripheral) {
    cancelled.append(peripheral)
    peripheral.state = .disconnected
  }
  /// Marks scanning as stopped.
  public func stopScan() { isScanning = false }
  /// Marks scanning as active; tests provide discoveries through delegate callbacks.
  public func scanForPeripherals(withServices: [CBUUID]?, options: [String: Any]?) { isScanning = true }
  /// Returns configured peripherals whose identifiers match the request.
  public func retrievePeripherals(withIdentifiers identifiers: [UUID]) -> [CBPeripheral] {
    retrievable.filter { identifiers.contains($0.identifier) }
  }
}
