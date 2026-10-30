import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { EMPTY_SIDEBAR_SPACES_STATE } from "@t3tools/client-runtime/state/sidebar-spaces";
import { AsyncResult } from "effect/reactivity";
import * as Crypto from "expo-crypto";
import { useEffect, useRef } from "react";

import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { type SidebarSpacesChange, sidebarSpaceChanges } from "./sidebar-space-changes";

import {
  DEFAULT_WORK_TYPES,
  mobileSpaceProjectKeys,
  spaceColourPatch,
  type MobileSidebarSpace as SidebarSpace,
} from "../../lib/sidebarSpaces";
import type { Preferences } from "../../persistence/mobile-preferences";

const changes = sidebarSpaceChanges(() => Crypto.randomUUID());

/** Navigation owned by the visible iOS sidebar column. */
export interface SidebarSpaceThreadSelection {
  readonly selectedThreadKey: string | null;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onClearThread: () => void;
}

/** Device-local sidebar spaces, stored with the other mobile preferences. */
export function useSidebarSpaces(
  selection?: SidebarSpaceThreadSelection,
  projects: readonly EnvironmentProject[] = [],
) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const preferences: Preferences = loaded ? preferencesResult.value : {};
  const state =
    (loaded ? preferencesResult.value.sidebarSpaces : undefined) ?? EMPTY_SIDEBAR_SPACES_STATE;
  const lastThreadKeys = loaded ? preferencesResult.value.sidebarSpaceLastThreadKeys : undefined;
  const navigation = useRef<{
    spaceId: string | null;
    scope: string;
    pending: { outgoing: string | null; incoming: string | null } | null;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives workspace navigation to the remembered thread when the active Space or its scope changes
  useEffect(() => {
    if (!loaded || selection === undefined) {
      navigation.current = null;
      return;
    }
    const memoryKey = state.activeSpaceId === null ? "all" : `space:${state.activeSpaceId}`;
    const activeSpace: SidebarSpace | null =
      state.spaces.find((space) => space.id === state.activeSpaceId) ?? null;
    const projectKeys = mobileSpaceProjectKeys(activeSpace, projects, preferences);
    const available = selection.threads.filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        (projectKeys === null ||
          projectKeys.has(scopedProjectKey(thread.environmentId, thread.projectId))),
    );
    /** Thread memories must distinguish identical IDs on different machines. */
    const threadKey = (thread: EnvironmentThreadShell) =>
      scopedThreadKey(thread.environmentId, thread.id);
    // Only member edits own navigation. Environment removal/reconnection can
    // change resolved projects while Settings is above Thread; popping that
    // stack here races the native dismissal of a non-top screen.
    const scope = JSON.stringify([
      activeSpace?.groupBy,
      activeSpace?.projectRefs,
      activeSpace?.repositoryKeys,
      activeSpace?.machineIds,
      activeSpace?.workTypeIds,
      activeSpace?.groupBy === "work_type" ? preferences.repositoryWorkTypes : null,
    ]);
    const previous = navigation.current;
    const scopeExcludesSelection =
      previous !== null &&
      previous.scope !== scope &&
      selection.selectedThreadKey !== null &&
      !available.some((thread) => threadKey(thread) === selection.selectedThreadKey);
    const waitingForThreads = previous?.pending?.incoming === null;
    if (
      (previous !== null && previous.spaceId !== state.activeSpaceId) ||
      scopeExcludesSelection ||
      (waitingForThreads && selection.selectedThreadKey === null && available.length > 0)
    ) {
      const destination =
        available.find((thread) => threadKey(thread) === lastThreadKeys?.[memoryKey]) ??
        available.sort(
          (a, b) =>
            getThreadSortTimestamp(b, "updated_at") - getThreadSortTimestamp(a, "updated_at"),
        )[0];
      navigation.current = {
        spaceId: state.activeSpaceId,
        scope,
        pending: {
          outgoing: selection.selectedThreadKey,
          incoming: destination ? threadKey(destination) : null,
        },
      };
      if (destination) selection.onSelectThread(destination);
      else selection.onClearThread();
      return;
    }
    // An empty list can mean a reconnecting environment. Keep restoration pending
    // until its threads arrive, without repeatedly clearing an already empty detail.
    if (waitingForThreads && selection.selectedThreadKey === null) return;
    // Navigation can paint after the Space preference. Do not record that outgoing
    // route as the destination's last thread, even when the Spaces share a project.
    if (
      previous?.pending &&
      selection.selectedThreadKey === previous.pending.outgoing &&
      selection.selectedThreadKey !== previous.pending.incoming
    ) {
      return;
    }
    navigation.current = { spaceId: state.activeSpaceId, scope, pending: null };
    const selected = available.find((thread) => threadKey(thread) === selection.selectedThreadKey);
    if (selected && lastThreadKeys?.[memoryKey] !== selection.selectedThreadKey) {
      const selectedKey = threadKey(selected);
      savePreferences({
        transform: (current) => ({
          sidebarSpaceLastThreadKeys: {
            ...current.sidebarSpaceLastThreadKeys,
            [memoryKey]: selectedKey,
          },
        }),
      });
    }
  }, [loaded, state, lastThreadKeys, selection, savePreferences, projects, preferences]);

  /** Transform the optimistic value so rapid edits and page swipes preserve one another. */
  const apply = (
    change: SidebarSpacesChange,
    edited?: SidebarSpace | undefined,
    metadata: Partial<Preferences> = {},
    applyColour = false,
  ) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const before = current.sidebarSpaces ?? EMPTY_SIDEBAR_SPACES_STATE;
        const next = change(before);
        const old = edited ? before.spaces.find((space) => space.id === edited.id) : undefined;
        return {
          ...metadata,
          sidebarSpaces: next,
          ...(edited && (!old || old.color !== edited.color || applyColour)
            ? spaceColourPatch(edited, { ...current, ...metadata }, projects)
            : {}),
        };
      },
    });
  };

  return {
    loaded,
    spaces: state.spaces,
    activeSpace: state.spaces.find((space) => space.id === state.activeSpaceId) ?? null,
    preferences,
    projects,
    workTypes: preferences.workTypes ?? DEFAULT_WORK_TYPES,
    setActiveSpace: (id: string | null) => apply(changes.setActiveSpace(id)),
    step: (direction: -1 | 1) => apply(changes.step(direction)),
    createSpace: (input: Omit<SidebarSpace, "id">, metadata: Partial<Preferences> = {}) => {
      const change = changes.createSpace(input);
      const next = change(state);
      apply(
        change,
        next.spaces.find((space) => space.id === next.activeSpaceId),
        metadata,
      );
    },
    updateSpace: (
      id: string,
      input: Omit<SidebarSpace, "id">,
      metadata: Partial<Preferences> = {},
      applyColour = false,
    ) => apply(changes.updateSpace(id, input), { ...input, id }, metadata, applyColour),
    deleteSpace: (id: string) => apply(changes.deleteSpace(id)),
  } as const;
}
