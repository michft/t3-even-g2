import { useEffect, useLayoutEffect, useRef } from "react";

import type { MessageId, OrchestrationMessage } from "@t3tools/contracts";

import {
  ensureEvenG2AutoConnect,
  subscribeEvenG2Status,
  subscribeEvenG2Transcripts,
  getEvenG2Status,
  setEvenG2ActiveThread,
  setEvenG2ReplyHistory,
  subscribeEvenG2HistoryPositions,
  subscribeEvenG2HistoryRequests,
} from "./evenG2Native";
import { mergeDraftWithTranscript } from "./evenG2ThreadBridge.logic";
import { createEvenG2HistoryBridge } from "./evenG2HistoryBridge";

interface EvenG2DictationInput {
  readonly threadKey: string;
  readonly draftMessage: string;
  /** Updates the originating thread's draft during dictation and restoration. */
  readonly onChangeDraftMessage: (value: string) => void;
  /** Queues dictated text, returning null when the thread cannot accept a message. */
  readonly onSendTextMessage: (text: string) => Promise<MessageId | null>;
}

/** Keeps dictation attached to its starting thread and sends completed speech there. */
export function subscribeEvenG2Dictation(getInput: () => EvenG2DictationInput): () => void {
  let session: EvenG2DictationInput | null = null;
  /** Pins first dictation input to its thread, while refreshing callbacks on that thread. */
  const captureSession = () => {
    const { threadKey, draftMessage, onChangeDraftMessage, onSendTextMessage } = getInput();
    if (session === null) {
      session = { threadKey, draftMessage, onChangeDraftMessage, onSendTextMessage };
    } else if (session.threadKey === threadKey) {
      // Creation/model state can change mid-dictation, but another route's
      // callbacks must never take ownership of this session.
      session = { ...session, onChangeDraftMessage, onSendTextMessage };
    }
    return session;
  };

  ensureEvenG2AutoConnect();
  setEvenG2ActiveThread(getInput().threadKey, true);
  const unsubscribeStatus = subscribeEvenG2Status(() => {
    if (getEvenG2Status().listening) {
      captureSession();
    }
  });
  const unsubscribeTranscripts = subscribeEvenG2Transcripts((event) => {
    const origin = captureSession();
    if (!event.isFinal) {
      origin.onChangeDraftMessage(mergeDraftWithTranscript(origin.draftMessage, event.text));
      return;
    }

    origin.onChangeDraftMessage(
      event.interrupted
        ? mergeDraftWithTranscript(origin.draftMessage, event.text)
        : origin.draftMessage,
    );
    session = null;
    const command = event.text.trim();
    if (!event.cancelled && !event.interrupted && command.length > 0) {
      void origin.onSendTextMessage(command).catch((error: unknown) => {
        console.error("[even-g2] Failed to send dictated message", origin.threadKey, error);
      });
    }
  });
  if (getEvenG2Status().listening) {
    captureSession();
  }

  return () => {
    unsubscribeStatus();
    unsubscribeTranscripts();
    if (session !== null) {
      session.onChangeDraftMessage(session.draftMessage);
      session = null;
    }
    setEvenG2ActiveThread(getInput().threadKey, false);
  };
}

/** Connects an active thread's draft, dictation controls, and reply history to Even G2. */
export function useEvenG2ThreadBridge(
  input: EvenG2DictationInput & {
    readonly enabled: boolean;
    readonly messages?: ReadonlyArray<OrchestrationMessage>;
    readonly hasOlderMessages?: boolean;
    readonly loadingOlderMessages?: boolean;
    readonly onLoadEarlierMessages?: (() => boolean | void) | null;
  },
): void {
  // React 19.2's useEffectEvent retains first-render input inside the memoized
  // ThreadDetailScreen: https://github.com/facebook/react/issues/34818.
  // Refresh committed input before native events without restarting subscriptions.
  const inputRef = useRef(input);
  useLayoutEffect(() => {
    inputRef.current = input;
  }, [input]);
  const historyBridgeRef = useRef<ReturnType<typeof createEvenG2HistoryBridge> | null>(null);

  useEffect(() => {
    if (input.enabled) {
      return subscribeEvenG2Dictation(() => inputRef.current);
    }
  }, [input.enabled]);

  useEffect(() => {
    if (input.enabled) setEvenG2ActiveThread(input.threadKey, true);
  }, [input.enabled, input.threadKey]);

  useEffect(() => {
    if (!input.enabled) return;
    const bridge = createEvenG2HistoryBridge({
      setReplyHistory: setEvenG2ReplyHistory,
      subscribePositions: subscribeEvenG2HistoryPositions,
      subscribeRequests: subscribeEvenG2HistoryRequests,
    });
    historyBridgeRef.current = bridge;
    return () => {
      historyBridgeRef.current = null;
      bridge.dispose();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A route change reloads the selected thread's cached history.
  }, [input.enabled, input.threadKey]);

  useEffect(() => {
    if (!input.enabled) return;
    historyBridgeRef.current?.update({
      threadKey: input.threadKey,
      messages: input.messages,
      hasOlder: input.hasOlderMessages ?? false,
      loadingOlder: input.loadingOlderMessages ?? false,
      loadEarlier: input.onLoadEarlierMessages ?? null,
    });
  }, [
    input.enabled,
    input.threadKey,
    input.messages,
    input.hasOlderMessages,
    input.loadingOlderMessages,
    input.onLoadEarlierMessages,
  ]);
}
