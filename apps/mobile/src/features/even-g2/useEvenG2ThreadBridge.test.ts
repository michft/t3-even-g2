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
  /** Records auto-connect requests from the bridge under test. */
  ensureEvenG2AutoConnect: vi.fn(),
  /** Records which thread the bridge marks active. */
  setEvenG2ActiveThread: vi.fn(),
  /** Exposes the current mock listening flag to the bridge. */
  getEvenG2Status: () => ({ listening: native.listening }),
  /** Stubs history snapshot writes; this suite exercises dictation only. */
  setEvenG2ReplyHistory: vi.fn(),
  /** Provides an inert position subscription for dictation-only tests. */
  subscribeEvenG2HistoryPositions: vi.fn(() => () => {}),
  /** Provides an inert request subscription for dictation-only tests. */
  subscribeEvenG2HistoryRequests: vi.fn(() => () => {}),
  /** Tracks active status listeners and removes each one on cleanup. */
  subscribeEvenG2Status: (listener: () => void) => {
    native.statusListeners.add(listener);
    return () => native.statusListeners.delete(listener);
  },
  /** Tracks transcript listeners until their subscriptions are cleaned up. */
  subscribeEvenG2Transcripts: (listener: (event: EvenG2TranscriptEvent) => void) => {
    native.transcriptListeners.add(listener);
    return () => native.transcriptListeners.delete(listener);
  },
}));

const drafts = new Map<string, string>();
const sent: Array<{ threadKey: string; text: string }> = [];
let unsubscribe: (() => void) | undefined;

/** Creates a thread input whose draft and send handler are tracked by thread key. */
function thread(threadKey: string, draftMessage: string) {
  drafts.set(threadKey, draftMessage);
  return {
    threadKey,
    draftMessage,
    /** Stores draft changes against this fixture's originating thread. */
    onChangeDraftMessage: (text: string) => drafts.set(threadKey, text),
    /** Records dictated messages without creating a real outbox entry. */
    onSendTextMessage: async (text: string): Promise<MessageId | null> => {
      sent.push({ threadKey, text });
      return null;
    },
  };
}

/** Simulates the native status event that starts a dictation session. */
function startListening() {
  native.listening = true;
  native.statusListeners.forEach((listener) => listener());
}

/** Sends a test transcript through every active native transcript listener. */
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
      /** Models a pending thread that cannot yet accept a message. */
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

  it("starts a fresh dictation after a page-exit cancellation without sending the abandoned partial", () => {
    let input = thread("a", "original draft");
    unsubscribe = subscribeEvenG2Dictation(() => input);
    startListening();
    transcript({ text: "abandoned partial", isFinal: false });
    native.listening = false;
    transcript({ text: "", isFinal: true, cancelled: true });

    expect(drafts.get("a")).toBe("original draft");
    expect(sent).toEqual([]);

    input = thread("a", "edited after recovery");
    startListening();
    transcript({ text: "new dictation", isFinal: true });

    expect(drafts.get("a")).toBe("edited after recovery");
    expect(sent).toEqual([{ threadKey: "a", text: "new dictation" }]);
  });

  it("handles send rejection without blocking the next dictation session", async () => {
    const pending = Promise.withResolvers<MessageId | null>();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let input: ReturnType<typeof thread> = {
      ...thread("a", "draft A"),
      /** Holds submission open so the test can reject it after a new session starts. */
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
