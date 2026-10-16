import Foundation

/// Holds reply-history windows for recently used threads in this app session.
struct T3EvenG2HistoryStore {
  private static let capacity = 8

  private var byThread: [String: T3EvenG2History] = [:]
  private var recency: [String] = []

  /// Returns the cached window for a thread without changing its recency.
  subscript(key: String) -> T3EvenG2History? {
    byThread[key]
  }

  /// Saves a thread window as most recent, evicting the least recently stored beyond eight.
  mutating func store(_ history: T3EvenG2History, for key: String) {
    byThread[key] = history
    recency.removeAll { $0 == key }
    recency.append(key)
    while recency.count > Self.capacity {
      byThread.removeValue(forKey: recency.removeFirst())
    }
  }
}

extension T3EvenG2History {
  /// Completes a requested move without skipping a newly selected replacement or first reply.
  mutating func completeRequestedMove(from previousID: String?, direction: String) -> Int? {
    if direction == "latest" { return jumpToLatest() }
    if previousID != nil, currentID == previousID {
      return move(direction == "older" ? -1 : 1)
    }
    return currentID == nil ? -1 : nil
  }
}
