import ExpoModulesCore
import UIKit

/// Reports geometry in the observing view's coordinate space, including system
/// reservations that safe-area rectangles cannot represent, such as the fold.
final class T3LayoutMetricsView: ExpoView {
  let onMetricsChange = EventDispatcher()
  private var lastMetrics: NSDictionary?
  private var hasHinge: Bool? = false
  // A 180° rotation keeps size and safe area, so only the scene geometry announces it.
  private var geometryObservation: NSKeyValueObservation?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    registerForTraitChanges([UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self]) { (view: T3LayoutMetricsView, _: UITraitCollection) in
      view.publishMetrics()
    }
    // The hinge and vertical-bar APIs ship in the iOS 27.1 SDK, whose UIKit is 9127.0.85.
    // Xcode 27.0 has Swift 6.4 but the 27.0 SDK (UIKit 9127.0.84), so gate on the SDK.
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      hasHinge = nil
      addInteraction(UIHingeInteraction { [weak self] _, update in
        guard let self, self.window != nil else { return }
        // Capability survives temporary detachment and does not follow the hinge angle.
        let hasHinge = self.hasHinge == true || update.hinge != nil
        guard self.hasHinge != hasHinge else { return }
        self.hasHinge = hasHinge
        self.publishMetrics()
      })
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (view: T3LayoutMetricsView, _: UITraitCollection) in
        view.publishMetrics()
      }
    }
    #endif
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    lastMetrics = nil
    geometryObservation = window?.windowScene?.observe(\.effectiveGeometry) { [weak self] _, _ in
      DispatchQueue.main.async { self?.publishMetrics() }
    }
    assumeNoHingeIfSilent()
    publishMetrics()
  }

  /// UIKit only sends hinge updates on devices that have a hinge. Without this,
  /// an ordinary iPhone never publishes and the navigator never attaches.
  private func assumeNoHingeIfSilent() {
    guard window != nil, hasHinge == nil else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
      guard let self, self.window != nil, self.hasHinge == nil else { return }
      self.hasHinge = false
      self.publishMetrics()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    publishMetrics()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    publishMetrics()
  }

  private func publishMetrics() {
    guard let window, bounds.width > 0, bounds.height > 0, let hasHinge else { return }
    if hasHinge {
      T3WorkspaceOrientationSubscriber.allowHingeOrientations(in: window)
    }
    var verticalBarEdge = "none"
    var regions: [[String: Any]] = []
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      let rtl = effectiveUserInterfaceLayoutDirection == .rightToLeft
      switch traitCollection.verticalBarEdge {
      case .leading: verticalBarEdge = rtl ? "right" : "left"
      case .trailing: verticalBarEdge = rtl ? "left" : "right"
      default: break
      }
      for kind in [UIView.ReservedRegion.Kind.division, .occlusion] {
        for region in reservedRegions(kind: kind) where region.isActive {
          let frame = region.frame.intersection(bounds)
          guard !frame.isNull, !frame.isEmpty else { continue }
          regions.append([
            "kind": kind == .division ? "division" : "occlusion",
            "x": frame.minX, "y": frame.minY,
            "width": frame.width, "height": frame.height,
          ])
        }
      }
    }
    #endif
    let (sensorHousingEdge, safeArea) = housingAdjustedInsets(in: window)
    let metrics: [String: Any] = [
      "width": bounds.width, "height": bounds.height,
      "hasHinge": hasHinge,
      "horizontalSizeClass": traitCollection.horizontalSizeClass == .regular ? "regular" : "compact",
      "verticalBarEdge": verticalBarEdge,
      "sensorHousingEdge": sensorHousingEdge,
      "safeArea": [
        "top": safeAreaInsets.top, "bottom": safeAreaInsets.bottom,
        "left": safeArea.left, "right": safeArea.right,
      ],
      "reservedRegions": regions,
    ]
    let next = metrics as NSDictionary
    guard lastMetrics?.isEqual(next) != true else { return }
    lastMetrics = next
    onMetricsChange(metrics)
  }

  /// UIKit insets both sides of a landscape iPhone's window equally; only the top of the device
  /// holds the sensor housing. Interface landscapeRight puts the top of the device on the left.
  /// Content keeps clear of the housing and uses the full width on the other side, so only the
  /// window's symmetric inset comes off the opposite side. Any other reservation in this view's
  /// inset, such as a Duo's system rail, which never reaches the window's safe area, stays.
  private func housingAdjustedInsets(in window: UIWindow) -> (String, UIEdgeInsets) {
    var insets = safeAreaInsets
    let windowInsets = window.safeAreaInsets
    guard traitCollection.userInterfaceIdiom == .phone, windowInsets.left > 0,
      abs(windowInsets.left - windowInsets.right) < 0.5 else { return ("none", insets) }
    switch window.windowScene?.effectiveGeometry.interfaceOrientation {
    case .landscapeRight:
      insets.right = max(0, insets.right - windowInsets.right)
      return ("left", insets)
    case .landscapeLeft:
      insets.left = max(0, insets.left - windowInsets.left)
      return ("right", insets)
    default: return ("none", insets)
    }
  }
}
