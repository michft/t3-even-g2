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

  /// Encodes the initial T3 Code page, using the supplied session magic and app name.
  static func createPage(magic: Int, name: String = "t3code") -> [UInt8] {
    let item = message([
      uint(1, 1),
      string(4, "T3 Code ready"),
    ])
    let list = message([
      uint(3, 576),
      uint(4, 288),
      uint(9, 1),
      string(10, name),
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

  /// Encodes a text-page rebuild, truncating content to fit the device's byte limit.
  static func rebuildText(_ text: String, magic: Int, name: String = "t3code") -> [UInt8] {
    let content = limitedUTF8(text, maxBytes: 900)
    let textObject = message([
      uint(3, 576),
      uint(4, 288),
      uint(9, 1),
      string(10, name),
      uint(11, 1),
      bytes(12, Array(content.utf8)),
    ])
    let rebuild = message([
      uint(1, 1),
      nested(3, textObject),
    ])
    return message([uint(1, 7), uint(2, magic), nested(7, rebuild)])
  }

  /// Encodes the EvenHub page heartbeat for the current session.
  static func heartbeat(magic: Int) -> [UInt8] {
    message([uint(1, 12), uint(2, magic), nested(14, [])])
  }

  // Base connection liveness is separate from the EvenHub page heartbeat.
  // https://github.com/Mentra-Community/MentraOS/blob/dev/mobile/modules/bluetooth-sdk/ios/Source/sgcs/G2.swift
  /// Encodes the base connection liveness heartbeat for the current session.
  static func baseHeartbeat(magic: Int) -> [UInt8] {
    message([uint(1, 14), uint(2, magic), nested(13, [])])
  }

  // Same DevSettings source above: secAuth=true, phoneType=PHONE_IOS (3).
  /// Encodes iOS device authentication for the current session.
  static func authenticate(magic: Int) -> [UInt8] {
    message([uint(1, 4), uint(2, magic), nested(3, message([uint(1, 1), uint(2, 3)]))])
  }

  /// Encodes a request to enable or disable audio capture for this session.
  static func audioControl(enabled: Bool, magic: Int) -> [UInt8] {
    let command = enabled ? message([uint(1, 1)]) : []
    return message([uint(1, 15), uint(2, magic), nested(18, command)])
  }

  /// Encodes the session shutdown command.
  static func shutdown(magic: Int) -> [UInt8] {
    message([uint(1, 9), uint(2, magic), nested(11, [])])
  }

  /// Adds CRC-16 and splits a payload into transport-sized packets.
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

  /// Decodes a supported device-event packet, returning nil for other or malformed packets.
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
      return Gesture(kind: gestureName(fields(textData).uint(3) ?? 0), source: "textContainer")
    }
    if let listData = event.data(1) {
      return Gesture(kind: gestureName(fields(listData).uint(5) ?? 0), source: "listContainer")
    }
    return nil
  }

  /// Extracts service and session magic from a valid acknowledgement packet.
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

  private static let gestureNames = [
    "click", "scrollUp", "scrollDown", "doubleClick", "foregroundEnter", "foregroundExit",
    "abnormalExit", "systemExit", "imu", "longPress", "longPressRelease",
  ]

  /// Maps a protocol gesture number to its JavaScript-facing name.
  private static func gestureName(_ value: Int) -> String {
    gestureNames.indices.contains(value) ? gestureNames[value] : "unknown"
  }

  /// Reports whether a gesture source can start dictation.
  static func isDictationSource(_ source: String) -> Bool {
    ["ring", "rightTemple", "leftTemple", "textContainer", "listContainer"].contains(source)
  }

  /// Reports whether this gesture can dismiss the active display page.
  static func requiresDisplayRecovery(for gestureKind: String) -> Bool {
    // Foreground events also describe system menu overlays, not page teardown.
    ["doubleClick", "systemExit", "abnormalExit"].contains(gestureKind)
  }

  /// Returns the page delta for a scroll gesture, accounting for scroll preference.
  static func lensPageOffset(for gestureKind: String, naturalScrolling: Bool = false) -> Int? {
    switch gestureKind {
    case "scrollDown": naturalScrolling ? -1 : 1
    case "scrollUp": naturalScrolling ? 1 : -1
    default: nil
    }
  }

  /// Wraps and paginates text within lens row and UTF-8 byte limits.
  static func lensTextPages(
    _ text: String,
    columns: Int = 46,
    rows: Int = 9,
    maxBytes: Int = 820,
    includeFooter: Bool = true
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
        let hardEnd = wrappedLineEnd(in: remaining, columns: safeColumns, maxBytes: safeMaxBytes)
        guard hardEnd < remaining.endIndex else {
          wrappedLines.append(remaining)
          break
        }
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

    let singlePage = wrappedLines.joined(separator: "\n")
    if wrappedLines.count <= safeRows, singlePage.utf8.count <= safeMaxBytes {
      return [singlePage]
    }
    let contentRows = max(1, safeRows - (includeFooter ? 1 : 0))
    var pageLines: [[String]] = []
    var currentLines: [String] = []
    var currentBytes = 0
    for line in wrappedLines {
      let addedBytes = line.utf8.count + (currentLines.isEmpty ? 0 : 1)
      if !currentLines.isEmpty,
        currentLines.count >= contentRows || currentBytes + addedBytes > safeMaxBytes {
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

    guard includeFooter, pageLines.count > 1 else {
      return pageLines.map { $0.joined(separator: "\n") }
    }
    return pageLines.enumerated().map { index, lines in
      "\(lines.joined(separator: "\n"))\n\(index + 1)/\(pageLines.count) · swipe ↑↓"
    }
  }

  /// Finds a character or scalar boundary that fits one display line and its byte budget.
  private static func wrappedLineEnd(in text: String, columns: Int, maxBytes: Int) -> String.Index {
    var hardEnd = text.startIndex
    var lineBytes = 0
    for _ in 0..<columns {
      guard hardEnd < text.endIndex else { break }
      let next = text.index(after: hardEnd)
      let count = text[hardEnd..<next].utf8.count
      guard lineBytes + count <= maxBytes else { break }
      lineBytes += count
      hardEnd = next
    }
    // Split oversized combining sequences at scalar boundaries without dropping text.
    if hardEnd == text.startIndex {
      for scalar in text.unicodeScalars {
        guard lineBytes + scalar.utf8.count <= maxBytes else { break }
        lineBytes += scalar.utf8.count
        hardEnd = text.unicodeScalars.index(after: hardEnd)
      }
    }
    return hardEnd
  }

  /// Maps a protocol input-source number to its JavaScript-facing name.
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

    /// Returns the last varint value for a field number, if present.
    func uint(_ number: Int) -> Int? {
      values.last(where: { $0.number == number })?.uintValue
    }

    /// Returns the last length-delimited value for a field number, if present.
    func data(_ number: Int) -> [UInt8]? {
      values.last(where: { $0.number == number })?.dataValue
    }
  }

  /// Reads supported protobuf wire types, stopping at malformed or unsupported data.
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
        guard length >= 0, length <= bytes.count - index else { break }
        let end = index + length
        result.append(Field(number: number, uintValue: nil, dataValue: Array(bytes[index..<end])))
        index = end
      } else {
        break
      }
    }
    return Fields(values: result)
  }

  /// Decodes one bounded varint and returns its value and next byte offset.
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

  /// Joins already encoded fields into one protocol message.
  private static func message(_ fields: [[UInt8]]) -> [UInt8] {
    fields.flatMap { $0 }
  }

  /// Encodes a protobuf varint field, omitting its proto3 default value of zero.
  private static func uint(_ field: Int, _ value: Int) -> [UInt8] {
    guard value != 0 else { return [] }
    return varint((field << 3) | 0) + varint(value)
  }

  /// Encodes a string as a length-delimited UTF-8 field.
  private static func string(_ field: Int, _ value: String) -> [UInt8] {
    bytes(field, Array(value.utf8))
  }

  /// Encodes a nested message as a length-delimited field.
  private static func nested(_ field: Int, _ value: [UInt8]) -> [UInt8] {
    bytes(field, value)
  }

  /// Encodes bytes as a length-delimited field.
  private static func bytes(_ field: Int, _ value: [UInt8]) -> [UInt8] {
    varint((field << 3) | 2) + varint(value.count) + value
  }

  /// Encodes a nonnegative integer using protobuf's base-128 varint format.
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

  /// Truncates at a character boundary and appends an ellipsis within the byte limit.
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

  /// Computes the CRC-16/CCITT checksum used by the packet transport.
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
