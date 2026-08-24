import ExpoModulesCore
import Foundation

public final class T3EvenG2Module: Module {
  private var connectionStorage: AnyObject?
  private let statusLock = NSLock()
  private var cachedStatus: [String: Any] = [
    "status": "disconnected",
    "detail": "",
    "connected": false,
    "listening": false,
    "autoConnect": false,
  ]

  public func definition() -> ModuleDefinition {
    Name("T3EvenG2")
    Events("onStatus", "onTranscript", "onGesture")

    Function("getStatus") { () -> [String: Any] in
      self.statusSnapshot()
    }

    Function("ensureAutoConnect") {
      self.performOnMain {
        self.ensureAutoConnect()
      }
    }

    Function("setAutoConnect") { (enabled: Bool) in
      self.performOnMain {
        self.setAutoConnect(enabled)
      }
    }

    Function("connect") {
      self.performOnMain {
        self.connectIfAvailable()
      }
    }

    Function("disconnect") {
      self.performOnMain {
        self.disconnectIfAvailable()
      }
    }

    Function("displayText") { (text: String) in
      self.performOnMain {
        self.displayTextIfAvailable(text)
      }
    }

    Function("clearDisplay") {
      self.performOnMain {
        self.clearDisplayIfAvailable()
      }
    }

    Function("setInputEnabled") { (enabled: Bool) in
      self.performOnMain {
        self.setInputEnabledIfAvailable(enabled)
      }
    }

    AsyncFunction("beginDictation") { () async in
      guard #available(iOS 26.0, *), let connection = await self.mainConnection() else { return }
      await connection.beginDictation()
    }

    AsyncFunction("finishDictation") { () async in
      guard #available(iOS 26.0, *), let connection = await self.mainConnection() else { return }
      await connection.finishDictation()
    }

    AsyncFunction("cancelDictation") { () async in
      guard #available(iOS 26.0, *), let connection = await self.mainConnection() else { return }
      await connection.cancelDictation()
    }
  }

  private func ensureAutoConnect() {
    guard UserDefaults.standard.bool(forKey: "T3EvenG2AutoConnect") else { return }
    connectIfAvailable()
  }

  private func setAutoConnect(_ enabled: Bool) {
    UserDefaults.standard.set(enabled, forKey: "T3EvenG2AutoConnect")
    guard #available(iOS 26.0, *), let connection = connection() else { return }
    if enabled {
      connection.connect()
    }
    connection.onStatus?(connection.snapshot)
  }

  private func connectIfAvailable() {
    guard #available(iOS 26.0, *), let connection = connection() else { return }
    connection.connect()
  }

  private func disconnectIfAvailable() {
    guard #available(iOS 26.0, *), let connection = connection() else { return }
    connection.disconnect()
  }

  private func displayTextIfAvailable(_ text: String) {
    guard #available(iOS 26.0, *), let connection = connection() else { return }
    connection.displayText(text)
  }

  private func clearDisplayIfAvailable() {
    guard #available(iOS 26.0, *), let connection = connection() else { return }
    connection.clearDisplay()
  }

  private func setInputEnabledIfAvailable(_ enabled: Bool) {
    guard #available(iOS 26.0, *), let connection = connection() else { return }
    connection.setInputEnabled(enabled)
  }

  private func performOnMain(_ operation: @escaping () -> Void) {
    if Thread.isMainThread {
      operation()
    } else {
      DispatchQueue.main.async(execute: operation)
    }
  }

  @MainActor
  @available(iOS 26.0, *)
  private func mainConnection() -> T3EvenG2Connection? {
    connection()
  }

  @available(iOS 26.0, *)
  private func connection() -> T3EvenG2Connection? {
    if let existing = connectionStorage as? T3EvenG2Connection {
      return existing
    }
    let connection = T3EvenG2Connection()
    connection.onStatus = { [weak self] body in self?.publishStatus(body) }
    connection.onTranscript = { [weak self] body in self?.sendEvent("onTranscript", body) }
    connection.onGesture = { [weak self] body in self?.sendEvent("onGesture", body) }
    connectionStorage = connection
    cacheStatus(connection.snapshot)
    return connection
  }

  private func statusSnapshot() -> [String: Any] {
    guard #available(iOS 26.0, *) else {
      return [
        "status": "unsupported",
        "detail": "Even G2 requires iOS 26 or later.",
        "connected": false,
        "listening": false,
        "autoConnect": false,
      ]
    }
    if Thread.isMainThread, let connection = connectionStorage as? T3EvenG2Connection {
      let snapshot = connection.snapshot
      cacheStatus(snapshot)
      return snapshot
    }
    statusLock.lock()
    defer { statusLock.unlock() }
    return cachedStatus
  }

  private func publishStatus(_ status: [String: Any]) {
    cacheStatus(status)
    sendEvent("onStatus", status)
  }

  private func cacheStatus(_ status: [String: Any]) {
    statusLock.lock()
    cachedStatus = status
    statusLock.unlock()
  }
}
