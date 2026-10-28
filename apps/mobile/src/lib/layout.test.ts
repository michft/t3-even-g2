import { describe, expect, it } from "vite-plus/test";

import {
  alignListPaneToHinge,
  resolveListPaneContentWidth,
  deriveLayout,
  deriveThreadFeedInitialContentInset,
  deriveThreadWorkLogSizing,
  deriveWorkspacePaneLayout,
  isPrimarySidebarPinned,
  rootSheetPresentsAsCard,
} from "./layout";

describe("iPhone landscape workspace", () => {
  const metrics = {
    width: 874,
    height: 402,
    horizontalSizeClass: "compact" as const,
    verticalBarEdge: "none" as const,
    safeArea: { top: 0, bottom: 21, left: 62, right: 62 },
    reservedRegions: [],
  };

  it("shows the thread sidebar when landscape has room despite compact UIKit size class", () => {
    expect(deriveLayout({ ...metrics, nativeMetrics: metrics }).usesSplitView).toBe(true);
    expect(
      deriveLayout({ ...metrics, width: 402, height: 874, nativeMetrics: metrics }).usesSplitView,
    ).toBe(false);
  });

  it("shows the sidebar on smaller landscape iPhones, like a small iPad", () => {
    const zoomed = {
      ...metrics,
      width: 812,
      height: 375,
      safeArea: { ...metrics.safeArea, left: 50, right: 50 },
    };
    expect(deriveLayout({ ...zoomed, nativeMetrics: zoomed }).usesSplitView).toBe(true);
    const homeButton = {
      ...metrics,
      width: 667,
      height: 375,
      safeArea: { top: 0, bottom: 0, left: 0, right: 0 },
    };
    expect(deriveLayout({ ...homeButton, nativeMetrics: homeButton }).usesSplitView).toBe(true);
  });

  it("keeps short landscape iPad windows on the tablet width floor", () => {
    const short = (width: number) => {
      const window = {
        ...metrics,
        width,
        height: 500,
        safeArea: { top: 0, bottom: 0, left: 0, right: 0 },
      };
      return deriveLayout({ ...window, nativeMetrics: window, isPad: true }).usesSplitView;
    };
    expect(short(640)).toBe(false);
    expect(short(800)).toBe(true);
  });

  it("keeps windows too narrow for both columns and non-iOS short windows compact", () => {
    expect(deriveLayout({ ...metrics, width: 640, nativeMetrics: metrics }).usesSplitView).toBe(
      false,
    );
    expect(deriveLayout({ width: 874, height: 402 }).usesSplitView).toBe(false);
  });
});

describe("thread work-log text sizing", () => {
  it.each([
    { baseFontSize: 16, fontScale: 1.25, estimatedRowHeight: 28 },
    { baseFontSize: 22, fontScale: 2, estimatedRowHeight: 52 },
  ])(
    "measures accessibility text instead of locking it to the estimate: %j",
    ({ estimatedRowHeight, ...settings }) => {
      expect(deriveThreadWorkLogSizing(settings)).toMatchObject({
        estimatedRowHeight,
        fixedRowHeight: undefined,
      });
    },
  );

  it("invalidates native text measurements even when the minimum row height is unchanged", () => {
    const original = deriveThreadWorkLogSizing({ baseFontSize: 16, fontScale: 1 });
    for (const settings of [
      { baseFontSize: 16, fontScale: 1.1 },
      { baseFontSize: 17, fontScale: 1 },
    ]) {
      const resized = deriveThreadWorkLogSizing(settings);
      expect(resized.estimatedRowHeight).toBe(original.estimatedRowHeight);
      expect(resized.textSizeKey).not.toBe(original.textSizeKey);
    }
  });
});

describe("deriveThreadFeedInitialContentInset", () => {
  // regression: #5585 land the first thread open above the composer on Android
  it("does not double native iOS insets", () => {
    expect(
      deriveThreadFeedInitialContentInset({
        platform: "ios",
        usesNativeAutomaticInsets: true,
        bottomContentInset: 174,
      }),
    ).toBeUndefined();
  });
});

describe("isPrimarySidebarPinned", () => {
  // regression: #20406 sidebar toggle works on iPad and iPhone Duo
  it("keeps compact native roots pinned so search cannot hide the sidebar for a later split", () => {
    expect(
      isPrimarySidebarPinned({ pathname: "/", nativeWorkspace: true, usesSplitView: false }),
    ).toBe(true);
  });
});

describe("deriveWorkspacePaneLayout", () => {
  it("keeps an explicitly hidden thread sidebar hidden when the file inspector is visible", () => {
    const layout = deriveLayout({ width: 1_024, height: 1_366 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_024,
        primarySidebarPreferredVisible: false,
        auxiliaryPanePreferredVisible: true,
        auxiliaryPaneRole: "inspector",
      }),
    ).toMatchObject({
      primarySidebarVisible: false,
      primarySidebarSuppressedByAuxiliary: false,
      auxiliaryPaneVisible: true,
    });
  });
});

describe("alignListPaneToHinge", () => {
  const layout = deriveLayout({ width: 852, height: 880 });

  it("keeps the default split when either side of the hinge would be too narrow", () => {
    const narrowList = {
      layout,
      hinge: { x: 300, width: 0 },
      viewportWidth: 852,
      leadingWidth: 96,
    };
    const narrowDetail = {
      layout,
      hinge: { x: 600, width: 0 },
      viewportWidth: 852,
      leadingWidth: 0,
    };
    expect(alignListPaneToHinge(narrowList)).toBe(layout);
    expect(alignListPaneToHinge(narrowDetail)).toBe(layout);
  });
});

describe("root sheet presentation", () => {
  it("keeps a shown Settings or New Task presentation when the layout changes", () => {
    // Opened in portrait as a sheet, then the phone rotates into the sidebar layout.
    const shown = new Map([["settings-1", false]]);
    expect(rootSheetPresentsAsCard(shown, "settings-1", true)).toBe(false);
    // An opening not yet shown follows the current layout.
    expect(rootSheetPresentsAsCard(shown, "settings-2", true)).toBe(true);
  });
});

describe("sidebar content width after rotation", () => {
  it("uses current iPhone landscape target even if initial portrait bounds were zero", () => {
    expect(resolveListPaneContentWidth("ios", 280, 0, 0, 280, 0)).toBe(280);
    expect(resolveListPaneContentWidth("ios", null, 280, 280, 0, 0)).toBe(0);
  });
  it("keeps Android hinge resizing inside its animated bounds", () => {
    expect(resolveListPaneContentWidth("android", 320, 280, 360, 310, 10)).toBe(300);
    expect(resolveListPaneContentWidth("android", 320, 280, 360, 200, 10)).toBe(280);
    expect(resolveListPaneContentWidth("android", 320, 280, 360, 500, 10)).toBe(360);
  });
});
