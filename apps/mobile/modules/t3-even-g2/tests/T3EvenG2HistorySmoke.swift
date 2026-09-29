import Foundation

private struct HistoryCheckFailure: Error, CustomStringConvertible {
  let description: String
}

/// Throws a labeled failure when a history smoke-check condition is false.
private func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw HistoryCheckFailure(description: message) }
}

/// Builds a server snapshot with defaults suited to a complete local reply window.
private func snapshot(
  _ replies: [T3EvenG2History.Reply],
  startIndex: Int = 0,
  total: Int? = nil,
  hasOlder: Bool = false,
  hasNewer: Bool = false,
  latestID: String? = nil,
  loading: Bool = false
) -> T3EvenG2History.Snapshot {
  T3EvenG2History.Snapshot(
    replies: replies,
    startIndex: startIndex,
    totalReplies: total ?? startIndex + replies.count,
    hasOlder: hasOlder,
    hasNewer: hasNewer,
    latestReplyID: latestID ?? replies.last?.id,
    loading: loading
  )
}

@main
private struct T3EvenG2HistorySmoke {
  /// Checks selection anchoring, bounded paging, loading, and rendered text limits.
  static func main() throws {
    let first = T3EvenG2History.Reply(id: "a", text: "First reply", prompt: "Explain")
    let second = T3EvenG2History.Reply(id: "b", text: "Second reply")
    let third = T3EvenG2History.Reply(id: "c", text: "Third reply")
    var history = T3EvenG2History()
    history.updateSnapshot(snapshot([first, second], latestID: "b"))
    try check(history.currentID == "b" && history.pageIndex == 0, "initial selection must be latest reply page zero")
    var ordered = T3EvenG2History()
    ordered.updateSnapshot(snapshot([first, second], latestID: "a"))
    try check(ordered.currentID == "a", "initial selection should honor the reported latest reply id")

    history.updateSnapshot(snapshot([first, second, third], latestID: "c"))
    try check(history.currentID == "b" && history.isNewReplyAvailable, "new reply must not move the browsing cursor")
    try check(history.text.contains(" · New"), "new reply indicator must stay in the footer")
    try check(footer(history.text).count <= 46, "reply footer must fit one 46-character lens row")
    try check(history.jumpToLatest() == nil && history.currentID == "c", "jump to latest must select a loaded reply")

    history.updateSnapshot(snapshot([T3EvenG2History.Reply(id: "x", text: "Prepended"), first, second, third], latestID: "c"))
    try check(history.currentID == "c", "prepending history must preserve the selected reply")
    _ = history.move(-1)
    try check(history.currentID == "b", "backward movement should select the preceding reply")
    history.updateSnapshot(snapshot([first, third], total: 3, latestID: "c"))
    try check(history.currentID == "c", "deleting the selected reply should choose the nearest old index")

    let longText = String(repeating: "🙂abc ", count: 900) + "END-OF-REPLY"
    var paged = T3EvenG2History()
    paged.updateSnapshot(snapshot([T3EvenG2History.Reply(id: "long", text: longText, prompt: String(repeating: "🙂", count: 80))]))
    try check(paged.text.contains("Prompt:"), "reply prompt should appear in the bounded header")
    try check(paged.text.utf8.count <= 810, "rendered reply must fit the reserved protocol byte budget")
    try check(paged.text.components(separatedBy: "\n").count <= 9, "reply must fit the lens row limit")
    try check(paged.move(1) == nil && paged.positionDescription.contains("page 2/"), "scroll should advance within a reply")
    let streamingPage = paged.positionDescription
    paged.updateSnapshot(snapshot([T3EvenG2History.Reply(id: "long", text: longText + "more")]))
    try check(paged.positionDescription == streamingPage, "streaming text should retain the selected reply page")
    let pageOne = paged.text
    while !paged.text.contains(" · Latest") {
      try check(paged.text.utf8.count <= 810, "every reply page must fit the reserved byte budget")
      try check(paged.text.components(separatedBy: "\n").count <= 9, "every reply page must fit the lens row limit")
      try check(footer(paged.text).count <= 46, "every reply footer must fit one lens row")
      try check(footer(paged.text).utf8.count <= 100, "every reply footer must fit its byte budget")
      try check(!paged.text.contains("�"), "pagination must not split Unicode characters")
      _ = paged.move(1)
    }
    try check(paged.text.contains(" · Latest"), "last loaded page should identify the latest boundary")
    try check(paged.text.contains("END-OF-REPLY"), "pagination should retain the end of the full reply")
    let lastPosition = paged.positionDescription
    _ = paged.move(1)
    try check(paged.positionDescription == lastPosition, "page movement should clamp at the latest end")
    try check(!paged.text.contains("�"), "pagination must not split Unicode characters")
    try check(!pageOne.isEmpty, "streaming page should remain renderable")

    var bounded = T3EvenG2History()
    let many = (0..<30).map { T3EvenG2History.Reply(id: "r\($0)", text: "Reply \($0)") }
    bounded.updateSnapshot(snapshot(many, total: 30, hasOlder: true, latestID: "r29"))
    try check(bounded.currentID == "r29" && bounded.positionDescription.hasPrefix("Reply 30/30"), "oversized window should retain the latest suffix")
    for _ in 0..<19 { _ = bounded.move(-1) }
    try check(bounded.positionDescription.hasPrefix("Reply 11/30"), "twenty-entry window should retain global offsets")
    try check(bounded.move(-1) == -1, "loaded-window edge should request older replies")
    try check(bounded.text.contains(" · Older"), "older window edge should be visible in footer")
    try check(bounded.jumpToLatest() == nil && bounded.currentID == "r29", "jump to loaded latest reply should clear pending direction")

    bounded.updateSnapshot(snapshot([many[10], many[11]], startIndex: 10, total: 30, hasOlder: true, hasNewer: true, latestID: "r29"))
    try check(bounded.move(1) == 1 && bounded.currentID == "r11", "newer window edge should request data without moving cursor")
    let beforeLatestRequest = bounded.currentID
    try check(bounded.jumpToLatest() == 1, "jump to an unloaded latest reply should request a newer window")
    try check(bounded.currentID == beforeLatestRequest, "unloaded jump request should preserve the current cursor")

    var empty = T3EvenG2History()
    empty.updateSnapshot(snapshot([], hasOlder: true, hasNewer: true, loading: true))
    try check(empty.text.contains("Loading replies"), "empty loading state should explain that history is loading")
    try check(empty.move(-1) == -1 && empty.move(1) == 1, "empty window edges should request available history")
    empty.updateSnapshot(snapshot([]))
    try check(empty.text.contains("No replies available"), "empty settled state should explain the empty history")

    let familyEmoji = "👨‍👩‍👧‍👦"
    let emojiPages = T3EvenG2Protocol.lensTextPages(
      String(repeating: familyEmoji, count: 80),
      columns: 46,
      rows: 7,
      maxBytes: 580,
      includeFooter: false
    )
    try check(!emojiPages.isEmpty, "family emoji text should paginate")
    for page in emojiPages {
      try check(page.utf8.count <= 580, "emoji page must fit the UTF-8 byte budget")
      for line in page.components(separatedBy: "\n") {
        try check(line.count <= 46 && line.utf8.count <= 580, "emoji line must fit both display limits")
      }
    }

    print("T3EvenG2History smoke checks passed")
  }
}

/// Returns the final display row from a rendered history page.
private func footer(_ page: String) -> String {
  page.components(separatedBy: "\n").last ?? ""
}
