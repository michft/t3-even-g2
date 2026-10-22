import ExpoModulesCore
import UIKit

/// Respect iPad capture policy while allowing phone workspaces to rotate.
public final class T3WorkspaceOrientationSubscriber: ExpoAppDelegateSubscriber {
  private static let hingeWindows = NSHashTable<UIWindow>.weakObjects()

  static func allowHingeOrientations(in window: UIWindow) {
    guard !hingeWindows.contains(window) else { return }
    hingeWindows.add(window)
    window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
  }

  public func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
    if UIDevice.current.userInterfaceIdiom == .pad {
      // Keep iPad orientation policy, including portrait-only showcase captures.
      let orientations = Bundle.main.object(forInfoDictionaryKey: "UISupportedInterfaceOrientations~ipad") as? [String] ?? []
      return orientations == ["UIInterfaceOrientationPortrait"] ? .portrait : .all
    }
    return .allButUpsideDown
  }
}
