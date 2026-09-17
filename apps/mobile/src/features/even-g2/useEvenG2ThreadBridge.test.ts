import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MessageId } from "@t3tools/contracts";

import type { EvenG2TranscriptEvent } from "./evenG2Native";
import { subscribeEvenG2Dictation } from "./useEvenG2ThreadBridge";

const native = vi.hoisted(() => ({
  listening: false,
  statusListeners: new Set<() => void>(),
  transcriptListeners: new Set<(event: EvenG2TranscriptEvent) => void>(),
}));

vi.mock("./evenG2Native", () => ({
  displayEvenG2Text: vi.fn(),
  ensureEvenG2AutoConnect: vi.fn(),
  setEvenG2InputEnabled: vi.fn(),
  getEvenG2Status: () => ({ listening: native.listening }),
  subscribeEvenG2Status: (listener: () => void) => {
    native.statusListeners.add(listener);
    return () => native.statusListeners.delete(listener);
  },
  subscribeEvenG2Transcripts: (listener: (event: EvenG2TranscriptEvent) => void) => {
    native.transcriptListeners.add(listener);
    return () => native.transcriptListeners.delete(listener);
  },
}));

const drafts = new Map<string, string>();
const sent: Array<{ threadKey: string; text: string }> = [];
let unsubscribe: (() => void) | undefined;

function thread(threadKey: string, draftMessage: string) {
  drafts.set(threadKey, draftMessage);
  return {
    threadKey,
    draftMessage,
    onChangeDraftMessage: (text: string) => drafts.set(threadKey, text),
    onSendTextMessage: async (text: string): Promise<MessageId | null> => {
      sent.push({ threadKey, text });
      return null;
    },
  };
}

function startListening() {
  native.listening = true;
  native.statusListeners.forEach((listener) => listener());
}

function transcript(event: EvenG2TranscriptEvent) {
  native.transcriptListeners.forEach((listener) => listener(event));
}

beforeEach(() => {
  native.listening = false;
  drafts.clear();
  sent.length = 0;
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.restoreAllMocks();
});

describe("Even G2 dictation sessions", () => {
  it("uses an established thread's send handler while preserving the session's original draft", () => {
    let input: ReturnType<typeof thread> = {
      ...thread("a", "draft A"),
      onSendTextMessage: async () => null,
    };
    unsubscribe = subscribeEvenG2Dictation(() => input);
    startListening();
    transcript({ text: "partial", isFinal: false });

    input = thread("a", "draft A\n\npartial");
    transcript({ text: "send after creation", isFinal: true });

    expect(drafts.get("a")).toBe("draft A");
    expect(sent).toEqual([{ threadKey: "a", text: "send after creation" }]);
  });

  it("keeps partials, draft restoration and submission on the originating thread after navigation", () => {
    let input = thread("environment-a:thread", "draft A");
    unsubscribe = subscribeEvenG2Dictation(() => input);
    startListening();
    input = thread("environment-b:thread", "draft B");

    transcript({ text: "partial", isFinal: false });
    expect(drafts.get("environment-a:thread")).toBe("draft A\n\npartial");
    expect(drafts.get("environment-b:thread")).toBe("draft B");
    transcript({ text: "  send this  ", isFinal: true });
    expect(drafts.get("environment-a:thread")).toBe("draft A");
    expect(drafts.get("environment-b:thread")).toBe("draft B");
    expect(sent).toEqual([{ threadKey: "environment-a:thread", text: "send this" }]);

    startListening();
    transcript({ text: "next session", isFinal: true });
    expect(sent[1]).toEqual({ threadKey: "environment-b:thread", text: "next session" });
  });

  it("restores the original draft on cleanup even after the route changes", () => {
    let input = thread("a", "draft A");
    unsubscribe = subscribeEvenG2Dictation(() => input);
    transcript({ text: "partial", isFinal: false });
    input = thread("b", "draft B");
    unsubscribe();
    transcript({ text: "late result", isFinal: true });

    expect(drafts.get("a")).toBe("draft A");
    expect(drafts.get("b")).toBe("draft B");
    expect(sent).toEqual([]);
  });

  it("cancels without sending or overwriting the next thread's draft", () => {
    let input = thread("a", "draft A");
    unsubscribe = subscribeEvenG2Dictation(() => input);
    startListening();
    transcript({ text: "partial", isFinal: false });
    input = thread("b", "draft B");
    transcript({ text: "partial", isFinal: true, cancelled: true });

    expect(drafts.get("a")).toBe("draft A");
    expect(drafts.get("b")).toBe("draft B");
    expect(sent).toEqual([]);
  });

  it("handles send rejection without blocking the next dictation session", async () => {
    const pending = Promise.withResolvers<MessageId | null>();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let input: ReturnType<typeof thread> = {
      ...thread("a", "draft A"),
      onSendTextMessage: () => pending.promise,
    };
    unsubscribe = subscribeEvenG2Dictation(() => input);
    startListening();
    transcript({ text: "send this", isFinal: true });

    input = thread("b", "draft B");
    startListening();
    transcript({ text: "another command", isFinal: true });
    expect(sent).toEqual([{ threadKey: "b", text: "another command" }]);

    const failure = new Error("send failed");
    pending.reject(failure);
    await pending.promise.catch(() => {});
    expect(log).toHaveBeenCalledWith("[even-g2] Failed to send dictated message", "a", failure);
    expect(drafts.get("a")).toBe("draft A");
    expect(drafts.get("b")).toBe("draft B");
  });
});
