import type { ThreadOriginColorMode } from "@t3tools/contracts";
import { environmentColorForeground } from "@t3tools/shared/environmentColor";

import {
  flattenThemeColor,
  themeColorWithAlpha,
  type MobileThemeVariables,
} from "../../lib/mobileTheme";

export function getThreadListV2OriginAppearance(
  theme: MobileThemeVariables,
  sidebarPane: boolean,
  selected: boolean,
  environmentColor: string | null | undefined,
  mode: ThreadOriginColorMode,
) {
  if (!environmentColor || mode === "off" || selected) {
    return { theme, variables: undefined };
  }

  const surface = sidebarPane ? "--color-drawer" : "--color-screen";
  // Swipe actions need an opaque row instead of showing through a translucent tint.
  const background =
    mode === "solid"
      ? environmentColor
      : flattenThemeColor(themeColorWithAlpha(environmentColor, 0.12), theme[surface]);
  const foreground = environmentColorForeground(environmentColor);
  const variables: Partial<MobileThemeVariables> = {
    [surface]: background,
    ...(mode === "solid"
      ? {
          "--color-foreground": foreground,
          "--color-foreground-secondary": foreground,
          "--color-foreground-muted": foreground,
          "--color-foreground-tertiary": foreground,
          "--color-drawer-foreground": foreground,
          "--color-drawer-foreground-muted": foreground,
          "--color-icon": foreground,
          "--color-icon-subtle": foreground,
        }
      : {}),
  };
  return { theme: { ...theme, ...variables }, variables };
}
