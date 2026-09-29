import Foundation

struct T3EvenG2History {
  struct Reply: Equatable {
    let id: String
    var text: String
    var prompt: String

    /// Creates one stable reply entry and its optional originating prompt.
    init(id: String, text: String, prompt: String = "") {
      self.id = id
      self.text = text
      self.prompt = prompt
    }
  }

  struct Snapshot {
    let replies: [Reply]
    let startIndex: Int
    let totalReplies: Int
    let hasOlder: Bool
    let hasNewer: Bool
    let latestReplyID: String?
    let loading: Bool
  }

  private struct CachedPages {
    let body: String
    let pages: [String]
  }

  private struct BoundedWindow {
    let replies: [Reply]
    let droppedBefore: Int
    let droppedAfter: Int
  }

  private static let maximumWindowSize = 20
  private static let bodyRows = 7
  private static let bodyMaxBytes = 580
  private static let headerMaxBytes = 128
  private static let footerMaxBytes = 100
  private static let footerMaxCharacters = 46

  private var replies: [Reply] = []
  private var startIndex = 0
  private var totalReplies = 0
  private var hasOlder = false
  private var hasNewer = false
  private(set) var latestReplyID: String?
  private var loading = false
  private var pageCache: [String: CachedPages] = [:]

  private(set) var currentID: String?
  private(set) var pageIndex = 0

  /// Replaces the loaded window while retaining the selected reply and page where possible.
  mutating func updateSnapshot(_ snapshot: Snapshot) {
    let previousID = currentID
    let previousPage = pageIndex
    let previousGlobalIndex = currentID.flatMap { id in
      replies.firstIndex(where: { $0.id == id }).map { startIndex + $0 }
    }
    let bounded = boundedReplies(snapshot.replies, preserving: previousID)
    replies = bounded.replies
    startIndex = max(0, snapshot.startIndex + bounded.droppedBefore)
    totalReplies = max(startIndex + replies.count, max(0, snapshot.totalReplies))
    hasOlder = snapshot.hasOlder || bounded.droppedBefore > 0
    hasNewer = snapshot.hasNewer || bounded.droppedAfter > 0
    latestReplyID = snapshot.latestReplyID.flatMap { $0.isEmpty ? nil : $0 }
    loading = snapshot.loading
    refreshPageCache()

    guard !replies.isEmpty else {
      currentID = nil
      pageIndex = 0
      return
    }

    if let previousID, let index = replies.firstIndex(where: { $0.id == previousID }) {
      currentID = previousID
      pageIndex = min(previousPage, pages(for: replies[index]).count - 1)
      return
    }

    let selectedIndex: Int
    if let previousGlobalIndex {
      selectedIndex = min(max(previousGlobalIndex - startIndex, 0), replies.count - 1)
    } else if let latestReplyID, let latestIndex = replies.firstIndex(where: { $0.id == latestReplyID }) {
      selectedIndex = latestIndex
    } else {
      selectedIndex = replies.count - 1
    }
    currentID = replies[selectedIndex].id
    pageIndex = min(previousPage, pages(for: replies[selectedIndex]).count - 1)
  }

  /// Moves one page or reply; returns a direction only when an unloaded window can satisfy it.
  @discardableResult
  mutating func move(_ direction: Int) -> Int? {
    guard direction != 0 else { return nil }
    guard let replyIndex = selectedReplyIndex else { return unloadedWindowDirection(for: direction) }
    return direction < 0 ? moveBackward(from: replyIndex) : moveForward(from: replyIndex)
  }

  /// Selects the latest reply if loaded, or returns a newer-window request direction.
  @discardableResult
  mutating func jumpToLatest() -> Int? {
    if let latestReplyID, let index = replies.firstIndex(where: { $0.id == latestReplyID }) {
      currentID = replies[index].id
      pageIndex = 0
      return nil
    }
    if hasNewer { return 1 }
    guard let latest = replies.last else { return nil }
    currentID = latest.id
    pageIndex = 0
    return nil
  }

  /// True when the server's latest reply is different from the reply being viewed.
  var isNewReplyAvailable: Bool {
    latestReplyID != nil && latestReplyID != currentID
  }

  /// Describes the selected reply and page using one-based display numbers.
  var positionDescription: String {
    guard let index = selectedReplyIndex else { return loading ? "Loading replies…" : "No replies" }
    return "Reply \(startIndex + index + 1)/\(totalReplies) · page \(pageIndex + 1)/\(pages(for: replies[index]).count)"
  }

  /// Renders one bounded lens page with a prompt header and a single status footer.
  var text: String {
    guard let index = selectedReplyIndex else {
      return loading ? "T3 replies\n\nLoading replies…" : "T3 replies\n\nNo replies available"
    }
    let reply = replies[index]
    let bodyPages = pages(for: reply)
    let page = bodyPages[min(pageIndex, bodyPages.count - 1)]
    let header = promptHeader(reply.prompt)
    let footer = limitedUTF8(footerText(for: index, pageCount: bodyPages.count), maxBytes: Self.footerMaxBytes)
    return "\(header)\n\(page)\n\(footer)"
  }

  /// Finds the loaded reply selected by the stable cursor identifier.
  private var selectedReplyIndex: Int? {
    guard let currentID else { return nil }
    return replies.firstIndex(where: { $0.id == currentID })
  }

  /// Returns cached pages for a reply, with a safe single-page fallback.
  private func pages(for reply: Reply) -> [String] {
    pageCache[reply.id]?.pages ?? [reply.text]
  }

  /// Moves to the previous page or reply, requesting an older window at its edge.
  private mutating func moveBackward(from replyIndex: Int) -> Int? {
    if pageIndex > 0 {
      pageIndex -= 1
    } else if replyIndex > 0 {
      let previous = replies[replyIndex - 1]
      currentID = previous.id
      pageIndex = pages(for: previous).count - 1
    } else if hasOlder {
      return -1
    }
    return nil
  }

  /// Moves to the next page or reply, requesting a newer window at its edge.
  private mutating func moveForward(from replyIndex: Int) -> Int? {
    if pageIndex + 1 < pages(for: replies[replyIndex]).count {
      pageIndex += 1
    } else if replyIndex + 1 < replies.count {
      currentID = replies[replyIndex + 1].id
      pageIndex = 0
    } else if hasNewer {
      return 1
    }
    return nil
  }

  /// Returns a load direction only when an empty loaded window has more history.
  private func unloadedWindowDirection(for direction: Int) -> Int? {
    if direction < 0, hasOlder { return -1 }
    if direction > 0, hasNewer { return 1 }
    return nil
  }

  /// Rebuilds only changed reply pages and drops cache entries outside the loaded window.
  private mutating func refreshPageCache() {
    let currentIDs = Set(replies.map(\.id))
    pageCache = pageCache.filter { currentIDs.contains($0.key) }
    for reply in replies {
      let body = reply.text
      if pageCache[reply.id]?.body != body {
        pageCache[reply.id] = CachedPages(
          body: body,
          pages: T3EvenG2Protocol.lensTextPages(
            body,
            rows: Self.bodyRows,
            maxBytes: Self.bodyMaxBytes,
            includeFooter: false
          )
        )
      }
    }
  }

  /// Caps an incoming window at 20 replies while retaining its selected ID when present.
  private func boundedReplies(_ incoming: [Reply], preserving id: String?) -> BoundedWindow {
    var seen = Set<String>()
    let unique = incoming.filter { !$0.id.isEmpty && seen.insert($0.id).inserted }
    guard unique.count > Self.maximumWindowSize else {
      return BoundedWindow(replies: unique, droppedBefore: 0, droppedAfter: 0)
    }
    let anchor = id.flatMap { key in unique.firstIndex(where: { $0.id == key }) }
    let first = min(
      max((anchor ?? unique.count - 1) - Self.maximumWindowSize / 2, 0),
      unique.count - Self.maximumWindowSize
    )
    let last = first + Self.maximumWindowSize
    return BoundedWindow(
      replies: Array(unique[first..<last]),
      droppedBefore: first,
      droppedAfter: unique.count - last
    )
  }

  /// Flattens and bounds a prompt label to one display line.
  private func promptHeader(_ prompt: String) -> String {
    let oneLine = prompt
      .replacingOccurrences(of: "\r\n", with: " ")
      .replacingOccurrences(of: "\n", with: " ")
      .replacingOccurrences(of: "\r", with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !oneLine.isEmpty else { return "T3 reply" }
    var header = String("Prompt: \(oneLine)".prefix(46))
    while header.utf8.count > Self.headerMaxBytes { header.removeLast() }
    return header
  }

  /// Builds a compact one-line position and state footer for the current reply page.
  private func footerText(for index: Int, pageCount: Int) -> String {
    let replyNumber = compactNumber(startIndex + index + 1)
    let total = compactNumber(totalReplies)
    let page = compactNumber(pageIndex + 1)
    let pages = compactNumber(pageCount)
    let fullPosition = "Reply \(replyNumber)/\(total) · page \(page)/\(pages)"
    let compactPosition = "R \(replyNumber)/\(total) · \(page)/\(pages)"
    let atFirstPage = pageIndex == 0
    let atLastPage = pageIndex + 1 >= pageCount
    var markers: [String] = []
    if isNewReplyAvailable { markers.append(" · Back,tap: Latest") }
    if index == 0, atFirstPage { markers.append(hasOlder ? " · Older" : " · Oldest") }
    if index == replies.count - 1, atLastPage { markers.append(hasNewer ? " · Newer" : " · Latest") }
    if isNewReplyAvailable { markers.append(" · New") }
    if loading { markers.append(" · Load") }

    var best = fullPosition
    var bestMarkerCount = -1
    for base in [fullPosition, compactPosition] {
      var footer = base
      var markerCount = 0
      for marker in markers {
        let candidate = footer + marker
        guard candidate.count <= Self.footerMaxCharacters, candidate.utf8.count <= Self.footerMaxBytes else {
          continue
        }
        footer = candidate
        markerCount += 1
      }
      if markerCount > bestMarkerCount {
        best = footer
        bestMarkerCount = markerCount
      }
      if markerCount == markers.count { return footer }
    }
    return limitedUTF8(best, maxBytes: Self.footerMaxBytes, maxCharacters: Self.footerMaxCharacters)
  }

  /// Shortens display metadata without splitting a Unicode character.
  private func limitedUTF8(_ text: String, maxBytes: Int, maxCharacters: Int = .max) -> String {
    var result = ""
    for character in text {
      let candidate = result + String(character)
      guard candidate.utf8.count <= maxBytes, candidate.count <= maxCharacters else { break }
      result = candidate
    }
    return result
  }

  /// Abbreviates large indices so status markers fit on the lens footer row.
  private func compactNumber(_ value: Int) -> String {
    let number = max(0, value)
    guard number >= 10_000 else { return String(number) }
    let units: [(Int, String)] = [
      (1_000, "k"), (1_000_000, "M"), (1_000_000_000, "B"),
      (1_000_000_000_000, "T"), (1_000_000_000_000_000, "P"),
      (1_000_000_000_000_000_000, "E"),
    ]
    guard let (scale, suffix) = units.last(where: { number >= $0.0 }) else { return String(number) }
    let whole = number / scale
    let decimal = (number % scale) / (scale / 10)
    return "\(whole).\(decimal)\(suffix)"
  }
}
