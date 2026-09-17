import { useEffect, useEffectEvent } from "react";

import type { MessageId } from "@t3tools/contracts";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  displayEvenG2Text,
  ensureEvenG2AutoConnect,
  subscribeEvenG2Status,
  subscribeEvenG2Transcripts,
  getEvenG2Status,
  setEvenG2InputEnabled,
} from "./evenG2Native";
import { latestAssistantText, mergeDraftWithTranscript } from "./evenG2ThreadBridge.logic";

interface EvenG2DictationInput {
  readonly threadKey: string;
  readonly draftMessage: string;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onSendTextMessage: (text: string) => Promise<MessageId | null>;
}

/** Keep a native dictation session attached to the thread where it began. */
export function subscribeEvenG2Dictation(getInput: () => EvenG2DictationInput): () => void {
  let session: EvenG2DictationInput | null = null;
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
  setEvenG2InputEnabled(true);
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
    setEvenG2InputEnabled(false);
  };
}

export function useEvenG2ThreadBridge(
  input: EvenG2DictationInput & {
    readonly enabled: boolean;
    readonly feed: ReadonlyArray<ThreadFeedEntry>;
  },
): void {
  const getInput = useEffectEvent(() => input);

  useEffect(() => {
    if (input.enabled) {
      return subscribeEvenG2Dictation(getInput);
    }
  }, [input.enabled]);

  const assistantText = latestAssistantText(input.feed);
  useEffect(() => {
    if (input.enabled && assistantText) {
      displayEvenG2Text(assistantText);
    }
  }, [assistantText, input.enabled]);
}
