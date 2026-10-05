import { describe, expect, it } from "vite-plus/test";
import { MOBILE_THEME_IDS } from "@t3tools/shared/themePalettes";

import { getMobileThemeVariables } from "../../lib/mobileTheme";
import { getThreadListV2RowAppearance as iosAppearance } from "./thread-list-v2-row-appearance";
import { getThreadListV2RowAppearance as androidAppearance } from "./thread-list-v2-row-appearance.android";

describe.each([
  ["ios", iosAppearance],
  ["android", androidAppearance],
] as const)("%s thread row colors", (_platform, appearanceFor) => {
  const originTheme = {
    ...getMobileThemeVariables(MOBILE_THEME_IDS[0], "dark"),
    "--color-screen": "#000000",
    "--color-drawer": "#ffffff",
    "--color-thread-selected": "#3366aa",
  };

  it.each([
    [false, "#1f1000"],
    [true, "#fff1e0"],
  ] as const)("tints an opaque row for sidebar=%s", (sidebarPane, expectedBackground) => {
    const row = appearanceFor(originTheme, sidebarPane, false, "#ff8800", "tint");
    expect(row.style?.backgroundColor).toBe(expectedBackground);
    expect(row.cardStyle?.backgroundColor).toBe(expectedBackground);
    expect(row.swipeBackgroundColor).toBe(expectedBackground);
    expect(row.providerIconSurfaceColor).toBe(expectedBackground);
    // Tint preserves the device's neutral text colors.
    expect(row.originVariables).not.toHaveProperty("--color-foreground");
    expect(row.interactionOpacity).toBe(1);
  });

  it.each([false, true])(
    "uses exact solid color and readable text for sidebar=%s",
    (sidebarPane) => {
      const row = appearanceFor(originTheme, sidebarPane, false, "#ffffff", "solid");
      expect(row.style?.backgroundColor).toBe("#ffffff");
      expect(row.originVariables?.["--color-foreground"]).toBe("#000000");
      expect(row.originVariables?.["--color-drawer-foreground"]).toBe("#000000");
      const dark = appearanceFor(originTheme, sidebarPane, false, "#1b2821", "solid");
      expect(dark.originVariables?.["--color-foreground"]).toBe("#ffffff");
      // Activity and status hues remain their existing semantic colors.
      expect(dark.originVariables).not.toHaveProperty("--color-danger-foreground");
    },
  );

  it.each([false, true])(
    "keeps selection, Off and missing colors unchanged for sidebar=%s",
    (sidebarPane) => {
      const original = appearanceFor(originTheme, sidebarPane, false);
      expect(appearanceFor(originTheme, sidebarPane, false, "#ff8800", "off")).toEqual(original);
      expect(appearanceFor(originTheme, sidebarPane, false, null, "solid")).toEqual(original);
      expect(appearanceFor(originTheme, sidebarPane, true, "#ff8800", "solid")).toEqual(
        appearanceFor(originTheme, sidebarPane, true),
      );
      expect(
        appearanceFor(originTheme, sidebarPane, true, "#ff8800", "solid").interactionOpacity,
      ).toBe(0);
    },
  );

  it.each(MOBILE_THEME_IDS)(
    "preserves active selection and uses neutral hover for %s",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const theme = getMobileThemeVariables(themeId, appearance);
        const idle = appearanceFor(theme, true, false);
        const active = appearanceFor(theme, true, true);

        expect(idle.style?.backgroundColor).toBe(theme["--color-drawer"]);
        expect(idle.interactionClassName).toBe("bg-thread-hover");
        expect(idle.interactionOpacity).toBe(1);
        expect(active.style?.backgroundColor).toBe(theme["--color-thread-selected"]);
        // Pointer feedback must not mix a second color into the active background.
        expect(active.interactionOpacity).toBe(0);
        expect(active.providerIconSurfaceColor).toBe(active.style?.backgroundColor);
        expect(idle.foregroundClassName).toBe("text-drawer-foreground");
        expect(idle.mutedForegroundClassName).toBe("text-drawer-foreground-muted");

        const phone = appearanceFor(theme, false, false);
        expect(phone.swipeBackgroundColor).toBe(theme["--color-screen"]);
        expect(phone.interactionClassName).toBe("bg-row-hover");
        expect(phone.foregroundClassName).toBe("text-foreground");
      }
    },
  );
});
