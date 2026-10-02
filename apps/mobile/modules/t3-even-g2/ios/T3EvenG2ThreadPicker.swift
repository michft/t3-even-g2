import Foundation

struct T3EvenG2ThreadPicker {
  struct Choice: Equatable {
    let key: String
    let title: String
    let subtitle: String
    var isLatestOutput = false
  }

  private(set) var choices: [Choice] = []
  private(set) var index = 0
  var isPresented = true
  var openingKey: String?

  /// The currently selected choice, or nil when the list is empty.
  var highlighted: Choice? {
    choices.indices.contains(index) ? choices[index] : nil
  }

  /// Replaces choices while preserving the highlighted key or clamping the index.
  mutating func update(_ next: [Choice]) {
    let previous = highlighted
    choices = next
    index = next.firstIndex(where: {
      $0.key == previous?.key && $0.isLatestOutput == previous?.isLatestOutput
    }) ?? min(index, max(0, next.count - 1))
    if let openingKey, !next.contains(where: { $0.key == openingKey }) {
      self.openingKey = nil
    }
  }

  /// Moves the selection by an offset, clamped to available choices.
  mutating func move(_ offset: Int) {
    guard openingKey == nil else { return }
    index = min(max(0, index + offset), max(0, choices.count - 1))
  }

  /// Selects a matching choice key and leaves the selection unchanged if absent.
  mutating func highlight(_ key: String) {
    if let next = choices.firstIndex(where: { $0.key == key && !$0.isLatestOutput }) { index = next }
  }

  /// Highlights the current thread's Latest action when that shortcut is available.
  mutating func highlightLatestOutput() {
    if let next = choices.firstIndex(where: \.isLatestOutput) { index = next }
  }

  /// Shows a three-choice window while reserving lens rows for context and controls.
  var text: String {
    guard let highlighted else {
      return "T3 threads\n\nNo threads available\n\nConnect an environment in T3"
    }
    let start = min(max(0, index - 1), max(0, choices.count - 3))
    let end = min(choices.count, start + 3)
    let rows = (start..<end).map { position in
      "\(position == index ? "> " : "  ")\(label(choices[position].title, columns: 44))"
    }.joined(separator: "\n")
    let subtitle = label(highlighted.subtitle, columns: 46)
    let controls = choices.count > 1
      ? "R1 swipe: choose · Tap: open\nL arm tap: back" : "Tap to open · L arm tap: back"
    let instruction = openingKey == nil ? controls : "Opening thread…"
    let threadChoices = choices.filter { !$0.isLatestOutput }
    let threadIndex = threadChoices.firstIndex(where: { $0.key == highlighted.key }) ?? 0
    let heading = highlighted.isLatestOutput ? "T3 quick action" : "T3 threads \(threadIndex + 1)/\(threadChoices.count)"
    return "\(heading)\n\n\(rows)\n\(subtitle)\n\n\(instruction)"
  }

  /// Keeps each label on one row and reserves a byte budget for the rest of the menu.
  private func label(_ text: String, columns: Int) -> String {
    let singleLine = text.components(separatedBy: .whitespacesAndNewlines)
      .filter { !$0.isEmpty }.joined(separator: " ")
    return T3EvenG2Protocol.limitedUTF8(String(singleLine.prefix(columns)), maxBytes: 180)
  }
}
