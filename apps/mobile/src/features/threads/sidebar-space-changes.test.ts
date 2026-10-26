import { describe, expect, it } from "vite-plus/test";

import { sidebarSpaceChanges } from "./sidebar-space-changes";

describe("sidebarSpaceChanges", () => {
  it("keeps a new space's ID when the preferences store replays the change", () => {
    let next = 0;
    const changes = sidebarSpaceChanges(() => `space-${++next}`);
    const empty = { spaces: [], activeSpaceId: null };
    const create = changes.createSpace({ name: "Work", color: "#3b82f6", projectRefs: [] });

    // The store applies a change optimistically, then again when it persists.
    const optimistic = create(empty);
    const persisted = create(empty);
    expect(persisted).toEqual(optimistic);

    // An edit or delete aimed at the optimistic ID still lands after the persisted replay.
    const id = optimistic.activeSpaceId!;
    const renamed = changes.updateSpace(id, { name: "Job", color: "#3b82f6", projectRefs: [] })(
      persisted,
    );
    expect(renamed.spaces.map((space) => space.name)).toEqual(["Job"]);
    expect(changes.deleteSpace(id)(renamed)).toEqual(empty);
  });
});
