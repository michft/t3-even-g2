import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Preferences } from "../../persistence/mobile-preferences";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { makeThreadShellFixture } from "../../test-fixtures";

const mocks = vi.hoisted(() => ({
  preferences: {} as Preferences,
  save: vi.fn<(update: { transform: (current: Preferences) => Partial<Preferences> }) => void>(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success(mocks.preferences),
  useAtomSet: () => mocks.save,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: "preferences",
  updateMobilePreferencesAtom: "update",
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "new-space" }));

import { useSidebarSpaces, type SidebarSpaceThreadSelection } from "./use-sidebar-spaces";

const work = { id: "work", name: "Work", color: "#3b82f6", projectRefs: ["host:work"] };
const home = { id: "home", name: "Home", color: "#10b981", projectRefs: ["host:home"] };
const threads = [
  makeThreadShellFixture({
    environmentId: EnvironmentId.make("host"),
    id: ThreadId.make("work-one"),
    projectId: ProjectId.make("work"),
  }),
  makeThreadShellFixture({
    environmentId: EnvironmentId.make("host"),
    id: ThreadId.make("work-two"),
    projectId: ProjectId.make("work"),
  }),
  makeThreadShellFixture({
    environmentId: EnvironmentId.make("host"),
    id: ThreadId.make("home-one"),
    projectId: ProjectId.make("home"),
  }),
];
const key = (thread: (typeof threads)[number]) => scopedThreadKey(thread.environmentId, thread.id);

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.preferences = { sidebarSpaces: { spaces: [work, home], activeSpaceId: "work" } };
  mocks.save.mockReset().mockImplementation((update) => {
    mocks.preferences = { ...mocks.preferences, ...update.transform(mocks.preferences) };
  });
  const root = createRoot(document.createElement("div"));
  const onSelectThread = vi.fn();
  const onClearThread = vi.fn();
  let spaces: ReturnType<typeof useSidebarSpaces>;
  function Consumer(props: {
    selection: SidebarSpaceThreadSelection;
    projects: readonly EnvironmentProject[];
  }) {
    const currentSpaces = useSidebarSpaces(props.selection, props.projects);
    useEffect(() => {
      spaces = currentSpaces;
    });
    return null;
  }
  return {
    render(
      selectedThreadKey: string | null,
      candidates = threads,
      projects: readonly EnvironmentProject[] = [],
    ) {
      act(() =>
        root.render(
          <Consumer
            projects={projects}
            selection={{ selectedThreadKey, threads: candidates, onSelectThread, onClearThread }}
          />,
        ),
      );
    },
    switchTo(id: string | null) {
      act(() => spaces.setActiveSpace(id));
    },
    editActive(projectRefs: readonly string[]) {
      act(() => spaces.updateSpace("work", { ...work, projectRefs }));
    },
    onSelectThread,
    onClearThread,
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

describe("iOS sidebar Space thread selection", () => {
  it("does not pop navigation when an environment disappears from a Machine Space", () => {
    using view = setup();
    mocks.preferences = {
      sidebarSpaces: {
        spaces: [{ ...work, groupBy: "machine", machineIds: ["host"] }],
        activeSpaceId: "work",
      },
    };
    const projects: EnvironmentProject[] = [
      {
        environmentId: EnvironmentId.make("host"),
        id: ProjectId.make("work"),
        title: "Work",
        workspaceRoot: "/work",
        repositoryIdentity: null,
        scripts: [],
        defaultModelSelection: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    view.render(key(threads[1]!), threads, projects);
    view.render(key(threads[1]!), []);
    expect(view.onClearThread).not.toHaveBeenCalled();
    expect(view.onSelectThread).not.toHaveBeenCalled();
  });
  it("restores each Space's own last-opened thread instead of retaining the outgoing thread", () => {
    using view = setup();
    view.render(key(threads[0]!));
    view.render(key(threads[1]!));
    view.switchTo("home");
    view.render(key(threads[1]!));
    expect(view.onSelectThread).toHaveBeenLastCalledWith(threads[2]);
    view.render(key(threads[2]!));
    view.switchTo("work");
    view.render(key(threads[2]!));
    expect(view.onSelectThread).toHaveBeenLastCalledWith(threads[1]);
  });

  it("clears the detail for an empty Space and restores the previous Space afterward", () => {
    using view = setup();
    view.render(key(threads[1]!));
    view.switchTo("home");
    view.render(key(threads[1]!), threads.slice(0, 2));
    expect(view.onClearThread).toHaveBeenCalledOnce();
    view.render(null, threads.slice(0, 2));
    view.switchTo("work");
    view.render(null);
    expect(view.onSelectThread).toHaveBeenLastCalledWith(threads[1]);
  });

  it("keeps separate memories for overlapping Spaces while navigation catches up", () => {
    using view = setup();
    mocks.preferences = {
      sidebarSpaces: {
        spaces: [work, { ...home, projectRefs: work.projectRefs }],
        activeSpaceId: "work",
      },
      sidebarSpaceLastThreadKeys: { "space:home": key(threads[0]!) },
    };
    view.render(key(threads[1]!));
    view.switchTo("home");
    view.render(key(threads[1]!));
    view.render(key(threads[1]!));
    expect(mocks.preferences.sidebarSpaceLastThreadKeys?.["space:home"]).toBe(key(threads[0]!));
    view.render(key(threads[0]!));
    view.switchTo("work");
    view.render(key(threads[0]!));
    expect(view.onSelectThread).toHaveBeenLastCalledWith(threads[1]);
  });

  it("restores All independently and ignores a boundary swipe that changes no Space", () => {
    using view = setup();
    mocks.preferences = {
      sidebarSpaces: { spaces: [work, home], activeSpaceId: null },
    };
    view.render(key(threads[2]!));
    view.switchTo("work");
    view.render(key(threads[2]!));
    view.render(key(threads[0]!));
    view.switchTo(null);
    view.render(key(threads[0]!));
    expect(view.onSelectThread).toHaveBeenLastCalledWith(threads[2]);
    view.render(key(threads[2]!));
    const calls = view.onSelectThread.mock.calls.length;
    view.switchTo(null);
    view.render(key(threads[2]!));
    expect(view.onSelectThread).toHaveBeenCalledTimes(calls);
  });

  it("falls back from an archived or removed remembered thread to the latest available thread", () => {
    using view = setup();
    mocks.preferences = {
      sidebarSpaces: { spaces: [work, home], activeSpaceId: "home" },
      sidebarSpaceLastThreadKeys: { "space:work": key(threads[0]!) },
    };
    const candidates = [
      { ...threads[0]!, archivedAt: "2026-10-27T00:00:00.000Z" },
      { ...threads[0]!, id: ThreadId.make("work-old"), updatedAt: "2025-01-01T00:00:00.000Z" },
      threads[1]!,
      threads[2]!,
    ];
    view.render(key(threads[2]!), candidates);
    view.switchTo("work");
    view.render(key(threads[2]!), candidates);
    expect(view.onSelectThread).toHaveBeenLastCalledWith(threads[1]);
  });

  it("restores the destination when its environment's threads load after the Space switch", () => {
    using view = setup();
    mocks.preferences = {
      sidebarSpaces: { spaces: [work, home], activeSpaceId: "work" },
      sidebarSpaceLastThreadKeys: { "space:home": key(threads[2]!) },
    };
    const loading = threads.slice(0, 2);
    view.render(key(threads[1]!), loading);
    view.switchTo("home");
    view.render(key(threads[1]!), loading);
    view.render(null, loading);
    expect(view.onClearThread).toHaveBeenCalledOnce();
    view.render(null);
    expect(view.onSelectThread).toHaveBeenLastCalledWith(threads[2]);
  });
  it("reconciles detail when editing the active Space excludes its open thread", () => {
    using view = setup();
    view.render(key(threads[1]!));
    view.editActive(home.projectRefs);
    view.render(key(threads[1]!));
    expect(view.onSelectThread).toHaveBeenLastCalledWith(threads[2]);
  });
});
