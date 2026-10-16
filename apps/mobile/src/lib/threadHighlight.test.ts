import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "./scopedEntities";
import {
  highlightMenuActions,
  sanitizeThreadHighlights,
  updateThreadHighlight,
} from "./threadHighlight";

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

  it("builds the palette menu under the given prefix with one selected choice", () => {
    const actions = highlightMenuActions("#3B82F6", { prefix: "x:", defaultTitle: "Default" });
    expect(actions[0]).toMatchObject({ id: "x:server", title: "Default", state: "off" });
    expect(actions.at(-1)).toMatchObject({ id: "x:none", title: "None", state: "off" });
    expect(actions.filter((action) => action.state === "on").map((action) => action.id)).toEqual([
      "x:#3b82f6",
    ]);
    expect(
      highlightMenuActions(undefined, { prefix: "x:", defaultTitle: "Default" })[0]?.state,
    ).toBe("on");
  });
});
