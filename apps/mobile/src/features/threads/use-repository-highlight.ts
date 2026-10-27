import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";
import { repositoryHighlightMenuActions } from "../../lib/repositoryHighlight";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { isThreadHighlightOverride, updateThreadHighlight } from "../../lib/threadHighlight";
import { resolveSpaceWorkType } from "../../lib/sidebarSpaces";

const machineOverrideAtom = Atom.family((id: string) =>
  Atom.make((get) => {
    const preferences = get(mobilePreferencesAtom);
    return AsyncResult.isSuccess(preferences)
      ? preferences.value.machineHighlights?.[id]
      : undefined;
  }),
);
const workTypeAtom = Atom.family((key: string) => {
  let previous: ReturnType<typeof resolveSpaceWorkType> = null;
  return Atom.make((get) => {
    const result = get(mobilePreferencesAtom);
    const next = AsyncResult.isSuccess(result) ? resolveSpaceWorkType(key, result.value) : null;
    // Unrelated Space memories change preferences often; keep unchanged row values stable.
    if (previous?.name === next?.name && previous?.colour === next?.colour) return previous;
    previous = next;
    return next;
  });
});

/** Canonical device-local machine and work-type colours remain distinct from repo colours. */
export function useSpaceMemberHighlights(machineId: string, repositoryKey: string) {
  return {
    machine: useAtomValue(machineOverrideAtom(machineId)),
    workType: useAtomValue(workTypeAtom(repositoryKey)),
  };
}

const loadedAtom = Atom.make((get) => AsyncResult.isSuccess(get(mobilePreferencesAtom)));
// Primitive selection keeps another repository's edits from repainting every visible row.
const overrideAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const preferences = get(mobilePreferencesAtom);
    return AsyncResult.isSuccess(preferences)
      ? preferences.value.repositoryHighlights?.[key]
      : undefined;
  }),
);

/** Share one repository override across its rows, preserving unrelated device preferences. */
export function useRepositoryHighlight(key: string) {
  const loaded = useAtomValue(loadedAtom);
  const override = useAtomValue(overrideAtom(key));
  const save = useAtomSet(updateMobilePreferencesAtom);
  const actions = useMemo(() => repositoryHighlightMenuActions(override), [override]);
  /** Update only the selected repository record through the serialized preference transform. */
  const handleAction = useCallback(
    (event: string) => {
      if (!event.startsWith("repository-highlight:")) return false;
      const value = event.slice("repository-highlight:".length);
      if (value !== "server" && !isThreadHighlightOverride(value)) return false;
      if (loaded)
        save({
          transform: (current) => ({
            repositoryHighlights: updateThreadHighlight(
              current.repositoryHighlights,
              key,
              value === "server" ? undefined : value,
            ),
          }),
        });
      return true;
    },
    [key, loaded, save],
  );
  return { override, loaded, actions, handleAction };
}
