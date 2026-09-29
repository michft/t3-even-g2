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
  public init(string: String) { uuidString = string }
}
public final class CBCharacteristic {
  public let uuid: CBUUID
  public var isNotifying = false
  public var value: Data?
  public init(_ uuid: String) { self.uuid = CBUUID(string: uuid) }
}
public final class CBService {
  public var characteristics: [CBCharacteristic]?
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
  public init(_ name: String) { self.name = name }
  public func discoverServices(_ services: [CBUUID]?) {}
  public func discoverCharacteristics(_ characteristics: [CBUUID]?, for service: CBService) {}
  public func setNotifyValue(_ value: Bool, for characteristic: CBCharacteristic) {}
  public func maximumWriteValueLength(for type: CBCharacteristicWriteType) -> Int { 244 }
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
  public init(delegate: CBCentralManagerDelegate, queue: DispatchQueue?, options: [String: Any]?) {
    Self.latest = self
  }
  public func connect(_ peripheral: CBPeripheral, options: [String: Any]?) {
    connections.append(peripheral)
    peripheral.state = .connecting
  }
  public func cancelPeripheralConnection(_ peripheral: CBPeripheral) {
    peripheral.state = .disconnected
  }
  public func stopScan() {}
  public func scanForPeripherals(withServices: [CBUUID]?, options: [String: Any]?) {}
  public func retrievePeripherals(withIdentifiers: [UUID]) -> [CBPeripheral] { [] }
}
