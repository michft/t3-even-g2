import { describe, expect, it } from "vite-plus/test";

import { MessageId, type OrchestrationMessageRole } from "@t3tools/contracts";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  evenG2ThreadActivityText,
  latestAssistantText,
  mergeDraftWithTranscript,
} from "./evenG2ThreadBridge.logic";

/** Builds a feed message for checking which reply text reaches the bridge. */
function messageEntry(id: string, role: OrchestrationMessageRole, text: string): ThreadFeedEntry {
  const messageId = MessageId.make(id);
  return {
    type: "message",
    id: messageId,
    createdAt: "2026-08-25T00:00:00.000Z",
    message: {
      id: messageId,
      role,
      text,
      turnId: null,
      streaming: false,
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
  };
}

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

  it("selects the latest non-empty assistant text", () => {
    const feed = [
      messageEntry("assistant-1", "assistant", "First answer"),
      messageEntry("user-1", "user", "Next question"),
      messageEntry("assistant-empty", "assistant", "  "),
      messageEntry("assistant-2", "assistant", "Latest answer"),
    ];

    expect(latestAssistantText(feed)).toBe("Latest answer");
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

  it("trims only the selected assistant message", () => {
    const feed = [
      messageEntry("assistant-1", "assistant", "  First answer  "),
      messageEntry("user-1", "user", "Ignore me"),
      messageEntry("assistant-2", "assistant", "\n Latest answer 🙂 \n"),
    ];

    expect(latestAssistantText(feed)).toBe("Latest answer 🙂");
  });

  it("returns null when no assistant message has visible text", () => {
    const feed = [
      messageEntry("user-1", "user", "Question"),
      messageEntry("assistant-empty", "assistant", " \n "),
    ];

    expect(latestAssistantText(feed)).toBeNull();
  });
});
