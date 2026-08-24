import { describe, expect, it } from "vite-plus/test";

import { MessageId, type OrchestrationMessageRole } from "@t3tools/contracts";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { latestAssistantText, mergeDraftWithTranscript } from "./evenG2ThreadBridge.logic";

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
