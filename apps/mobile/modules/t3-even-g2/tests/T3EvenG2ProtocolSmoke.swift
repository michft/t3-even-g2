import Foundation

private struct CheckFailure: Error, CustomStringConvertible {
  let description: String
}

private func check(
  _ condition: @autoclosure () -> Bool,
  _ message: String
) throws {
  if !condition() { throw CheckFailure(description: message) }
}

private func packet(payload: [UInt8]) -> Data {
  Data([0xAA, 0x21, 0x01, UInt8(payload.count + 2), 0x01, 0x01, 0xE0, 0x20]
    + payload + [0x00, 0x00])
}

private func nested(_ field: UInt8, _ value: [UInt8]) -> [UInt8] {
  [(field << 3) | 2, UInt8(value.count)] + value
}

private func readVarint(_ bytes: [UInt8], from start: Int) -> (value: Int, end: Int)? {
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

private func lengthDelimitedField(_ number: Int, in bytes: [UInt8]) -> [UInt8]? {
  var index = 0
  while index < bytes.count {
    guard let keyValue = readVarint(bytes, from: index) else { return nil }
    let key = keyValue.value
    index = keyValue.end
    let field = key >> 3
    let wire = key & 7
    if wire == 0 {
      guard let value = readVarint(bytes, from: index) else { return nil }
      index = value.end
      continue
    }
    guard wire == 2, let encodedLength = readVarint(bytes, from: index) else { return nil }
    let length = encodedLength.value
    index = encodedLength.end
    guard index + length <= bytes.count else { return nil }
    let value = Array(bytes[index..<(index + length)])
    if field == number { return value }
    index += length
  }
  return nil
}

@main
private struct T3EvenG2ProtocolSmoke {
  static func main() throws {
    try check(T3EvenG2Protocol.writeUUID.hasSuffix("5401"), "write UUID changed")
    try check(T3EvenG2Protocol.notifyUUID.hasSuffix("5402"), "notify UUID changed")
    try check(T3EvenG2Protocol.renderNotifyUUID.hasSuffix("6402"), "render UUID changed")
    try check(
      T3EvenG2Protocol.sessionPrelude == Data([
        0xAA, 0x21, 0x92, 0x13, 0x01, 0x01, 0x01, 0x20, 0x08, 0x02, 0x10, 0x9C,
        0x01, 0x22, 0x0A, 0x1A, 0x08, 0x12, 0x06, 0x12, 0x04, 0x08, 0x00, 0x10,
        0x00, 0xA1, 0x42,
      ]),
      "session prelude changed"
    )

    let crcFixture = T3EvenG2Protocol.frames(
      payload: Array("123456789".utf8),
      sequence: 0x44
    )
    try check(crcFixture.count == 1, "small payload fragmented")
    try check(
      [UInt8](crcFixture[0]) == [
        0xAA, 0x21, 0x44, 0x0B, 0x01, 0x01, 0xE0, 0x20,
        0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0xB1, 0x29,
      ],
      "CRC-16/CCITT-FALSE or frame envelope changed"
    )

    let fragmented = T3EvenG2Protocol.frames(
      payload: Array(repeating: 0x5A, count: 500),
      sequence: 0x45
    )
    try check(fragmented.count == 3, "500-byte payload should use three frames")
    for (index, frame) in fragmented.enumerated() {
      let bytes = [UInt8](frame)
      try check(bytes[2] == 0x45, "transport sequence must be shared across fragments")
      try check(bytes[4] == 3, "fragment count mismatch")
      try check(bytes[5] == UInt8(index + 1), "fragment index mismatch")
      try check(Int(bytes[3]) == bytes.count - 8, "chunk length mismatch")
    }

    try check(
      T3EvenG2Protocol.heartbeat(magic: 42) == [0x08, 0x0C, 0x10, 0x2A, 0x72, 0x00],
      "heartbeat payload changed"
    )
    try check(
      T3EvenG2Protocol.audioControl(enabled: true, magic: 42)
        == [0x08, 0x0F, 0x10, 0x2A, 0x92, 0x01, 0x02, 0x08, 0x01],
      "audio-start payload changed"
    )
    try check(
      T3EvenG2Protocol.audioControl(enabled: false, magic: 42)
        == [0x08, 0x0F, 0x10, 0x2A, 0x92, 0x01, 0x00],
      "audio-stop payload changed"
    )
    try check(
      T3EvenG2Protocol.shutdown(magic: 42) == [0x08, 0x09, 0x10, 0x2A, 0x5A, 0x00],
      "shutdown payload changed"
    )

    let click = packet(payload: [0x08, 0x02] + nested(13, nested(3, [0x10, 0x02])))
    let doubleClick = packet(
      payload: [0x08, 0x02] + nested(13, nested(3, [0x08, 0x03, 0x10, 0x02]))
    )
    let textScroll = packet(payload: [0x08, 0x02] + nested(13, nested(2, [0x18, 0x01])))
    let listScroll = packet(payload: [0x08, 0x02] + nested(13, nested(1, [0x28, 0x02])))
    try check(T3EvenG2Protocol.gesture(from: click)?.kind == "click", "ring click not decoded")
    try check(T3EvenG2Protocol.gesture(from: click)?.source == "ring", "ring source not decoded")
    try check(T3EvenG2Protocol.isDictationSource("ring"), "ring input source rejected")
    try check(T3EvenG2Protocol.isDictationSource("rightTemple"), "right temple input rejected")
    try check(T3EvenG2Protocol.isDictationSource("leftTemple"), "left temple input rejected")
    try check(!T3EvenG2Protocol.isDictationSource("unknown"), "unknown input source accepted")
    try check(
      T3EvenG2Protocol.lensPageOffset(for: "scrollDown") == 1,
      "swipe down should advance to the next lens page"
    )
    try check(
      T3EvenG2Protocol.lensPageOffset(for: "scrollUp") == -1,
      "swipe up should return to the previous lens page"
    )
    try check(
      T3EvenG2Protocol.lensPageOffset(for: "click") == nil,
      "tap should not move the lens page"
    )
    try check(
      T3EvenG2Protocol.gesture(from: doubleClick)?.kind == "doubleClick",
      "ring double-click not decoded"
    )
    try check(
      T3EvenG2Protocol.gesture(from: textScroll)?.kind == "scrollUp",
      "text gesture not decoded"
    )
    try check(
      T3EvenG2Protocol.gesture(from: listScroll)?.kind == "scrollDown",
      "list gesture not decoded"
    )
    try check(T3EvenG2Protocol.gesture(from: Data([0x00])) == nil, "bad frame accepted")
    let oversizedLength = Array(repeating: UInt8(0xFF), count: 8) + [0x7F]
    try check(
      T3EvenG2Protocol.gesture(from: packet(payload: [0x08, 0x02, 0x6A] + oversizedLength)) == nil,
      "overflowing field length accepted"
    )
    try check(
      T3EvenG2Protocol.gesture(from: packet(payload: [0x08, 0x02, 0x6A, 0x01])) == nil,
      "field extending beyond remaining bytes accepted"
    )

    let acknowledgement = Data([
      0xAA, 0x12, 0x09, 0x04, 0x01, 0x01, 0xE0, 0x20, 0x10, 0x2A, 0x00, 0x00,
    ])
    let ack = T3EvenG2Protocol.acknowledgement(from: acknowledgement)
    try check(ack?.service == 0xE0 && ack?.magic == 42, "valid ACK not decoded")
    try check(
      T3EvenG2Protocol.acknowledgement(from: Data(acknowledgement.dropLast(3))) == nil,
      "truncated ACK accepted"
    )

    let longText = String(repeating: "🙂", count: 300)
    let rebuild = T3EvenG2Protocol.rebuildText(longText, magic: 42)
    guard
      let rebuildBody = lengthDelimitedField(7, in: rebuild),
      let textObject = lengthDelimitedField(3, in: rebuildBody),
      let renderedBytes = lengthDelimitedField(12, in: textObject),
      let rendered = String(bytes: renderedBytes, encoding: .utf8)
    else {
      throw CheckFailure(description: "rebuild text payload could not be decoded")
    }
    try check(renderedBytes.count <= 900, "lens text exceeds the protocol cap")
    try check(rendered.hasSuffix("…"), "truncated lens text needs an ellipsis")
    try check(!rendered.contains("�"), "lens text split a Unicode scalar")

    let shortPages = T3EvenG2Protocol.lensTextPages("Short response")
    try check(shortPages == ["Short response"], "short response should stay on one lens page")
    let fullPage = (1...9).map { "Line \($0)" }.joined(separator: "\n")
    try check(
      T3EvenG2Protocol.lensTextPages(fullPage) == [fullPage],
      "single page must retain all nine content rows without a footer"
    )
    let overflowPages = T3EvenG2Protocol.lensTextPages(fullPage + "\nLine 10")
    try check(
      overflowPages == [
        (1...8).map { "Line \($0)" }.joined(separator: "\n") + "\n1/2 · swipe ↑↓",
        "Line 9\nLine 10\n2/2 · swipe ↑↓",
      ],
      "multi-page text must reserve its ninth row for the footer"
    )
    let pagedText = (1...30).map { "Line \($0): window scrolling response text" }.joined(separator: "\n")
    let pages = T3EvenG2Protocol.lensTextPages(pagedText)
    try check(pages.count > 1, "long response should create multiple lens pages")
    try check(
      pages.enumerated().allSatisfy { index, page in
        page.contains("\(index + 1)/\(pages.count) · swipe ↑↓")
      },
      "paged lens text needs position and swipe guidance"
    )
    try check(pages.allSatisfy { $0.utf8.count <= 900 }, "lens page exceeds protocol cap")
    try check(
      pages.allSatisfy { $0.components(separatedBy: "\n").count <= 9 },
      "lens page footer exceeds available rows"
    )
    let byteLimitedPages = T3EvenG2Protocol.lensTextPages(
      String(repeating: "🙂", count: 40), columns: 8, rows: 4, maxBytes: 64
    )
    try check(byteLimitedPages.count > 1, "byte limit should split lens pages")
    try check(
      byteLimitedPages.allSatisfy { $0.components(separatedBy: "\n").count <= 4 },
      "byte-limited pages must also reserve a footer row"
    )

    print("T3EvenG2Protocol smoke checks passed")
  }
}
