import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  isThreadHighlightOverride,
  threadHighlightMenuActions,
  updateThreadHighlight,
} from "../../lib/threadHighlight";

const loadedAtom = Atom.make((get) => AsyncResult.isSuccess(get(mobilePreferencesAtom)));
// Primitive selection keeps another thread's edits from repainting every visible row.
const overrideAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const preferences = get(mobilePreferencesAtom);
    return AsyncResult.isSuccess(preferences)
      ? preferences.value.threadHighlights?.[key]
      : undefined;
  }),
);

export function useThreadHighlight(key: string) {
  const loaded = useAtomValue(loadedAtom);
  const override = useAtomValue(overrideAtom(key));
  const save = useAtomSet(updateMobilePreferencesAtom);
  const actions = useMemo(() => threadHighlightMenuActions(override), [override]);
  const handleAction = useCallback(
    (event: string) => {
      if (!event.startsWith("highlight:")) return false;
      const value = event.slice("highlight:".length);
      if (value !== "server" && !isThreadHighlightOverride(value)) return false;
      if (loaded)
        save({
          transform: (current) => ({
            threadHighlights: updateThreadHighlight(
              current.threadHighlights,
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
