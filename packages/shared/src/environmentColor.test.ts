import { describe, expect, it } from "vite-plus/test";
import { environmentColorForeground } from "./environmentColor.ts";

describe("solid origin color text contrast", () => {
  it.each([
    ["#000000", "#ffffff"],
    ["#ffffff", "#000000"],
    ["#ff0000", "#000000"],
    ["#00ff00", "#000000"],
    ["#0000ff", "#ffffff"],
    ["#777777", "#000000"],
    ["#123456", "#ffffff"],
  ])("chooses readable text on %s", (background, foreground) => {
    expect(environmentColorForeground(background)).toBe(foreground);
  });
});
