/**
 * Branch recorded on a thread created from the new-task composer. An explicit
 * picker choice always wins. An untouched current-checkout draft records the
 * ref that is actually checked out, so the thread's PR badge and branch label
 * match the live git status instead of staying blank. A detached HEAD, a
 * non-repository project, or a status that has not arrived stays null rather
 * than fabricating a branch. Only the online creation path resolves a
 * checkout; a queued task cannot know the checkout it will drain against.
 */
export function resolveProjectThreadCreationBranch(input: {
  readonly workspaceMode: "local" | "worktree";
  readonly selectedBranch: string | null;
  readonly currentCheckoutBranch: string | null;
}): string | null {
  if (input.selectedBranch !== null) {
    return input.selectedBranch;
  }
  return input.workspaceMode === "local" ? input.currentCheckoutBranch : null;
}
