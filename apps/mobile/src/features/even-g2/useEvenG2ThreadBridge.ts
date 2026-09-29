import { useEffect, useEffectEvent } from "react";

import type { MessageId } from "@t3tools/contracts";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  displayEvenG2Text,
  ensureEvenG2AutoConnect,
  subscribeEvenG2Status,
  subscribeEvenG2Transcripts,
  getEvenG2Status,
  setEvenG2ActiveThread,
} from "./evenG2Native";
import { latestAssistantText, mergeDraftWithTranscript } from "./evenG2ThreadBridge.logic";

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

    origin.onChangeDraftMessage(origin.draftMessage);
    session = null;
    const command = event.text.trim();
    if (!event.cancelled && command.length > 0) {
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

/** Connects an active thread's draft, dictation controls, and latest reply to Even G2. */
export function useEvenG2ThreadBridge(
  input: EvenG2DictationInput & {
    readonly enabled: boolean;
    readonly feed: ReadonlyArray<ThreadFeedEntry>;
  },
): void {
  /** Reads current thread input without restarting native subscriptions on every render. */
  const getInput = useEffectEvent(() => input);

  useEffect(() => {
    if (input.enabled) {
      return subscribeEvenG2Dictation(getInput);
    }
  }, [input.enabled]);

  useEffect(() => {
    if (input.enabled) setEvenG2ActiveThread(input.threadKey, true);
  }, [input.enabled, input.threadKey]);

  const assistantText = latestAssistantText(input.feed);
  useEffect(() => {
    if (input.enabled && assistantText) {
      displayEvenG2Text(assistantText);
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Switching threads clears the native page even when both replies have identical text.
  }, [assistantText, input.enabled, input.threadKey]);
}
