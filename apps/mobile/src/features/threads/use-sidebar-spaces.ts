import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  EMPTY_SIDEBAR_SPACES_STATE,
  type SidebarSpace,
  activeSidebarSpace,
} from "@t3tools/client-runtime/state/sidebar-spaces";
import { AsyncResult } from "effect/reactivity";
import * as Crypto from "expo-crypto";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { type SidebarSpacesChange, sidebarSpaceChanges } from "./sidebar-space-changes";

const changes = sidebarSpaceChanges(() => Crypto.randomUUID());

/** Device-local sidebar spaces, stored with the other mobile preferences. */
export function useSidebarSpaces() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const state =
    (loaded ? preferencesResult.value.sidebarSpaces : undefined) ?? EMPTY_SIDEBAR_SPACES_STATE;

  // A transform reads the optimistic value, so quick successive swipes each move one page.
  const apply = (change: SidebarSpacesChange) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        sidebarSpaces: change(current.sidebarSpaces ?? EMPTY_SIDEBAR_SPACES_STATE),
      }),
    });
  };

  return {
    loaded,
    spaces: state.spaces,
    activeSpace: activeSidebarSpace(state),
    setActiveSpace: (id: string | null) => apply(changes.setActiveSpace(id)),
    step: (direction: -1 | 1) => apply(changes.step(direction)),
    createSpace: (input: Omit<SidebarSpace, "id">) => apply(changes.createSpace(input)),
    updateSpace: (id: string, input: Omit<SidebarSpace, "id">) =>
      apply(changes.updateSpace(id, input)),
    deleteSpace: (id: string) => apply(changes.deleteSpace(id)),
  } as const;
}
