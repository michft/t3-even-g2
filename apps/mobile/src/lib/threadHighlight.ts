import type { MenuAction } from "@react-native-menu/menu";

export type ThreadHighlightOverride = "none" | `#${string}`;
export type ThreadHighlights = Readonly<Record<string, ThreadHighlightOverride>>;

export const THREAD_HIGHLIGHT_COLORS = [
  { title: "Red", color: "#ef4444" },
  { title: "Orange", color: "#f97316" },
  { title: "Amber", color: "#eab308" },
  { title: "Green", color: "#22c55e" },
  { title: "Cyan", color: "#06b6d4" },
  { title: "Blue", color: "#3b82f6" },
  { title: "Purple", color: "#a855f7" },
  { title: "Pink", color: "#ec4899" },
  { title: "Grey", color: "#94a3b8" },
] as const;

/** Accepts stored colour choices or an explicit hidden marker. */
export function isThreadHighlightOverride(value: unknown): value is ThreadHighlightOverride {
  return value === "none" || (typeof value === "string" && /^#[\da-f]{6}$/i.test(value));
}

/** Keeps valid stored colour records without interpreting their thread or repository scope. */
export function sanitizeThreadHighlights(value: unknown): ThreadHighlights {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, color]) => key.length > 0 && isThreadHighlightOverride(color),
    ),
  );
}

/** Updates or resets one colour record while retaining neighboring choices. */
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

/** Builds the full colour palette under one menu-event prefix with the current override selected. */
export function highlightMenuActions(
  override: ThreadHighlightOverride | undefined,
  options: { readonly prefix: string; readonly defaultTitle: string },
): MenuAction[] {
  const { prefix, defaultTitle } = options;
  return [
    { id: `${prefix}server`, title: defaultTitle, state: override === undefined ? "on" : "off" },
    ...THREAD_HIGHLIGHT_COLORS.map(({ title, color }) => ({
      id: `${prefix}${color}`,
      title,
      image: "circle.fill",
      imageColor: color,
      state: override?.toLowerCase() === color ? ("on" as const) : ("off" as const),
    })),
    { id: `${prefix}none`, title: "None", state: override === "none" ? "on" : "off" },
  ];
}
