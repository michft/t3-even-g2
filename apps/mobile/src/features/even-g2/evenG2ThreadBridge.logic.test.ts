import { describe, expect, it } from "vite-plus/test";

import { evenG2ThreadActivityText, mergeDraftWithTranscript } from "./evenG2ThreadBridge.logic";

describe("Even G2 thread bridge", () => {
  it("shows submission, work, and blocking states without waiting for an assistant message", () => {
    const idle = {
      connected: true,
      hasError: false,
      needsApproval: false,
      needsInput: false,
      queued: false,
      working: false,
    };
    expect(evenG2ThreadActivityText({ ...idle, queued: true })).toBe("Sending to T3 Code…");
    expect(evenG2ThreadActivityText({ ...idle, working: true })).toBe("Thinking…");
    expect(evenG2ThreadActivityText({ ...idle, queued: true, working: true })).toBe(
      "Sending to T3 Code…",
    );
    expect(evenG2ThreadActivityText({ ...idle, working: true, connected: false })).toBe(
      "Waiting for connection…",
    );
    expect(evenG2ThreadActivityText({ ...idle, working: true, hasError: true })).toBe(
      "Check error on phone",
    );
    expect(evenG2ThreadActivityText({ ...idle, working: true, needsApproval: true })).toBe(
      "Approval needed on phone",
    );
    expect(evenG2ThreadActivityText({ ...idle, working: true, needsInput: true })).toBe(
      "Answer needed on phone",
    );
    expect(evenG2ThreadActivityText(idle)).toBe("");
  });

  it("keeps an existing typed draft separate from live dictation", () => {
    expect(mergeDraftWithTranscript("Keep this draft", "spoken words")).toBe(
      "Keep this draft\n\nspoken words",
    );
    expect(mergeDraftWithTranscript("", "spoken words")).toBe("spoken words");
  });

  it("ignores whitespace-only speech without rewriting the draft", () => {
    expect(mergeDraftWithTranscript("  keep exact spacing  ", " \n ")).toBe(
      "  keep exact spacing  ",
    );
  });

  it("does not add another separator after a draft newline", () => {
    expect(mergeDraftWithTranscript("First line\n", "  second line  ")).toBe(
      "First line\nsecond line",
    );
  });
});
