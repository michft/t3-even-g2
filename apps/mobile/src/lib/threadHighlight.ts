import type { MenuAction } from "@react-native-menu/menu";

export type ThreadHighlightOverride = "none" | `#${string}`;
export type ThreadHighlights = Readonly<Record<string, ThreadHighlightOverride>>;

export const THREAD_HIGHLIGHT_COLORS = [
  { title: "Red", color: "#ef4444" },
  { title: "Orange", color: "#f97316" },
  { title: "Amber", color: "#eab308" },
  { title: "Green", color: "#22c55e" },
  { title: "Blue", color: "#3b82f6" },
  { title: "Purple", color: "#a855f7" },
  { title: "Pink", color: "#ec4899" },
  { title: "Grey", color: "#94a3b8" },
] as const;

export function isThreadHighlightOverride(value: unknown): value is ThreadHighlightOverride {
  return value === "none" || (typeof value === "string" && /^#[\da-f]{6}$/i.test(value));
}

export function sanitizeThreadHighlights(value: unknown): ThreadHighlights {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, color]) => key.length > 0 && isThreadHighlightOverride(color),
    ),
  );
}

export function updateThreadHighlight(
  current: ThreadHighlights | undefined,
  key: string,
  override: ThreadHighlightOverride | undefined,
): ThreadHighlights {
  const next = { ...current };
  if (override === undefined) delete next[key];
  else next[key] = override;
  return next;
}

export function resolveThreadHighlight(
  override: ThreadHighlightOverride | undefined,
  serverAccent: string | null | undefined,
): string | null {
  return override === "none" ? null : (override ?? serverAccent ?? null);
}

export function threadHighlightMenuActions(
  override: ThreadHighlightOverride | undefined,
): MenuAction[] {
  return [
    { id: "highlight:server", title: "Use server", state: override === undefined ? "on" : "off" },
    ...THREAD_HIGHLIGHT_COLORS.map(({ title, color }) => ({
      id: `highlight:${color}`,
      title,
      image: "circle.fill",
      imageColor: color,
      state: override?.toLowerCase() === color ? ("on" as const) : ("off" as const),
    })),
    { id: "highlight:none", title: "None", state: override === "none" ? "on" : "off" },
  ];
}
