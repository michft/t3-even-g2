import { describe, expect, it } from "vite-plus/test";

import {
  createSidebarSpaceSwipe,
  intersectSidebarScopes,
  parseSidebarSpacesState,
  resolveSidebarSpaceProjectKeys,
  sidebarSpaceIncludesGroup,
  sidebarSpaceScopeChanged,
  stepSidebarSpace,
} from "./sidebarSpacesStore";

const work = { id: "w", name: "Work", color: "#3b82f6", projectRefs: ["laptop:api", "laptop:web"] };
const home = { id: "h", name: "Home", color: "#10b981", projectRefs: ["laptop:blog"] };

describe("space membership", () => {
  it("survives switching the project grouping setting", () => {
    const space = { ...work, projectRefs: ["laptop:p1", "server:p9"] };
    const laptop = { environmentId: "laptop", projectId: "p1" };
    const server = { environmentId: "server", projectId: "p9" };
    const other = { environmentId: "laptop", projectId: "p2" };
    // Grouped by repository: one group spans both environments.
    expect(sidebarSpaceIncludesGroup(space, { memberProjectRefs: [laptop, server] })).toBe(true);
    // Ungrouped: each environment's project is its own group.
    expect(sidebarSpaceIncludesGroup(space, { memberProjectRefs: [laptop] })).toBe(true);
    expect(sidebarSpaceIncludesGroup(space, { memberProjectRefs: [server] })).toBe(true);
    expect(sidebarSpaceIncludesGroup(space, { memberProjectRefs: [other] })).toBe(false);
    // The thread filter reads the stored refs directly, independent of grouping.
    expect(resolveSidebarSpaceProjectKeys(space)).toEqual(new Set(["laptop:p1", "server:p9"]));
    expect(resolveSidebarSpaceProjectKeys(null)).toBeNull();
  });
});

describe("intersectSidebarScopes", () => {
  it("narrows a space to the picked project and treats null as everything", () => {
    const space = new Set(["a", "b"]);
    expect(intersectSidebarScopes(null, null)).toBeNull();
    expect(intersectSidebarScopes(space, null)).toBe(space);
    expect(intersectSidebarScopes(new Set(["b", "c"]), space)).toEqual(new Set(["b"]));
  });
});

describe("stepSidebarSpace", () => {
  it("moves between All and each space without wrapping", () => {
    const state = { spaces: [work, home], activeSpaceId: null };
    expect(stepSidebarSpace(state, 1)).toBe("w");
    expect(stepSidebarSpace(state, -1)).toBeNull();
    expect(stepSidebarSpace({ ...state, activeSpaceId: "w" }, 1)).toBe("h");
    expect(stepSidebarSpace({ ...state, activeSpaceId: "h" }, 1)).toBe("h");
  });
});

describe("sidebarSpaceScopeChanged", () => {
  const onWork = { spaces: [work, home], activeSpaceId: "w" };

  it("flags changes that alter which projects are visible", () => {
    // Creating a space activates it.
    expect(
      sidebarSpaceScopeChanged(
        { spaces: [work], activeSpaceId: null },
        { spaces: [work, home], activeSpaceId: "h" },
      ),
    ).toBe(true);
    // Editing the active space's projects.
    expect(
      sidebarSpaceScopeChanged(onWork, {
        ...onWork,
        spaces: [{ ...work, projectRefs: ["laptop:api"] }, home],
      }),
    ).toBe(true);
    // Deleting the active space returns to All.
    expect(sidebarSpaceScopeChanged(onWork, { spaces: [home], activeSpaceId: null })).toBe(true);
  });

  it("ignores changes that leave the visible projects alone", () => {
    expect(
      sidebarSpaceScopeChanged(onWork, {
        ...onWork,
        spaces: [{ ...work, name: "Job", color: "#ef4444" }, home],
      }),
    ).toBe(false);
    expect(sidebarSpaceScopeChanged(onWork, { spaces: [work], activeSpaceId: "w" })).toBe(false);
    // Re-ticking a project reorders the list without changing what is shown.
    expect(
      sidebarSpaceScopeChanged(onWork, {
        ...onWork,
        spaces: [{ ...work, projectRefs: ["laptop:web", "laptop:api"] }, home],
      }),
    ).toBe(false);
    // A swipe past the last page leaves the active space where it was.
    const atEnd = { ...onWork, activeSpaceId: "h" };
    expect(
      sidebarSpaceScopeChanged(atEnd, { ...atEnd, activeSpaceId: stepSidebarSpace(atEnd, 1) }),
    ).toBe(false);
  });
});

describe("parseSidebarSpacesState", () => {
  it("drops malformed spaces and a dangling active space", () => {
    expect(
      parseSidebarSpacesState({ spaces: [work, { id: 1 }], activeSpaceId: "missing" }),
    ).toEqual({ spaces: [work], activeSpaceId: null });
    expect(parseSidebarSpacesState(null)).toEqual({ spaces: [], activeSpaceId: null });
  });
});

describe("createSidebarSpaceSwipe", () => {
  it("steps once per gesture even while momentum keeps scrolling", () => {
    const swipe = createSidebarSpaceSwipe();
    expect(swipe(50, 2, 0)).toBe(0);
    expect(swipe(50, 2, 10)).toBe(1);
    expect(swipe(80, 0, 20)).toBe(0);
    expect(swipe(80, 0, 200)).toBe(0);
    expect(swipe(-100, 0, 1000)).toBe(-1);
  });

  it("ignores mostly vertical scrolling", () => {
    const swipe = createSidebarSpaceSwipe();
    expect(swipe(60, 100, 0)).toBe(0);
    expect(swipe(60, 100, 10)).toBe(0);
  });
});
