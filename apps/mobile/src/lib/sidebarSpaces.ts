import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  parseSidebarSpacesState,
  type SidebarSpace,
} from "@t3tools/client-runtime/state/sidebar-spaces";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import { repositoryHighlightKey, resolveRepositoryHighlight } from "./repositoryHighlight";
import { sanitizeThreadHighlights, type ThreadHighlights } from "./threadHighlight";
import { scopedProjectKey } from "./scopedEntities";

/** A Space chooses one member identity; display and colour records stay device-local. */
export type SpaceGroupBy = "machine" | "repo" | "work_type";
/** Legacy spaces have no grouping field and continue to select their saved projects. */
export interface MobileSidebarSpace extends SidebarSpace {
  readonly groupBy?: SpaceGroupBy;
  readonly repositoryKeys?: readonly string[];
  readonly machineIds?: readonly string[];
  readonly workTypeIds?: readonly string[];
}
/** Saved mobile grouping and canonical member colours, independent of host settings. */
export interface MobileSpacePreferences {
  readonly sidebarSpaces?: {
    readonly spaces: readonly MobileSidebarSpace[];
    readonly activeSpaceId: string | null;
  };
  readonly workTypes?: readonly { readonly id: string; readonly name: string }[];
  readonly repositoryWorkTypes?: Readonly<Record<string, string>>;
  readonly repositoryHighlights?: ThreadHighlights;
  readonly machineHighlights?: ThreadHighlights;
  readonly workTypeHighlights?: ThreadHighlights;
}
/** Editable starter categories; repositories remain unclassified until explicitly assigned. */
export const DEFAULT_WORK_TYPES = [
  { id: "vercel", name: "Vercel" },
  { id: "vercel-expo", name: "Vercel + Expo" },
  { id: "swift-native", name: "Swift native" },
  { id: "convex", name: "Convex DB" },
  { id: "github-markdown", name: "GitHub + Markdown DB" },
  { id: "api", name: "API" },
  { id: "config", name: "Configuration" },
] as const;

/** Accept member IDs only as a homogeneous string list. */
const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
/** Ignore invalid assignment values without losing neighbouring records. */
const record = (value: unknown): Readonly<Record<string, string>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === "string"))
    : {};

/** Rebuild mobile extensions without trusting old or hand-edited preference values. */
export function parseMobileSpaces(
  value: unknown,
): NonNullable<MobileSpacePreferences["sidebarSpaces"]> {
  const state = parseSidebarSpacesState(value);
  return {
    ...state,
    spaces: state.spaces.map((space) => {
      const raw = space as MobileSidebarSpace;
      return {
        id: space.id,
        name: space.name,
        color: space.color,
        projectRefs: space.projectRefs,
        ...(raw.groupBy === "machine" || raw.groupBy === "repo" || raw.groupBy === "work_type"
          ? { groupBy: raw.groupBy }
          : {}),
        ...(strings(raw.repositoryKeys) ? { repositoryKeys: strings(raw.repositoryKeys) } : {}),
        ...(strings(raw.machineIds) ? { machineIds: strings(raw.machineIds) } : {}),
        ...(strings(raw.workTypeIds) ? { workTypeIds: strings(raw.workTypeIds) } : {}),
      };
    }),
  };
}

/** Sanitize only the new optional preference fields; missing fields stay missing for rollback. */
export function parseSpaceMetadata(value: MobileSpacePreferences): Partial<MobileSpacePreferences> {
  return {
    ...(value.workTypes !== undefined
      ? {
          workTypes: Array.isArray(value.workTypes)
            ? value.workTypes.filter(
                (item) =>
                  item &&
                  typeof item.id === "string" &&
                  typeof item.name === "string" &&
                  item.name.trim().length > 0,
              )
            : [],
        }
      : {}),
    ...(value.repositoryWorkTypes !== undefined
      ? { repositoryWorkTypes: record(value.repositoryWorkTypes) }
      : {}),
    ...(value.machineHighlights !== undefined
      ? { machineHighlights: sanitizeThreadHighlights(value.machineHighlights) }
      : {}),
    ...(value.workTypeHighlights !== undefined
      ? { workTypeHighlights: sanitizeThreadHighlights(value.workTypeHighlights) }
      : {}),
  };
}

/** Recover repository identity from another snapshot of the same physical checkout. */
export function spaceRepositoryKey(
  project: EnvironmentProject,
  projects: readonly EnvironmentProject[],
): string {
  const identity =
    project.repositoryIdentity ??
    projects.find(
      (candidate) =>
        derivePhysicalProjectKey(candidate) === derivePhysicalProjectKey(project) &&
        candidate.repositoryIdentity,
    )?.repositoryIdentity;
  return repositoryHighlightKey(identity, project.environmentId, project.id);
}

/** Keep canonical selectors while offline; migrate legacy refs without discarding unavailable members. */
export function spaceRepositorySelectors(
  space: Pick<MobileSidebarSpace, "repositoryKeys" | "projectRefs">,
  projects: readonly EnvironmentProject[],
): readonly string[] {
  const selectors = space.repositoryKeys ?? space.projectRefs.map((ref) => `project:${ref}`);
  return [
    ...new Set(
      selectors.map((key) => {
        const project = key.startsWith("project:")
          ? projects.find(
              (item) => `project:${scopedProjectKey(item.environmentId, item.id)}` === key,
            )
          : undefined;
        return project ? spaceRepositoryKey(project, projects) : key;
      }),
    ),
  ];
}

/** Resolve explicit categories, with a visible Unclassified colour only when configured. */
export function resolveSpaceWorkType(key: string, preferences: MobileSpacePreferences) {
  const id = preferences.repositoryWorkTypes?.[key];
  const type = (preferences.workTypes ?? DEFAULT_WORK_TYPES).find((item) => item.id === id);
  const resolved = type ?? { id: "unclassified", name: "Unclassified" };
  if (!type && preferences.workTypeHighlights?.unclassified === undefined) return null;
  return {
    name: resolved.name,
    colour: resolveRepositoryHighlight(
      preferences.workTypeHighlights?.[resolved.id],
      `work-type:${resolved.id}`,
    ),
  };
}

/** Resolve dynamic machine/type/repository membership against the current project catalog. */
export function mobileSpaceProjectKeys(
  space: MobileSidebarSpace | null,
  projects: readonly EnvironmentProject[],
  preferences: MobileSpacePreferences,
): ReadonlySet<string> | null {
  if (space === null) return null;
  const repositoryKeys = spaceRepositorySelectors(space, projects);
  return new Set([
    ...(space.repositoryKeys === undefined &&
    (space.groupBy === undefined || space.groupBy === "repo")
      ? space.projectRefs
      : []),
    ...projects
      .filter((project) => {
        if (space.groupBy === "machine") return space.machineIds?.includes(project.environmentId);
        const key = spaceRepositoryKey(project, projects);
        if (space.groupBy === "work_type")
          return space.workTypeIds?.includes(
            preferences.repositoryWorkTypes?.[key] ?? "unclassified",
          );
        return (
          repositoryKeys.includes(key) ||
          repositoryKeys.includes(`project:${scopedProjectKey(project.environmentId, project.id)}`)
        );
      })
      .map((project) => scopedProjectKey(project.environmentId, project.id)),
  ]);
}

/** A colour edit writes canonical members once; changing grouping or name alone never recolours. */
export function spaceColourPatch(
  space: MobileSidebarSpace,
  preferences: MobileSpacePreferences,
  projects: readonly EnvironmentProject[],
): Partial<MobileSpacePreferences> {
  const field =
    space.groupBy === "machine"
      ? "machineHighlights"
      : space.groupBy === "work_type"
        ? "workTypeHighlights"
        : "repositoryHighlights";
  const members =
    space.groupBy === "machine"
      ? (space.machineIds ?? [])
      : space.groupBy === "work_type"
        ? (space.workTypeIds ?? [])
        : spaceRepositorySelectors(space, projects);
  return {
    [field]: {
      ...preferences[field],
      ...Object.fromEntries(members.map((key) => [key, space.color])),
    },
  };
}

/** Uniform members share their colour; divergent shared members are explicitly Mixed. */
export function spaceMemberColour(
  space: MobileSidebarSpace,
  preferences: MobileSpacePreferences,
  projects: readonly EnvironmentProject[],
  machineColours: ReadonlyMap<string, string | null>,
): { colour: string; mixed: boolean } {
  const colours =
    space.groupBy === "machine"
      ? (space.machineIds ?? []).map(
          (id) => preferences.machineHighlights?.[id] ?? machineColours.get(id),
        )
      : space.groupBy === "work_type"
        ? (space.workTypeIds ?? []).map((id) =>
            resolveRepositoryHighlight(preferences.workTypeHighlights?.[id], `work-type:${id}`),
          )
        : spaceRepositorySelectors(space, projects).map((key) =>
            resolveRepositoryHighlight(preferences.repositoryHighlights?.[key], key),
          );
  const unique = new Set(colours.map((colour) => (colour === "none" ? null : (colour ?? null))));
  return {
    colour: unique.size === 1 ? ([...unique][0] ?? "transparent") : space.color,
    mixed: unique.size > 1,
  };
}
