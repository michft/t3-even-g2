import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

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
  const scope = (state: SidebarSpacesState) =>
    state.spaces
      .find((space) => space.id === state.activeSpaceId)
      ?.projectRefs.toSorted()
      .join("\u0000") ?? null;
  return before.activeSpaceId !== after.activeSpaceId || scope(before) !== scope(after);
}

/** Pages run All, then each space in order; stepping stops at either end. */
export function stepSidebarSpace(state: SidebarSpacesState, direction: -1 | 1): string | null {
  const pages = [null, ...state.spaces.map((space) => space.id)];
  const index = Math.max(0, pages.indexOf(state.activeSpaceId));
  return pages[Math.min(pages.length - 1, Math.max(0, index + direction))] ?? null;
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

/** Space state plus the actions the switcher, dialog, and swipe handlers call. */
export interface SidebarSpacesStore extends SidebarSpacesState {
  setActiveSpace: (id: string | null) => void;
  step: (direction: -1 | 1) => void;
  createSpace: (input: Omit<SidebarSpace, "id">) => string;
  updateSpace: (id: string, input: Omit<SidebarSpace, "id">) => void;
  deleteSpace: (id: string) => void;
}

/** Per-device space store, persisted in local storage and never synced. */
export const useSidebarSpacesStore = create<SidebarSpacesStore>()(
  persist(
    (set) => ({
      spaces: [],
      activeSpaceId: null,
      setActiveSpace: (activeSpaceId) => set({ activeSpaceId }),
      step: (direction) => set((state) => ({ activeSpaceId: stepSidebarSpace(state, direction) })),
      createSpace: (input) => {
        const id = randomUUID();
        set((state) => ({ spaces: [...state.spaces, { ...input, id }], activeSpaceId: id }));
        return id;
      },
      updateSpace: (id, input) =>
        set((state) => ({
          spaces: state.spaces.map((space) => (space.id === id ? { ...input, id } : space)),
        })),
      deleteSpace: (id) =>
        set((state) => ({
          spaces: state.spaces.filter((space) => space.id !== id),
          activeSpaceId: state.activeSpaceId === id ? null : state.activeSpaceId,
        })),
    }),
    {
      name: "t3code:sidebar-spaces:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      migrate: parseSidebarSpacesState,
      merge: (persisted, current) => ({ ...current, ...parseSidebarSpacesState(persisted) }),
      partialize: ({ spaces, activeSpaceId }) => ({ spaces, activeSpaceId }),
    },
  ),
);

/** The space the sidebar is filtered to, or `null` on the All page. */
export function useActiveSidebarSpace(): SidebarSpace | null {
  return useSidebarSpacesStore(
    (state) => state.spaces.find((space) => space.id === state.activeSpaceId) ?? null,
  );
}
