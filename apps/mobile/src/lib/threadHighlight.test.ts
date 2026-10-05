import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "./scopedEntities";
import {
  resolveThreadHighlight,
  sanitizeThreadHighlights,
  updateThreadHighlight,
} from "./threadHighlight";

describe("device-local thread highlights", () => {
  it("inherits live server colours until a custom override, then returns to inheritance on reset", () => {
    const key = scopedThreadKey(EnvironmentId.make("mini"), ThreadId.make("thread"));
    let highlights = updateThreadHighlight(undefined, key, "#ec4899");
    expect(resolveThreadHighlight(undefined, "#22c55e")).toBe("#22c55e");
    expect(resolveThreadHighlight(highlights[key], "#22c55e")).toBe("#ec4899");
    expect(resolveThreadHighlight(highlights[key], "#f97316")).toBe("#ec4899");
    highlights = updateThreadHighlight(highlights, key, undefined);
    expect(Object.hasOwn(highlights, key)).toBe(false);
    expect(resolveThreadHighlight(highlights[key], "#f97316")).toBe("#f97316");
  });

  it("supports hiding and custom colours even without a server default", () => {
    expect(resolveThreadHighlight("none", "#22c55e")).toBeNull();
    expect(resolveThreadHighlight("#ec4899", null)).toBe("#ec4899");
    expect(resolveThreadHighlight(undefined, null)).toBeNull();
  });

  it("isolates the same thread id on different environments and preserves other overrides", () => {
    const thread = ThreadId.make("same-id");
    const mini = scopedThreadKey(EnvironmentId.make("mini"), thread);
    const beef = scopedThreadKey(EnvironmentId.make("beef"), thread);
    const first = updateThreadHighlight(undefined, mini, "#ec4899");
    const second = updateThreadHighlight(first, beef, "none");
    expect(second).toEqual({ [mini]: "#ec4899", [beef]: "none" });
    expect(updateThreadHighlight(second, mini, undefined)).toEqual({ [beef]: "none" });
    expect(first).toEqual({ [mini]: "#ec4899" });
  });

  it("drops malformed stored overrides while retaining valid choices", () => {
    expect(
      sanitizeThreadHighlights({
        a: "#ABCDEF",
        b: "none",
        c: "server",
        d: "red",
        e: "#123",
        f: 1,
        "": "none",
      }),
    ).toEqual({ a: "#ABCDEF", b: "none" });
    expect(sanitizeThreadHighlights(["#abcdef"])).toEqual({});
  });
});
