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
    "naturalScrolling": UserDefaults.standard.object(forKey: "T3EvenG2NaturalScrolling") as? Bool ?? true,
  ]

  /// Registers the native module's events, lifecycle hooks, and JavaScript methods.
  public func definition() -> ModuleDefinition {
    Name("T3EvenG2")
    Events("onStatus", "onTranscript", "onThreadSelected", "onHistoryPosition", "onHistoryRequest")

    OnCreate {
      self.performOnMain { self.ensureAutoConnect() }
    }

    OnAppEntersForeground {
      self.performOnMain { self.ensureAutoConnect() }
    }

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

    Function("setNaturalScrolling") { (enabled: Bool) in
      self.performOnMain {
        guard #available(iOS 26.0, *) else { return }
        self.connection()?.setNaturalScrolling(enabled)
      }
    }

    Function("setReplyHistory") { (snapshot: [String: Any]) in
      self.performOnMain {
        guard #available(iOS 26.0, *) else { return }
        self.connection()?.setReplyHistory(snapshot)
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

    Function("resumeDisplay") {
      self.performOnMain {
        guard #available(iOS 26.0, *) else { return }
        self.connection()?.resumeDisplay()
      }
    }

    Function("setActiveThread") { (key: String, enabled: Bool) in
      self.performOnMain {
        guard #available(iOS 26.0, *) else { return }
        self.connection()?.setActiveThread(key, enabled: enabled)
      }
    }

    Function("setThreadChoices") { (choices: [[String: String]]) in
      self.performOnMain {
        guard #available(iOS 26.0, *) else { return }
        self.connection()?.setThreadChoices(choices)
      }
    }

    Function("setThreadActivity") { (key: String, text: String) in
      self.performOnMain {
        guard #available(iOS 26.0, *) else { return }
        self.connection()?.setThreadActivity(key, text: text)
      }
    }

    Function("showThreadPicker") {
      self.performOnMain {
        guard #available(iOS 26.0, *) else { return }
        self.connection()?.showThreadPicker()
      }
    }
  }

  /// Starts a connection only when the persisted auto-connect preference is enabled.
  private func ensureAutoConnect() {
    guard UserDefaults.standard.bool(forKey: "T3EvenG2AutoConnect") else { return }
    connectIfAvailable()
  }

  /// Persists auto-connect and connects immediately when enabling it on supported iOS.
  private func setAutoConnect(_ enabled: Bool) {
    UserDefaults.standard.set(enabled, forKey: "T3EvenG2AutoConnect")
    guard #available(iOS 26.0, *), let connection = connection() else { return }
    if enabled {
      connection.connect()
    }
    connection.onStatus?(connection.snapshot)
  }

  /// Requests connection when iOS 26 and the Even G2 connection API are available.
  private func connectIfAvailable() {
    guard #available(iOS 26.0, *), let connection = connection() else { return }
    connection.connect()
  }

  /// Requests disconnection when iOS 26 and the Even G2 connection API are available.
  private func disconnectIfAvailable() {
    guard #available(iOS 26.0, *), let connection = connection() else { return }
    connection.disconnect()
  }

  /// Runs an operation immediately on main or asynchronously dispatches it there.
  private func performOnMain(_ operation: @escaping () -> Void) {
    if Thread.isMainThread {
      operation()
    } else {
      DispatchQueue.main.async(execute: operation)
    }
  }

  @available(iOS 26.0, *)
  /// Lazily creates the connection and routes its callbacks into module events.
  private func connection() -> T3EvenG2Connection? {
    if let existing = connectionStorage as? T3EvenG2Connection {
      return existing
    }
    let connection = T3EvenG2Connection()
    connection.onStatus = { [weak self] body in self?.publishStatus(body) }
    connection.onTranscript = { [weak self] body in self?.sendEvent("onTranscript", body) }
    connection.onThreadSelected = { [weak self] body in self?.sendEvent("onThreadSelected", body) }
    connection.onHistoryPosition = { [weak self] body in self?.sendEvent("onHistoryPosition", body) }
    connection.onHistoryRequest = { [weak self] body in self?.sendEvent("onHistoryRequest", body) }
    connectionStorage = connection
    cacheStatus(connection.snapshot)
    return connection
  }

  /// Returns a live supported-iOS snapshot on main, otherwise the locked cache.
  private func statusSnapshot() -> [String: Any] {
    guard #available(iOS 26.0, *) else {
      return [
        "status": "unsupported",
        "detail": "Even G2 requires iOS 26 or later.",
        "connected": false,
        "listening": false,
        "autoConnect": false,
        "naturalScrolling": true,
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

  /// Caches a connection status update before emitting it to JavaScript.
  private func publishStatus(_ status: [String: Any]) {
    cacheStatus(status)
    sendEvent("onStatus", status)
  }

  /// Replaces the cached status under the lock used by off-main readers.
  private func cacheStatus(_ status: [String: Any]) {
    statusLock.lock()
    cachedStatus = status
    statusLock.unlock()
  }
}
