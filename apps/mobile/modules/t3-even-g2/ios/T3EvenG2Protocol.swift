import Foundation

enum T3EvenG2Protocol {
  static let writeUUID = "00002760-08c2-11e1-9073-0e8ac72e5401"
  static let notifyUUID = "00002760-08c2-11e1-9073-0e8ac72e5402"
  static let renderNotifyUUID = "00002760-08c2-11e1-9073-0e8ac72e6402"

  // Required once on the right arm after a fresh G2 connection. Captured and
  // documented by the MIT-licensed g2-kit-unofficial project.
  static let sessionPrelude = Data([
    0xAA, 0x21, 0x92, 0x13, 0x01, 0x01, 0x01, 0x20, 0x08, 0x02, 0x10, 0x9C,
    0x01, 0x22, 0x0A, 0x1A, 0x08, 0x12, 0x06, 0x12, 0x04, 0x08, 0x00, 0x10,
    0x00, 0xA1, 0x42,
  ])

  struct Gesture {
    let kind: String
    let source: String
  }

  static func createPage(magic: Int) -> [UInt8] {
    let item = message([
      uint(1, 1),
      string(4, "T3 Code ready"),
    ])
    let list = message([
      uint(3, 576),
      uint(4, 288),
      uint(9, 1),
      string(10, "t3code"),
      nested(11, item),
      uint(12, 1),
    ])
    let page = message([
      uint(1, 1),
      nested(2, list),
      uint(5, 10_000),
    ])
    // Cmd=0 is a proto3 default and is intentionally absent on the wire.
    return message([uint(2, magic), nested(3, page)])
  }

  static func rebuildText(_ text: String, magic: Int) -> [UInt8] {
    let content = limitedUTF8(text, maxBytes: 900)
    let textObject = message([
      uint(3, 576),
      uint(4, 288),
      uint(9, 1),
      string(10, "t3code"),
      uint(11, 1),
      bytes(12, Array(content.utf8)),
    ])
    let rebuild = message([
      uint(1, 1),
      nested(3, textObject),
    ])
    return message([uint(1, 7), uint(2, magic), nested(7, rebuild)])
  }

  static func heartbeat(magic: Int) -> [UInt8] {
    message([uint(1, 12), uint(2, magic), nested(14, [])])
  }

  static func audioControl(enabled: Bool, magic: Int) -> [UInt8] {
    let command = enabled ? message([uint(1, 1)]) : []
    return message([uint(1, 15), uint(2, magic), nested(18, command)])
  }

  static func shutdown(magic: Int) -> [UInt8] {
    message([uint(1, 9), uint(2, magic), nested(11, [])])
  }

  static func frames(
    payload: [UInt8],
    sequence: UInt8,
    service: UInt8 = 0xE0,
    flag: UInt8 = 0x20,
    chunkSize: Int = 232
  ) -> [Data] {
    let checksum = crc16(payload)
    let body = payload + [UInt8(checksum & 0xFF), UInt8(checksum >> 8)]
    let count = max(1, Int(ceil(Double(body.count) / Double(chunkSize))))

    return (0..<count).map { index in
      let start = index * chunkSize
      let end = min(start + chunkSize, body.count)
      let chunk = Array(body[start..<end])
      return Data(
        [0xAA, 0x21, sequence, UInt8(chunk.count), UInt8(count), UInt8(index + 1), service, flag]
          + chunk
      )
    }
  }

  static func gesture(from packet: Data) -> Gesture? {
    let bytes = [UInt8](packet)
    guard bytes.count >= 10, bytes[0] == 0xAA, bytes[6] == 0xE0 else { return nil }
    let payloadEnd = max(8, bytes.count - 2)
    let payload = Array(bytes[8..<payloadEnd])
    let top = fields(payload)
    guard top.uint(1) == 2, let deviceEvent = top.data(13) else { return nil }
    let event = fields(deviceEvent)

    if let systemData = event.data(3) {
      let system = fields(systemData)
      return Gesture(
        kind: gestureName(system.uint(1) ?? 0),
        source: sourceName(system.uint(2) ?? 0)
      )
    }
    if let textData = event.data(2) {
      return Gesture(kind: gestureName(fields(textData).uint(3) ?? 0), source: "unknown")
    }
    if let listData = event.data(1) {
      return Gesture(kind: gestureName(fields(listData).uint(5) ?? 0), source: "unknown")
    }
    return nil
  }

  static func acknowledgement(from packet: Data) -> (service: UInt8, magic: Int)? {
    let bytes = [UInt8](packet)
    guard
      bytes.count >= 10,
      bytes[0] == 0xAA,
      bytes[1] == 0x12,
      bytes[4] == 1,
      bytes[5] == 1
    else { return nil }

    let payloadLength = Int(bytes[3])
    guard payloadLength >= 2, 8 + payloadLength <= bytes.count else { return nil }
    let payload = Array(bytes[8..<(8 + payloadLength - 2)])
    guard let magic = fields(payload).uint(2) else { return nil }
    return (service: bytes[6], magic: magic)
  }

  private static func gestureName(_ value: Int) -> String {
    switch value {
    case 0: "click"
    case 1: "scrollUp"
    case 2: "scrollDown"
    case 3: "doubleClick"
    case 4: "foregroundEnter"
    case 5: "foregroundExit"
    case 6: "abnormalExit"
    case 7: "systemExit"
    case 8: "imu"
    default: "unknown"
    }
  }

  static func isDictationSource(_ source: String) -> Bool {
    source == "ring" || source == "rightTemple" || source == "leftTemple"
  }

  static func lensPageOffset(for gestureKind: String) -> Int? {
    switch gestureKind {
    case "scrollDown": 1
    case "scrollUp": -1
    default: nil
    }
  }

  static func lensTextPages(
    _ text: String,
    columns: Int = 46,
    rows: Int = 9,
    maxBytes: Int = 820
  ) -> [String] {
    let safeColumns = max(1, columns)
    let safeRows = max(1, rows)
    let safeMaxBytes = max(64, maxBytes)
    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
    var wrappedLines: [String] = []

    for rawLine in normalized.components(separatedBy: "\n") {
      if rawLine.isEmpty {
        wrappedLines.append("")
        continue
      }

      var remaining = rawLine
      while !remaining.isEmpty {
        guard remaining.count > safeColumns else {
          wrappedLines.append(remaining)
          break
        }
        let hardEnd = remaining.index(remaining.startIndex, offsetBy: safeColumns)
        let candidate = remaining[..<hardEnd]
        let breakIndex = candidate.lastIndex(where: \.isWhitespace)
        let end = if let breakIndex, breakIndex > remaining.startIndex {
          breakIndex
        } else {
          hardEnd
        }
        wrappedLines.append(String(remaining[..<end]).trimmingCharacters(in: .whitespaces))
        remaining = String(remaining[end...]).trimmingCharacters(in: .whitespaces)
      }
    }

    if wrappedLines.isEmpty {
      return [""]
    }

    var pageLines: [[String]] = []
    var currentLines: [String] = []
    var currentBytes = 0
    for line in wrappedLines {
      let addedBytes = line.utf8.count + (currentLines.isEmpty ? 0 : 1)
      if !currentLines.isEmpty,
        currentLines.count >= safeRows || currentBytes + addedBytes > safeMaxBytes
      {
        pageLines.append(currentLines)
        currentLines = []
        currentBytes = 0
      }
      currentLines.append(line)
      currentBytes += line.utf8.count + (currentLines.count == 1 ? 0 : 1)
    }
    if !currentLines.isEmpty {
      pageLines.append(currentLines)
    }

    guard pageLines.count > 1 else {
      return [pageLines[0].joined(separator: "\n")]
    }
    return pageLines.enumerated().map { index, lines in
      "\(lines.joined(separator: "\n"))\n\(index + 1)/\(pageLines.count) · swipe ↑↓"
    }
  }

  private static func sourceName(_ value: Int) -> String {
    switch value {
    case 1: "rightTemple"
    case 2: "ring"
    case 3: "leftTemple"
    default: "unknown"
    }
  }

  private struct Field {
    let number: Int
    let uintValue: Int?
    let dataValue: [UInt8]?
  }

  private struct Fields {
    let values: [Field]

    func uint(_ number: Int) -> Int? {
      values.last(where: { $0.number == number })?.uintValue
    }

    func data(_ number: Int) -> [UInt8]? {
      values.last(where: { $0.number == number })?.dataValue
    }
  }

  private static func fields(_ bytes: [UInt8]) -> Fields {
    var result: [Field] = []
    var index = 0
    while index < bytes.count, let (key, keyEnd) = readVarint(bytes, from: index) {
      index = keyEnd
      let number = key >> 3
      let wire = key & 0x07
      if wire == 0, let (value, end) = readVarint(bytes, from: index) {
        result.append(Field(number: number, uintValue: value, dataValue: nil))
        index = end
      } else if wire == 2, let (length, lengthEnd) = readVarint(bytes, from: index) {
        index = lengthEnd
        let end = index + length
        guard end >= index, end <= bytes.count else { break }
        result.append(Field(number: number, uintValue: nil, dataValue: Array(bytes[index..<end])))
        index = end
      } else {
        break
      }
    }
    return Fields(values: result)
  }

  private static func readVarint(_ bytes: [UInt8], from start: Int) -> (Int, Int)? {
    var value = 0
    var shift = 0
    var index = start
    while index < bytes.count, shift < 63 {
      let byte = bytes[index]
      value |= Int(byte & 0x7F) << shift
      index += 1
      if byte & 0x80 == 0 { return (value, index) }
      shift += 7
    }
    return nil
  }

  private static func message(_ fields: [[UInt8]]) -> [UInt8] {
    fields.flatMap { $0 }
  }

  private static func uint(_ field: Int, _ value: Int) -> [UInt8] {
    guard value != 0 else { return [] }
    return varint((field << 3) | 0) + varint(value)
  }

  private static func string(_ field: Int, _ value: String) -> [UInt8] {
    bytes(field, Array(value.utf8))
  }

  private static func nested(_ field: Int, _ value: [UInt8]) -> [UInt8] {
    bytes(field, value)
  }

  private static func bytes(_ field: Int, _ value: [UInt8]) -> [UInt8] {
    varint((field << 3) | 2) + varint(value.count) + value
  }

  private static func varint(_ input: Int) -> [UInt8] {
    var value = input
    var output: [UInt8] = []
    repeat {
      var byte = UInt8(value & 0x7F)
      value >>= 7
      if value > 0 { byte |= 0x80 }
      output.append(byte)
    } while value > 0
    return output
  }

  private static func limitedUTF8(_ text: String, maxBytes: Int) -> String {
    if text.utf8.count <= maxBytes { return text }
    let suffix = "…"
    let contentLimit = max(0, maxBytes - suffix.utf8.count)
    var output = ""
    for character in text {
      let candidate = output + String(character)
      if candidate.utf8.count > contentLimit { break }
      output = candidate
    }
    return output + suffix
  }

  private static func crc16(_ bytes: [UInt8]) -> UInt16 {
    var crc: UInt16 = 0xFFFF
    for byte in bytes {
      crc ^= UInt16(byte) << 8
      for _ in 0..<8 {
        crc = crc & 0x8000 != 0 ? (crc << 1) ^ 0x1021 : crc << 1
      }
    }
    return crc
  }
}
