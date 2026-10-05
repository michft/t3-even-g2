import type { EnvironmentTheme, ServerSettings } from "@t3tools/contracts";
import {
  BUILT_IN_THEMES,
  T3_CHAT_THEME,
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  getThemeColorsForAppearance,
  type ThemeAppearance,
} from "./themePalettes.ts";

export interface EnvironmentThemeConfig {
  readonly settings: Pick<ServerSettings, "defaultTheme">;
  readonly environmentThemes?: ReadonlyArray<EnvironmentTheme>;
}

/** Resolve a remote default using only its published palette, never this client's theme library. */
export function resolveEnvironmentThemeColor(
  config: EnvironmentThemeConfig | null | undefined,
  toHex: (color: string) => string | null,
): string | null {
  const id = config?.settings.defaultTheme;
  if (!id) return null;
  const builtIn = BUILT_IN_THEMES.find((theme) => theme.id === id);
  const published = config?.environmentThemes?.find((theme) => theme.id === id);
  const theme = builtIn ?? published;
  if (!theme) return null;

  const appearance = theme.appearance;
  const fallback = getThemeColorsForAppearance(T3_CHAT_THEME, appearance)!.canvas;
  const candidates = builtIn
    ? [builtIn.colors.canvas]
    : [published?.colors?.canvas, published?.canvas, fallback];
  for (const canvas of candidates) {
    if (canvas === undefined) continue;
    const hex = toHex(canvas);
    if (hex === null) continue;
    const color = opaqueHexColor(hex, appearance, toHex);
    if (color !== null) return color;
  }
  return null;
}

function opaqueHexColor(
  value: string,
  appearance: ThemeAppearance,
  toHex: (color: string) => string | null,
): string | null {
  const expanded = /^#[\da-f]{3,4}$/i.test(value)
    ? `#${value
        .slice(1)
        .split("")
        .map((digit) => digit + digit)
        .join("")}`
    : value;
  if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(expanded)) return null;
  if (expanded.length === 7) return expanded.toLowerCase();
  const backdrop = toHex(
    (appearance === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS).canvas,
  );
  if (!backdrop || !/^#[\da-f]{6}$/i.test(backdrop)) return null;
  const alpha = Number.parseInt(expanded.slice(7), 16) / 255;
  return `#${[1, 3, 5]
    .map((offset) =>
      Math.round(
        Number.parseInt(expanded.slice(offset, offset + 2), 16) * alpha +
          Number.parseInt(backdrop.slice(offset, offset + 2), 16) * (1 - alpha),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Black or white, whichever has greater WCAG contrast against the server's hex color. */
export function environmentColorForeground(color: string): "#000000" | "#ffffff" {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}
