import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, type RepositoryIdentity } from "@t3tools/contracts";
import { scopedProjectKey } from "./scopedEntities";
import {
  repositoryHighlightKey,
  resolveRepositoryHighlight,
  repositoryHighlightMenuActions,
} from "./repositoryHighlight";
import { THREAD_HIGHLIGHT_COLORS, updateThreadHighlight } from "./threadHighlight";

describe("device-local repository colours", () => {
  const first = scopedProjectKey(EnvironmentId.make("server"), ProjectId.make("repo-one"));
  const second = scopedProjectKey(EnvironmentId.make("server"), ProjectId.make("repo-two"));

  it("gives new threads and branches the same automatic colour for their repository", () => {
    const colour = resolveRepositoryHighlight(undefined, first);
    expect(THREAD_HIGHLIGHT_COLORS.some((choice) => choice.color === colour)).toBe(true);
    expect(resolveRepositoryHighlight(undefined, first)).toBe(colour);
    const automaticColours = new Set(
      Array.from({ length: 40 }, (_, index) =>
        resolveRepositoryHighlight(undefined, `server:repo-${index}`),
      ),
    );
    expect(automaticColours.size).toBe(THREAD_HIGHLIGHT_COLORS.length);
  });

  it("shares changes across a repository while keeping neighbouring repositories independent", () => {
    const colours = updateThreadHighlight({ [second]: "#3b82f6" }, first, "#ec4899");
    expect(resolveRepositoryHighlight(colours[first], first)).toBe("#ec4899");
    expect(resolveRepositoryHighlight(colours[second], second)).toBe("#3b82f6");
    const reset = updateThreadHighlight(colours, first, undefined);
    expect(resolveRepositoryHighlight(reset[first], first)).toBe(
      resolveRepositoryHighlight(undefined, first),
    );
    expect(reset[second]).toBe("#3b82f6");
  });

  it("can hide a repository tab and accepts any validated stored hex colour", () => {
    expect(resolveRepositoryHighlight("none", first)).toBeNull();
    expect(resolveRepositoryHighlight("#123abc", first)).toBe("#123abc");
  });

  it("shares known repository colours across clones, projects and servers", () => {
    const identity: RepositoryIdentity = {
      canonicalKey: "github.com/example/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/repo.git",
      },
    };
    const local = repositoryHighlightKey(
      identity,
      EnvironmentId.make("local"),
      ProjectId.make("one"),
    );
    const clone = repositoryHighlightKey(
      identity,
      EnvironmentId.make("remote"),
      ProjectId.make("two"),
    );
    expect(local).toBe(clone);
    const choices = updateThreadHighlight(undefined, local, "#ec4899");
    expect(resolveRepositoryHighlight(choices[clone], clone)).toBe("#ec4899");
  });

  it("keeps a fork's origin distinct from its tracked upstream", () => {
    const locator = {
      source: "git-remote" as const,
      remoteName: "upstream",
      remoteUrl: "https://github.com/example/upstream.git",
    };
    const upstream: RepositoryIdentity = { canonicalKey: "github.com/example/upstream", locator };
    const fork: RepositoryIdentity = {
      ...upstream,
      origin: {
        canonicalKey: "github.com/example/fork",
        displayName: "example/fork",
      },
    };
    expect(
      repositoryHighlightKey(fork, EnvironmentId.make("server"), ProjectId.make("one")),
    ).not.toBe(
      repositoryHighlightKey(upstream, EnvironmentId.make("server"), ProjectId.make("two")),
    );
  });

  it("falls back to isolated project colours when repository identity is missing", () => {
    const local = repositoryHighlightKey(null, EnvironmentId.make("local"), ProjectId.make("same"));
    const remote = repositoryHighlightKey(
      undefined,
      EnvironmentId.make("remote"),
      ProjectId.make("same"),
    );
    expect(local).not.toBe(remote);
    const choices = updateThreadHighlight({ [local]: "#ec4899" }, remote, "#3b82f6");
    expect(choices[local]).toBe("#ec4899");
    expect(choices[remote]).toBe("#3b82f6");
  });

  it("keeps repository menu events separate from legacy per-thread events", () => {
    const actions = repositoryHighlightMenuActions("#ec4899");
    expect(actions.every((action) => action.id?.startsWith("repository-highlight:"))).toBe(true);
    expect(actions.find((action) => action.title === "Pink")?.state).toBe("on");
    expect(actions[0]?.title).toBe("Automatic");
    expect(actions.some((action) => action.title === "Cyan")).toBe(true);
  });
});
