export interface ReservedRegion {
  readonly kind: "division" | "occlusion";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NativeLayoutMetrics {
  readonly width: number;
  readonly height: number;
  readonly hasHinge?: boolean;
  readonly horizontalSizeClass: "compact" | "regular";
  readonly verticalBarEdge: "none" | "left" | "right";
  /**
   * iOS: the side holding a landscape iPhone's sensor housing; absent on other platforms. When
   * set, `safeArea` already omits the window's symmetric inset on the opposite side.
   */
  readonly sensorHousingEdge?: "none" | "left" | "right";
  readonly safeArea: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  };
  readonly reservedRegions: ReadonlyArray<ReservedRegion>;
}

/**
 * Sides whose safe area insets column content. UIKit insets both sides of a landscape iPhone
 * equally, but only the sensor housing needs avoiding, so the other side uses the full width.
 */
export function horizontalSafeAreaEdges(metrics: NativeLayoutMetrics | null): ("left" | "right")[] {
  const edge = metrics?.sensorHousingEdge;
  return edge === "left" || edge === "right" ? [edge] : ["left", "right"];
}

export function deriveBottomControlInsets(metrics: NativeLayoutMetrics | null) {
  if (!metrics) return { left: 0, right: 0, bottom: 0 };
  let left = metrics.safeArea.left;
  let right = metrics.width - metrics.safeArea.right;
  let bottom = metrics.height;
  for (const region of metrics.reservedRegions) {
    const x = Math.max(left, region.x);
    const endX = Math.min(right, region.x + region.width);
    const y = Math.max(0, region.y);
    const endY = Math.min(bottom, region.y + region.height);
    if (endX <= x || endY <= y) continue;
    if (region.kind === "division" && region.height >= metrics.height / 2) {
      if (right - endX >= x - left) left = endX;
      else right = x;
    } else if (endY >= bottom - metrics.safeArea.bottom) {
      if (region.width >= right - left) bottom = y;
      else if (right - endX >= x - left) left = endX;
      else right = x;
    }
  }
  return { left, right: metrics.width - right, bottom: metrics.height - bottom };
}
