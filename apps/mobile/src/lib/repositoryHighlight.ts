import {
  repositoryGroupingKeyOf,
  type RepositoryIdentity,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { scopedProjectKey } from "./scopedEntities";
import type { MenuAction } from "@react-native-menu/menu";
import {
  THREAD_HIGHLIGHT_COLORS,
  highlightMenuActions,
  type ThreadHighlightOverride,
} from "./threadHighlight";

/** Share a repository colour across clones/servers, falling back locally when identity is unavailable. */
export function repositoryHighlightKey(
  identity: RepositoryIdentity | null | undefined,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): string {
  return identity
    ? `repository:${repositoryGroupingKeyOf(identity)}`
    : `project:${scopedProjectKey(environmentId, projectId)}`;
}

/** Resolve one device-local repository colour shared by all its threads and worktrees. */
export function resolveRepositoryHighlight(
  override: ThreadHighlightOverride | undefined,
  repositoryKey: string,
): string | null {
  if (override === "none") return null;
  if (override !== undefined) return override;
  let hash = 0;
  for (const character of repositoryKey)
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return THREAD_HIGHLIGHT_COLORS[hash % THREAD_HIGHLIGHT_COLORS.length]!.color;
}

/** Repository colour menu, with events kept distinct from legacy per-thread events. */
export function repositoryHighlightMenuActions(
  override: ThreadHighlightOverride | undefined,
): MenuAction[] {
  return highlightMenuActions(override, {
    prefix: "repository-highlight:",
    defaultTitle: "Automatic",
  });
}
