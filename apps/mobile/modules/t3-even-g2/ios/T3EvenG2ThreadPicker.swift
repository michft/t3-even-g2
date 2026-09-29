import Foundation

struct T3EvenG2ThreadPicker {
  struct Choice: Equatable {
    let key: String
    let title: String
    let subtitle: String
  }

  private(set) var choices: [Choice] = []
  private(set) var index = 0
  var isPresented = true
  var openingKey: String?

  var highlighted: Choice? {
    choices.indices.contains(index) ? choices[index] : nil
  }

  mutating func update(_ next: [Choice]) {
    let key = highlighted?.key
    choices = next
    index = next.firstIndex(where: { $0.key == key }) ?? min(index, max(0, next.count - 1))
    if let openingKey, !next.contains(where: { $0.key == openingKey }) {
      self.openingKey = nil
    }
  }

  mutating func move(_ offset: Int) {
    guard openingKey == nil else { return }
    index = min(max(0, index + offset), max(0, choices.count - 1))
  }

  mutating func highlight(_ key: String) {
    if let next = choices.firstIndex(where: { $0.key == key }) { index = next }
  }

  var text: String {
    guard let highlighted else {
      return "T3 threads\n\nNo threads available\n\nConnect an environment in T3"
    }
    // Reserve the title's own rows so long names cannot hide picker controls.
    let title = String(highlighted.title.replacingOccurrences(of: "\n", with: " ").prefix(92))
    let subtitle = String(highlighted.subtitle.replacingOccurrences(of: "\n", with: " ").prefix(46))
    let controls = choices.count > 1
      ? "Swipe to choose · Tap to open\nLong-press: back" : "Tap to open · Swipe up: back"
    let instruction = openingKey == nil ? controls : "Opening thread…"
    return "T3 threads \(index + 1)/\(choices.count)\n\n\(title)\n\(subtitle)\n\n\(instruction)"
  }
}
