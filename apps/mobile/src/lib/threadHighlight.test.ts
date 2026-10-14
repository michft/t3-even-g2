import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "./scopedEntities";
import { sanitizeThreadHighlights, updateThreadHighlight } from "./threadHighlight";

describe("device-local thread highlights", () => {
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
