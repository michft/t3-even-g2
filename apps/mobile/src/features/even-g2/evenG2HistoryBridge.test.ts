import { describe, expect, it } from "vite-plus/test";

import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";

import {
  buildEvenG2Replies,
  createEvenG2HistoryBridge,
  EVEN_G2_REPLY_WINDOW_SIZE,
  type EvenG2HistoryBridgeDependencies,
  type EvenG2HistoryInput,
} from "./evenG2HistoryBridge";
import type {
  EvenG2HistoryPosition,
  EvenG2HistoryRequest,
  EvenG2ReplyHistorySnapshot,
} from "./evenG2Native";

/** Creates a minimal contract-shaped thread message for history tests. */
function message(id: string, role: OrchestrationMessage["role"], text: string) {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  } satisfies OrchestrationMessage;
}

/** Builds chronological user/assistant pairs with predictable reply IDs. */
function replies(start: number, count: number): ReadonlyArray<OrchestrationMessage> {
  return Array.from({ length: count }, (_, offset) => start + offset).flatMap((index) => [
    message(`user-${index}`, "user", `Prompt ${index}`),
    message(`assistant-${index}`, "assistant", `Reply ${index}`),
  ]);
}

/** Captures published snapshots and exposes native event emitters to tests. */
function makeHarness() {
  const snapshots: EvenG2ReplyHistorySnapshot[] = [];
  let positionListener: ((event: EvenG2HistoryPosition) => void) | undefined;
  let requestListener: ((event: EvenG2HistoryRequest) => void) | undefined;
  const dependencies: EvenG2HistoryBridgeDependencies = {
    /** Captures each snapshot sent to the simulated native module. */
    setReplyHistory: (snapshot) => snapshots.push(snapshot),
    /** Registers the simulated native position event listener. */
    subscribePositions: (listener) => {
      positionListener = listener;
      return () => {
        positionListener = undefined;
      };
    },
    /** Registers the simulated native history request listener. */
    subscribeRequests: (listener) => {
      requestListener = listener;
      return () => {
        requestListener = undefined;
      };
    },
  };
  return {
    snapshots,
    bridge: createEvenG2HistoryBridge(dependencies),
    /** Sends a simulated native cursor-position event. */
    position: (event: EvenG2HistoryPosition) => positionListener?.(event),
    /** Sends a simulated native navigation request. */
    request: (event: EvenG2HistoryRequest) => requestListener?.(event),
  };
}

/** Applies a history input update while filling defaults for unrelated fields. */
function update(
  bridge: ReturnType<typeof createEvenG2HistoryBridge>,
  input: Partial<EvenG2HistoryInput> & Pick<EvenG2HistoryInput, "threadKey">,
) {
  bridge.update({
    messages: [],
    hasOlder: false,
    loadingOlder: false,
    loadEarlier: null,
    ...input,
  });
}

describe("Even G2 reply history bridge", () => {
  it("uses assistant replies only and carries a short preceding user prompt", () => {
    const longPrompt = "a prompt with   enough words ".repeat(5);
    const result = buildEvenG2Replies([
      message("system", "system", "System text"),
      message("user", "user", longPrompt),
      message("reasoning", "reasoning", "Private reasoning"),
      message("assistant", "assistant", "A visible reply"),
    ]);

    expect(result).toEqual([
      {
        id: "assistant",
        text: "A visible reply",
        prompt: `${longPrompt.trim().replace(/\s+/g, " ").slice(0, 63)}…`,
      },
    ]);
  });

  it("starts at latest replies, then preserves the native anchor as new replies arrive", () => {
    const harness = makeHarness();
    const threadKey = "environment:thread-window";
    update(harness.bridge, { threadKey, messages: replies(0, 25) });
    expect(harness.snapshots.at(-1)).toMatchObject({
      startIndex: 5,
      totalReplies: 25,
      replies: expect.arrayContaining([
        { id: "assistant-24", text: "Reply 24", prompt: "Prompt 24" },
      ]),
      hasOlder: true,
      hasNewer: false,
    });

    harness.position({ threadKey, messageId: "assistant-10" });
    update(harness.bridge, { threadKey, messages: replies(0, 26) });
    expect(harness.snapshots.at(-1)).toMatchObject({
      startIndex: 5,
      hasNewer: true,
    });
    expect(harness.snapshots.at(-1)?.replies.map((reply) => reply.id)).toContain("assistant-10");
    harness.request({
      threadKey,
      anchorId: "assistant-10",
      direction: "latest",
      requestId: "latest-request",
    });
    expect(harness.snapshots.at(-1)).toMatchObject({
      startIndex: 6,
      latestReplyId: "assistant-25",
      requestId: "latest-request",
      hasNewer: false,
    });
    harness.bridge.dispose();

    const remounted = makeHarness();
    update(remounted.bridge, { threadKey, messages: undefined });
    expect(remounted.snapshots.at(-1)?.requestId).toBeUndefined();
    remounted.bridge.dispose();
  });

  it("coalesces older-page requests and responds with an overlapping correlated window", () => {
    const harness = makeHarness();
    const threadKey = "environment:thread-page";
    let loadCount = 0;
    const loadEarlier = () => {
      loadCount += 1;
      return true;
    };
    update(harness.bridge, {
      threadKey,
      messages: replies(20, EVEN_G2_REPLY_WINDOW_SIZE),
      hasOlder: true,
      loadEarlier,
    });

    const request: EvenG2HistoryRequest = {
      threadKey,
      anchorId: "assistant-20",
      direction: "older",
      requestId: "request-1",
    };
    harness.request(request);
    harness.request({ ...request, requestId: "request-2" });
    expect(loadCount).toBe(1);
    expect(harness.snapshots.at(-1)).toMatchObject({ loading: true, requestId: "request-1" });

    const olderMessages = [...replies(0, 20), ...replies(20, EVEN_G2_REPLY_WINDOW_SIZE)];
    update(harness.bridge, {
      threadKey,
      messages: olderMessages,
      hasOlder: true,
      loadingOlder: true,
      loadEarlier,
    });
    expect(harness.snapshots.at(-1)).toMatchObject({
      loading: true,
      requestId: "request-1",
      replies: expect.arrayContaining([
        { id: "assistant-20", text: "Reply 20", prompt: "Prompt 20" },
      ]),
      hasNewer: true,
    });

    update(harness.bridge, {
      threadKey,
      messages: olderMessages,
      hasOlder: true,
      loadingOlder: false,
      loadEarlier,
    });
    expect(harness.snapshots.at(-1)).toMatchObject({ loading: false, requestId: "request-1" });
    harness.bridge.dispose();
  });

  it("ignores wrong-thread requests, retains missing data, and clears on a real empty history", () => {
    const harness = makeHarness();
    const threadKey = "environment:thread-retained";
    update(harness.bridge, { threadKey, messages: replies(0, 2), hasOlder: true });
    const beforeMissing = harness.snapshots.at(-1);
    harness.request({
      threadKey: "other:thread",
      anchorId: "assistant-1",
      direction: "latest",
      requestId: "wrong-thread",
    });
    update(harness.bridge, { threadKey, messages: undefined });
    expect(harness.snapshots.at(-1)?.replies).toEqual(beforeMissing?.replies);
    expect(harness.snapshots.at(-1)?.hasOlder).toBe(true);
    expect(harness.snapshots.at(-1)?.requestId).toBeUndefined();
    harness.bridge.dispose();

    const remounted = makeHarness();
    update(remounted.bridge, { threadKey, messages: undefined });
    expect(remounted.snapshots.at(-1)?.replies).toEqual(beforeMissing?.replies);
    expect(remounted.snapshots.at(-1)?.hasOlder).toBe(true);

    update(remounted.bridge, { threadKey, messages: [] });
    expect(remounted.snapshots.at(-1)).toMatchObject({
      replies: [],
      totalReplies: 0,
      latestReplyId: "",
    });
    remounted.bridge.dispose();
  });

  it("leaves older replies retryable when the existing load path rejects a request", () => {
    const harness = makeHarness();
    const threadKey = "environment:thread-offline";
    update(harness.bridge, {
      threadKey,
      messages: replies(10, 20),
      hasOlder: true,
      loadEarlier: () => false,
    });
    harness.request({
      threadKey,
      anchorId: "assistant-10",
      direction: "older",
      requestId: "offline-request",
    });

    expect(harness.snapshots.at(-1)).toMatchObject({
      loading: false,
      hasOlder: true,
      requestId: "offline-request",
    });
    harness.bridge.dispose();
  });

  it("keeps a paging request pending until loading, a prepend, or exhaustion is observed", () => {
    const harness = makeHarness();
    const threadKey = "environment:thread-pending";
    const initial = replies(10, 20);
    update(harness.bridge, {
      threadKey,
      messages: initial,
      hasOlder: true,
      loadEarlier: () => true,
    });
    harness.request({
      threadKey,
      anchorId: "assistant-10",
      direction: "older",
      requestId: "pending",
    });

    update(harness.bridge, {
      threadKey,
      messages: initial,
      hasOlder: true,
      loadEarlier: () => true,
    });
    expect(harness.snapshots.at(-1)).toMatchObject({ loading: true, requestId: "pending" });
    harness.position({ threadKey, messageId: "assistant-10" });
    update(harness.bridge, {
      threadKey,
      messages: initial,
      hasOlder: true,
      loadEarlier: () => true,
    });
    expect(harness.snapshots.at(-1)?.loading).toBe(false);
    harness.bridge.dispose();
  });

  it("loads older history from an empty window and catches synchronous loader failures", () => {
    const harness = makeHarness();
    const threadKey = "environment:thread-empty-window";
    let loadCount = 0;
    update(harness.bridge, {
      threadKey,
      messages: [],
      hasOlder: true,
      loadEarlier: () => {
        loadCount += 1;
        throw new Error("offline");
      },
    });
    harness.request({ threadKey, anchorId: "", direction: "older", requestId: "empty-anchor" });
    expect(loadCount).toBe(1);
    expect(harness.snapshots.at(-1)).toMatchObject({
      loading: false,
      hasOlder: true,
      requestId: "empty-anchor",
    });
    harness.bridge.dispose();
  });

  it("does not publish empty history before an uncached thread has loaded", () => {
    const harness = makeHarness();
    update(harness.bridge, { threadKey: "environment:thread-not-loaded", messages: undefined });
    expect(harness.snapshots).toEqual([]);
    harness.bridge.dispose();
  });

  it("keeps a deleted anchor near its prior index and bounds each cached thread to one window", () => {
    const harness = makeHarness();
    const threadKey = "environment:thread-anchor-deleted";
    update(harness.bridge, { threadKey, messages: replies(0, 50) });
    harness.request({
      threadKey,
      anchorId: "assistant-20",
      direction: "newer",
      requestId: "center-anchor",
    });
    harness.position({ threadKey, messageId: "assistant-20" });
    const afterDelete = replies(0, 50).filter((message) => message.id !== "assistant-20");
    update(harness.bridge, { threadKey, messages: afterDelete });
    expect(harness.snapshots.at(-1)?.replies.map((reply) => reply.id)).toContain("assistant-21");
    expect(harness.snapshots.at(-1)?.replies).toHaveLength(EVEN_G2_REPLY_WINDOW_SIZE);
    harness.bridge.dispose();
  });
});
