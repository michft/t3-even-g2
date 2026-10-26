/** Preset colors offered for a space; a new space takes the next one in turn. */
export const SIDEBAR_SPACE_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#64748b",
] as const;

/** A named, colored group of projects that the sidebar can show on its own. */
export interface SidebarSpace {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  /**
   * Member projects as `environmentId:projectId`. Group keys are not stored
   * because they change when the project grouping setting changes.
   */
  readonly projectRefs: readonly string[];
}

/** Persisted space list and the page the sidebar currently shows. */
export interface SidebarSpacesState {
  readonly spaces: readonly SidebarSpace[];
  /** `null` is the "All" page, which shows every project. */
  readonly activeSpaceId: string | null;
}

/** A device with no spaces shows the All page. */
export const EMPTY_SIDEBAR_SPACES_STATE: SidebarSpacesState = { spaces: [], activeSpaceId: null };

/** The part of a sidebar project group needed to match it against a space. */
interface ScopableProjectGroup {
  readonly memberProjectRefs: readonly { environmentId: string; projectId: string }[];
}

/** The `environmentId:projectId` key the sidebar thread filter uses. */
export function sidebarProjectRefKey(ref: { environmentId: string; projectId: string }): string {
  return `${ref.environmentId}:${ref.projectId}`;
}

/** Whether a space holds any project of a sidebar group, under any grouping setting. */
export function sidebarSpaceIncludesGroup(
  space: Pick<SidebarSpace, "projectRefs">,
  group: ScopableProjectGroup,
): boolean {
  return group.memberProjectRefs.some((ref) =>
    space.projectRefs.includes(sidebarProjectRefKey(ref)),
  );
}

/** Guards persisted entries, which may come from an older or hand-edited store. */
const isSpace = (value: unknown): value is SidebarSpace => {
  const space = value as SidebarSpace | null;
  return (
    !!space &&
    typeof space.id === "string" &&
    typeof space.name === "string" &&
    typeof space.color === "string" &&
    Array.isArray(space.projectRefs) &&
    space.projectRefs.every((key) => typeof key === "string")
  );
};

/** Rebuilds valid state from storage, dropping malformed spaces and a deleted active space. */
export function parseSidebarSpacesState(persisted: unknown): SidebarSpacesState {
  const raw = persisted as Partial<SidebarSpacesState> | null;
  const spaces = Array.isArray(raw?.spaces) ? raw.spaces.filter(isSpace) : [];
  const activeSpaceId =
    typeof raw?.activeSpaceId === "string" && spaces.some((s) => s.id === raw.activeSpaceId)
      ? raw.activeSpaceId
      : null;
  return { spaces, activeSpaceId };
}

/** The space the sidebar is filtered to, or `null` on the All page. */
export function activeSidebarSpace(state: SidebarSpacesState): SidebarSpace | null {
  return state.spaces.find((space) => space.id === state.activeSpaceId) ?? null;
}

/** Project keys (`environmentId:projectId`) the active space shows, or `null` for every project. */
export function resolveSidebarSpaceProjectKeys(
  space: SidebarSpace | null,
): ReadonlySet<string> | null {
  return space === null ? null : new Set(space.projectRefs);
}

/** Combines the space filter with the single-project filter; `null` means unfiltered. */
export function intersectSidebarScopes(
  a: ReadonlySet<string> | null,
  b: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Set([...a].filter((key) => b.has(key)));
}

/**
 * Whether a change altered which projects the sidebar shows. Thread selection
 * must be cleared then, since it can hold threads the new scope hides.
 */
export function sidebarSpaceScopeChanged(
  before: SidebarSpacesState,
  after: SidebarSpacesState,
): boolean {
  const scope = (state: SidebarSpacesState) => {
    const space = activeSidebarSpace(state);
    return space === null ? null : [...space.projectRefs].sort().join("\u0000");
  };
  return before.activeSpaceId !== after.activeSpaceId || scope(before) !== scope(after);
}

/** Pages run All, then each space in order; stepping stops at either end. */
export function stepSidebarSpace(state: SidebarSpacesState, direction: -1 | 1): string | null {
  const pages = [null, ...state.spaces.map((space) => space.id)];
  const index = Math.max(0, pages.indexOf(state.activeSpaceId));
  return pages[Math.min(pages.length - 1, Math.max(0, index + direction))] ?? null;
}

/** A new space is appended and shown straight away. */
export function addSidebarSpace(
  state: SidebarSpacesState,
  space: SidebarSpace,
): SidebarSpacesState {
  return { spaces: [...state.spaces, space], activeSpaceId: space.id };
}

/** Edits a space in place; the shown page stays the same. */
export function replaceSidebarSpace(
  state: SidebarSpacesState,
  id: string,
  input: Omit<SidebarSpace, "id">,
): SidebarSpacesState {
  return {
    ...state,
    spaces: state.spaces.map((space) => (space.id === id ? { ...input, id } : space)),
  };
}

/** Deleting the shown space returns to All; its projects and threads are untouched. */
export function removeSidebarSpace(state: SidebarSpacesState, id: string): SidebarSpacesState {
  return {
    spaces: state.spaces.filter((space) => space.id !== id),
    activeSpaceId: state.activeSpaceId === id ? null : state.activeSpaceId,
  };
}

/** Horizontal travel that counts as a deliberate swipe rather than a stray scroll. */
const SWIPE_DISTANCE_PX = 90;
/** Gap in wheel events that ends a gesture, including trackpad momentum. */
const SWIPE_IDLE_MS = 250;

/**
 * Turns horizontal wheel deltas into at most one page step per gesture. Trackpad
 * momentum keeps emitting deltas after the fingers lift, so a gesture only ends
 * once deltas stop for `SWIPE_IDLE_MS`.
 */
export function createSidebarSpaceSwipe() {
  let accumulated = 0;
  let lastAt = Number.NEGATIVE_INFINITY;
  let fired = false;
  return (deltaX: number, deltaY: number, at: number): -1 | 0 | 1 => {
    if (at - lastAt > SWIPE_IDLE_MS) {
      accumulated = 0;
      fired = false;
    }
    lastAt = at;
    if (fired || Math.abs(deltaX) <= Math.abs(deltaY)) return 0;
    accumulated += deltaX;
    if (Math.abs(accumulated) < SWIPE_DISTANCE_PX) return 0;
    fired = true;
    return accumulated > 0 ? 1 : -1;
  };
}

/** Finger travel needed before a touch swipe changes space. */
const TOUCH_SWIPE_PX = 60;

/**
 * A finished touch drag pages spaces only when it is long and clearly sideways,
 * so vertical list scrolling never switches space. Dragging left shows the next page.
 */
export function sidebarSpaceTouchSwipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < TOUCH_SWIPE_PX || Math.abs(dx) <= Math.abs(dy) * 2) return 0;
  return dx < 0 ? 1 : -1;
}
