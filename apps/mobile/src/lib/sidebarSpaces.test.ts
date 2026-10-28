import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  mobileSpaceProjectKeys,
  parseMobileSpaces,
  spaceColourPatch,
  spaceMemberColour,
  spaceRepositoryKey,
  resolveSpaceWorkType,
  spaceRepositorySelectors,
  type MobileSidebarSpace,
} from "./sidebarSpaces";

const projects: EnvironmentProject[] = ["one", "two"].map((id) => ({
  id: ProjectId.make(id),
  environmentId: EnvironmentId.make("mac"),
  title: id,
  workspaceRoot: `/repos/${id}`,
  repositoryIdentity: null,
  scripts: [],
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}));
const space: MobileSidebarSpace = {
  id: "work",
  name: "Work",
  color: "#a855f7",
  projectRefs: ["mac:one"],
};

describe("mobile Space member identities", () => {
  it("preserves legacy Repo Spaces and sanitizes new member selectors", () => {
    expect(parseMobileSpaces({ spaces: [space], activeSpaceId: "work" }).spaces).toEqual([space]);
    expect(
      parseMobileSpaces({
        spaces: [{ ...space, groupBy: "machine", machineIds: [42] }],
        activeSpaceId: "work",
      }).spaces[0],
    ).toEqual({ ...space, groupBy: "machine" });
    expect(mobileSpaceProjectKeys(space, projects, {})).toEqual(new Set(["mac:one"]));
  });
  it("machine and work-type membership follows new projects without confusing project IDs across hosts", () => {
    expect(
      mobileSpaceProjectKeys({ ...space, groupBy: "machine", machineIds: ["mac"] }, projects, {}),
    ).toEqual(new Set(["mac:one", "mac:two"]));
    const repositoryWorkTypes = { [spaceRepositoryKey(projects[1]!, projects)]: "api" };
    expect(
      mobileSpaceProjectKeys({ ...space, groupBy: "work_type", workTypeIds: ["api"] }, projects, {
        repositoryWorkTypes,
      }),
    ).toEqual(new Set(["mac:two"]));
    expect(
      mobileSpaceProjectKeys({ ...space, groupBy: "machine", machineIds: ["other"] }, projects, {}),
    ).toEqual(new Set());
  });
  it("colour propagation writes only the selected identity and preserves neighbours", () => {
    const preferences = {
      repositoryHighlights: { other: "#123456" as const },
      machineHighlights: { mac: "#abcdef" as const },
    };
    expect(spaceColourPatch(space, preferences, projects)).toEqual({
      repositoryHighlights: { other: "#123456", "project:mac:one": "#a855f7" },
    });
    expect(
      spaceColourPatch(
        { ...space, groupBy: "machine", machineIds: ["mac"] },
        preferences,
        projects,
      ),
    ).toEqual({ machineHighlights: { mac: "#a855f7" } });
    expect(
      spaceColourPatch(
        { ...space, groupBy: "work_type", workTypeIds: ["api"] },
        preferences,
        projects,
      ),
    ).toEqual({ workTypeHighlights: { api: "#a855f7" } });
  });
  it("overlapping Spaces reflect a later canonical colour edit as Mixed", () => {
    const pair = { ...space, projectRefs: ["mac:one", "mac:two"] };
    const initial = spaceColourPatch(pair, {}, projects);
    expect(spaceMemberColour(pair, initial, projects, new Map())).toEqual({
      colour: "#a855f7",
      mixed: false,
    });
    const changed = {
      ...initial,
      ...spaceColourPatch({ ...space, color: "#123456" }, initial, projects),
    };
    expect(spaceMemberColour(pair, changed, projects, new Map()).mixed).toBe(true);
    expect(spaceMemberColour(space, changed, projects, new Map())).toEqual({
      colour: "#123456",
      mixed: false,
    });
  });
  it("recovers canonical identity from normalized duplicate checkouts", () => {
    const fresh = {
      ...projects[0]!,
      repositoryIdentity: {
        canonicalKey: "github.com/example/repo",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@github.com:example/repo.git",
        },
      },
    };
    const old = {
      ...projects[0]!,
      id: ProjectId.make("old"),
      workspaceRoot: `${fresh.workspaceRoot}/`,
    };
    expect(spaceRepositoryKey(old, [old, fresh])).toBe(spaceRepositoryKey(fresh, [old, fresh]));
    const canonical = spaceRepositoryKey(fresh, [old, fresh]);
    expect(
      spaceColourPatch({ ...space, repositoryKeys: ["project:mac:one"] }, {}, [fresh]),
    ).toEqual({ repositoryHighlights: { [canonical]: space.color } });
  });
  it("keeps offline canonical members during a rename and accepts fallback legacy refs", () => {
    const saved = { ...space, repositoryKeys: ["repository:offline"] };
    expect(spaceRepositorySelectors(saved, [])).toEqual(["repository:offline"]);
    expect(spaceRepositorySelectors(space, [])).toEqual(["project:mac:one"]);
    expect(mobileSpaceProjectKeys({ ...space, repositoryKeys: [] }, projects, {})).toEqual(
      new Set(),
    );
  });
  it("counts None as a distinct member colour and resolves a coloured Unclassified group", () => {
    const pair = { ...space, groupBy: "machine" as const, machineIds: ["mac", "other"] };
    expect(
      spaceMemberColour(
        pair,
        { machineHighlights: { mac: "#123456", other: "none" } },
        projects,
        new Map(),
      ).mixed,
    ).toBe(true);
    expect(
      resolveSpaceWorkType("unassigned", { workTypeHighlights: { unclassified: "#123456" } }),
    ).toEqual({ name: "Unclassified", colour: "#123456" });
  });
});
