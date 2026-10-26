import {
  EMPTY_SIDEBAR_SPACES_STATE,
  type SidebarSpace,
  type SidebarSpacesState,
  activeSidebarSpace,
  addSidebarSpace,
  parseSidebarSpacesState,
  removeSidebarSpace,
  replaceSidebarSpace,
  stepSidebarSpace,
} from "@t3tools/client-runtime/state/sidebar-spaces";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

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
      ...EMPTY_SIDEBAR_SPACES_STATE,
      setActiveSpace: (activeSpaceId) => set({ activeSpaceId }),
      step: (direction) => set((state) => ({ activeSpaceId: stepSidebarSpace(state, direction) })),
      createSpace: (input) => {
        const id = randomUUID();
        set((state) => addSidebarSpace(state, { ...input, id }));
        return id;
      },
      updateSpace: (id, input) => set((state) => replaceSidebarSpace(state, id, input)),
      deleteSpace: (id) => set((state) => removeSidebarSpace(state, id)),
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
  return useSidebarSpacesStore(activeSidebarSpace);
}
