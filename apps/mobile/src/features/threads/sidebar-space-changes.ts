import {
  type SidebarSpace,
  type SidebarSpacesState,
  addSidebarSpace,
  removeSidebarSpace,
  replaceSidebarSpace,
  stepSidebarSpace,
} from "@t3tools/client-runtime/state/sidebar-spaces";

/** One edit to the stored spaces, applied to the latest saved state. */
export type SidebarSpacesChange = (current: SidebarSpacesState) => SidebarSpacesState;

/**
 * Space edits as pure state changes. The preferences store runs each change once
 * optimistically and again when it persists, so anything random, such as a new
 * space's ID, is decided before the change is built.
 */
export function sidebarSpaceChanges(newId: () => string) {
  return {
    setActiveSpace:
      (activeSpaceId: string | null): SidebarSpacesChange =>
      (current) => ({ ...current, activeSpaceId }),
    step:
      (direction: -1 | 1): SidebarSpacesChange =>
      (current) => ({ ...current, activeSpaceId: stepSidebarSpace(current, direction) }),
    createSpace: (input: Omit<SidebarSpace, "id">): SidebarSpacesChange => {
      const space = { ...input, id: newId() };
      return (current) => addSidebarSpace(current, space);
    },
    updateSpace:
      (id: string, input: Omit<SidebarSpace, "id">): SidebarSpacesChange =>
      (current) =>
        replaceSidebarSpace(current, id, input),
    deleteSpace:
      (id: string): SidebarSpacesChange =>
      (current) =>
        removeSidebarSpace(current, id),
  };
}
