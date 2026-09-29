import type { OrchestrationMessage } from "@t3tools/contracts";

import type {
  EvenG2HistoryPosition,
  EvenG2HistoryRequest,
  EvenG2ReplyHistoryItem,
  EvenG2ReplyHistorySnapshot,
} from "./evenG2Native";

export const EVEN_G2_REPLY_WINDOW_SIZE = 20;
const HISTORY_CACHE_LIMIT = 8;
const PROMPT_LABEL_LIMIT = 64;

export interface EvenG2HistoryInput {
  readonly threadKey: string;
  readonly messages: ReadonlyArray<OrchestrationMessage> | undefined;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** Requests another older page and returns whether the request was accepted. */
  readonly loadEarlier: (() => boolean | void) | null;
}

export interface EvenG2HistoryBridgeDependencies {
  /** Sends a new bounded history window to the native module. */
  readonly setReplyHistory: (snapshot: EvenG2ReplyHistorySnapshot) => void;
  /** Subscribes to native cursor-position updates. */
  readonly subscribePositions: (listener: (event: EvenG2HistoryPosition) => void) => () => void;
  /** Subscribes to native older/newer/latest navigation requests. */
  readonly subscribeRequests: (listener: (event: EvenG2HistoryRequest) => void) => () => void;
}

interface CachedHistory {
  readonly snapshot: EvenG2ReplyHistorySnapshot;
  readonly anchorId: string | null;
  readonly anchorOffset: number;
}

interface PendingOlderRequest {
  readonly request: EvenG2HistoryRequest;
  readonly messageIds: ReadonlyArray<string>;
  loadingObserved: boolean;
}

const historyByThread = new Map<string, CachedHistory>();

/** Builds the displayable assistant replies and their nearest preceding user prompt. */
export function buildEvenG2Replies(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<EvenG2ReplyHistoryItem> {
  let prompt = "";
  const replies: EvenG2ReplyHistoryItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      prompt = shortPromptLabel(message.text);
    } else if (message.role === "assistant" && message.text.trim().length > 0) {
      replies.push({ id: String(message.id), text: message.text, prompt });
    }
  }
  return replies;
}

/** Normalizes a prompt for the glasses' compact history label. */
function shortPromptLabel(text: string): string {
  const label = text.trim().replace(/\s+/g, " ");
  return label.length > PROMPT_LABEL_LIMIT ? `${label.slice(0, PROMPT_LABEL_LIMIT - 1)}…` : label;
}

/** Returns stable IDs used to detect a newly loaded page. */
function messageIds(messages: ReadonlyArray<OrchestrationMessage>): ReadonlyArray<string> {
  return messages.map((message) => String(message.id));
}

/** Compares thread pages without serializing their message IDs. */
function sameMessageIds(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Finds the first index of the newest full-size window. */
function maximumStart(total: number): number {
  return Math.max(0, total - EVEN_G2_REPLY_WINDOW_SIZE);
}

/** Builds a bounded native snapshot while retaining global reply indexes. */
function makeSnapshot(
  threadKey: string,
  replies: ReadonlyArray<EvenG2ReplyHistoryItem>,
  requestedStart: number,
  hasOlderOutsideWindow: boolean,
  loading: boolean,
  requestId?: string,
): EvenG2ReplyHistorySnapshot {
  const startIndex = Math.min(maximumStart(replies.length), Math.max(0, requestedStart));
  const window = replies.slice(startIndex, startIndex + EVEN_G2_REPLY_WINDOW_SIZE);
  return {
    threadKey,
    replies: window,
    startIndex,
    totalReplies: replies.length,
    hasOlder: hasOlderOutsideWindow || startIndex > 0,
    hasNewer: startIndex + window.length < replies.length,
    latestReplyId: replies.at(-1)?.id ?? "",
    loading,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/** Keeps the anchored reply at its existing slot when the loaded history changes. */
function preserveWindowStart(
  replies: ReadonlyArray<EvenG2ReplyHistoryItem>,
  previous: CachedHistory | undefined,
): number {
  if (!previous) return maximumStart(replies.length);
  const anchorIndex = previous.anchorId
    ? replies.findIndex((reply) => reply.id === previous.anchorId)
    : -1;
  const oldAnchorOffset = previous.snapshot.replies.findIndex(
    (reply) => reply.id === previous.anchorId,
  );
  if (anchorIndex >= 0 && oldAnchorOffset >= 0) {
    return anchorIndex - oldAnchorOffset;
  }
  const oldWindow = previous.snapshot.replies;
  for (let distance = 1; distance < oldWindow.length; distance += 1) {
    for (const oldOffset of [previous.anchorOffset - distance, previous.anchorOffset + distance]) {
      const oldReply = oldWindow[oldOffset];
      const survivingIndex = oldReply ? replies.findIndex((reply) => reply.id === oldReply.id) : -1;
      if (survivingIndex >= 0) return survivingIndex - oldOffset;
    }
  }
  return Math.min(previous.snapshot.startIndex, maximumStart(replies.length));
}

/** Keeps only the most recently used thread histories in the route-remount cache. */
function rememberHistory(threadKey: string, history: CachedHistory): void {
  const snapshot: Omit<EvenG2ReplyHistorySnapshot, "requestId"> = {
    threadKey: history.snapshot.threadKey,
    replies: history.snapshot.replies,
    startIndex: history.snapshot.startIndex,
    totalReplies: history.snapshot.totalReplies,
    hasOlder: history.snapshot.hasOlder,
    hasNewer: history.snapshot.hasNewer,
    latestReplyId: history.snapshot.latestReplyId,
    loading: history.snapshot.loading,
  };
  historyByThread.delete(threadKey);
  historyByThread.set(threadKey, { ...history, snapshot });
  if (historyByThread.size > HISTORY_CACHE_LIMIT) {
    const oldest = historyByThread.keys().next().value;
    if (oldest !== undefined) historyByThread.delete(oldest);
  }
}

/** Coordinates native history navigation with the currently loaded thread window. */
export function createEvenG2HistoryBridge(dependencies: EvenG2HistoryBridgeDependencies) {
  let input: EvenG2HistoryInput | undefined;
  let replies: ReadonlyArray<EvenG2ReplyHistoryItem> = [];
  let pendingOlder: PendingOlderRequest | undefined;
  let disposed = false;

  /** Sends a window and stores its anchor for later route or feed updates. */
  const publish = (
    threadKey: string,
    nextReplies: ReadonlyArray<EvenG2ReplyHistoryItem>,
    startIndex: number,
    loading: boolean,
    requestId?: string,
    hasOlderOverride?: boolean,
  ) => {
    const next = makeSnapshot(
      threadKey,
      nextReplies,
      startIndex,
      hasOlderOverride ?? (input?.threadKey === threadKey && input.hasOlder),
      loading,
      requestId,
    );
    const previous = historyByThread.get(threadKey);
    const previousAnchor = previous?.anchorId;
    const anchorOffset = next.replies.findIndex((reply) => reply.id === previousAnchor);
    rememberHistory(threadKey, {
      snapshot: next,
      anchorId:
        previousAnchor && anchorOffset >= 0 ? previousAnchor : (next.replies[0]?.id ?? null),
      anchorOffset: anchorOffset >= 0 ? anchorOffset : 0,
    });
    dependencies.setReplyHistory(next);
  };

  /** Remembers native cursor movement only for the currently active thread. */
  const onPosition = (event: EvenG2HistoryPosition) => {
    const current = input;
    if (disposed || current?.threadKey !== event.threadKey) return;
    const cached = historyByThread.get(event.threadKey);
    if (event.messageId.length === 0) {
      pendingOlder = undefined;
      return;
    }
    const anchorOffset =
      cached?.snapshot.replies.findIndex((reply) => reply.id === event.messageId) ?? -1;
    if (!cached || anchorOffset < 0) return;
    pendingOlder = undefined;
    rememberHistory(event.threadKey, { ...cached, anchorId: event.messageId, anchorOffset });
  };

  /** Answers native navigation requests or starts the existing older-page load. */
  const onRequest = (request: EvenG2HistoryRequest) => {
    const current = input;
    if (disposed || current?.threadKey !== request.threadKey) return;
    const history = historyByThread.get(request.threadKey);
    const hasOlder =
      current.hasOlder || (current.messages === undefined && history?.snapshot.hasOlder);
    if (current.messages === undefined && !history) return;
    if (current.messages === undefined && history) {
      if (request.direction === "older" && hasOlder && !pendingOlder) {
        pendingOlder = { request, messageIds: [], loadingObserved: current.loadingOlder };
        let accepted: boolean | void;
        try {
          accepted = current.loadEarlier?.();
        } catch {
          accepted = false;
        }
        if (accepted === false || current.loadEarlier === null) {
          pendingOlder = undefined;
          dependencies.setReplyHistory({
            ...history.snapshot,
            loading: false,
            requestId: request.requestId,
          });
        } else {
          dependencies.setReplyHistory({
            ...history.snapshot,
            loading: true,
            requestId: request.requestId,
          });
        }
      } else {
        dependencies.setReplyHistory({
          ...history.snapshot,
          loading: false,
          requestId: request.requestId,
        });
      }
      return;
    }
    const requestAnchorIndex = replies.findIndex((reply) => reply.id === request.anchorId);
    if (request.direction === "older" && requestAnchorIndex <= 0 && hasOlder) {
      if (pendingOlder) return;
      pendingOlder = {
        request,
        messageIds: current.messages ? messageIds(current.messages) : [],
        loadingObserved: current.loadingOlder,
      };
      if (!current.loadingOlder) {
        let accepted: boolean | void;
        try {
          accepted = current.loadEarlier?.();
        } catch {
          accepted = false;
        }
        if (accepted === false || current.loadEarlier === null) {
          pendingOlder = undefined;
          publish(
            request.threadKey,
            replies,
            history?.snapshot.startIndex ?? maximumStart(replies.length),
            false,
            request.requestId,
            true,
          );
          return;
        }
      }
      publish(
        request.threadKey,
        replies,
        history?.snapshot.startIndex ?? maximumStart(replies.length),
        true,
        request.requestId,
        true,
      );
      return;
    }

    let startIndex = history?.snapshot.startIndex ?? maximumStart(replies.length);
    if (request.direction === "latest") {
      startIndex = maximumStart(replies.length);
    } else if (requestAnchorIndex >= 0) {
      startIndex =
        request.direction === "older"
          ? requestAnchorIndex - (EVEN_G2_REPLY_WINDOW_SIZE - 1)
          : requestAnchorIndex;
    }
    pendingOlder = undefined;
    rememberHistory(request.threadKey, {
      snapshot:
        history?.snapshot ??
        makeSnapshot(request.threadKey, replies, startIndex, Boolean(hasOlder), false),
      anchorId: request.anchorId,
      anchorOffset: Math.max(0, requestAnchorIndex - startIndex),
    });
    publish(request.threadKey, replies, startIndex, false, request.requestId, Boolean(hasOlder));
  };

  const unsubscribePosition = dependencies.subscribePositions(onPosition);
  const unsubscribeRequest = dependencies.subscribeRequests(onRequest);

  return {
    /** Updates the window after messages or thread pagination state changes. */
    update(nextInput: EvenG2HistoryInput): void {
      if (disposed) return;
      const previousInput = input;
      if (previousInput?.threadKey !== nextInput.threadKey) {
        pendingOlder = undefined;
        replies = [];
      }
      input = nextInput;
      const cached = historyByThread.get(nextInput.threadKey);

      if (nextInput.messages === undefined) {
        if (cached) {
          replies = cached.snapshot.replies;
          if (pendingOlder && nextInput.loadingOlder) pendingOlder.loadingObserved = true;
          const pageFinished = pendingOlder?.loadingObserved && !nextInput.loadingOlder;
          const completedRequest = pageFinished ? pendingOlder : undefined;
          const pending = completedRequest ? undefined : pendingOlder;
          if (pageFinished) pendingOlder = undefined;
          const snapshot = {
            ...cached.snapshot,
            hasOlder: cached.snapshot.hasOlder || nextInput.hasOlder,
            loading: pending !== undefined,
            ...((pending ?? completedRequest)
              ? { requestId: (pending ?? completedRequest)?.request.requestId }
              : {}),
          };
          rememberHistory(nextInput.threadKey, { ...cached, snapshot });
          dependencies.setReplyHistory(snapshot);
        }
        return;
      }

      const nextReplies = buildEvenG2Replies(nextInput.messages);
      replies = nextReplies;
      if (nextInput.messages.length === 0) {
        pendingOlder = undefined;
        const empty = makeSnapshot(nextInput.threadKey, [], 0, false, false);
        rememberHistory(nextInput.threadKey, { snapshot: empty, anchorId: null, anchorOffset: 0 });
        dependencies.setReplyHistory(empty);
        return;
      }

      const currentPending = pendingOlder;
      if (currentPending) {
        const nextMessageIds = messageIds(nextInput.messages);
        const baselineFirstId = currentPending.messageIds[0];
        const didPrependMessages =
          !sameMessageIds(nextMessageIds, currentPending.messageIds) &&
          baselineFirstId !== undefined &&
          nextMessageIds.indexOf(baselineFirstId) > 0;
        const prior = historyByThread.get(nextInput.threadKey);
        if (nextInput.loadingOlder) currentPending.loadingObserved = true;
        const pageFinished =
          !nextInput.loadingOlder &&
          (didPrependMessages || !nextInput.hasOlder || currentPending.loadingObserved);
        const anchorIndex = nextReplies.findIndex(
          (reply) => reply.id === currentPending.request.anchorId,
        );
        const requestedStart =
          currentPending.request.direction === "older" && didPrependMessages && anchorIndex >= 0
            ? anchorIndex - (EVEN_G2_REPLY_WINDOW_SIZE - 1)
            : (prior?.snapshot.startIndex ?? maximumStart(nextReplies.length));
        publish(
          nextInput.threadKey,
          nextReplies,
          requestedStart,
          !pageFinished,
          currentPending.request.requestId,
        );
        if (pageFinished) pendingOlder = undefined;
        return;
      }

      const startIndex = cached
        ? preserveWindowStart(nextReplies, cached)
        : maximumStart(nextReplies.length);
      publish(nextInput.threadKey, nextReplies, startIndex, nextInput.loadingOlder);
    },
    /** Stops native listeners without clearing the per-thread history cache. */
    dispose(): void {
      disposed = true;
      unsubscribePosition();
      unsubscribeRequest();
    },
  };
}
