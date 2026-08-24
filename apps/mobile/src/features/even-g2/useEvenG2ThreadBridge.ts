import { useEffect, useRef } from "react";

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

export function useEvenG2ThreadBridge(input: {
  readonly enabled: boolean;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly draftMessage: string;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onSendTextMessage: (text: string) => Promise<MessageId | null>;
}): void {
  const currentDraftRef = useRef(input.draftMessage);
  const originalDraftRef = useRef<string | null>(null);
  const latestInputRef = useRef(input);
  currentDraftRef.current = input.draftMessage;
  latestInputRef.current = input;

  useEffect(() => {
    if (!input.enabled) {
      return;
    }
    ensureEvenG2AutoConnect();
    setEvenG2InputEnabled(true);
    const unsubscribeStatus = subscribeEvenG2Status(() => {
      if (getEvenG2Status().listening && originalDraftRef.current === null) {
        originalDraftRef.current = currentDraftRef.current;
      }
    });
    const unsubscribeTranscripts = subscribeEvenG2Transcripts((event) => {
      const handlers = latestInputRef.current;
      if (originalDraftRef.current === null) {
        originalDraftRef.current = currentDraftRef.current;
      }
      const originalDraft = originalDraftRef.current;
      if (!event.isFinal) {
        handlers.onChangeDraftMessage(mergeDraftWithTranscript(originalDraft, event.text));
        return;
      }

      handlers.onChangeDraftMessage(originalDraft);
      originalDraftRef.current = null;
      const command = event.text.trim();
      if (!event.cancelled && command.length > 0) {
        void handlers.onSendTextMessage(command);
      }
    });
    if (getEvenG2Status().listening) {
      originalDraftRef.current = currentDraftRef.current;
    }

    return () => {
      unsubscribeStatus();
      unsubscribeTranscripts();
      if (originalDraftRef.current !== null) {
        latestInputRef.current.onChangeDraftMessage(originalDraftRef.current);
        originalDraftRef.current = null;
      }
      setEvenG2InputEnabled(false);
    };
  }, [input.enabled]);

  const assistantText = latestAssistantText(input.feed);
  useEffect(() => {
    if (input.enabled && assistantText) {
      displayEvenG2Text(assistantText);
    }
  }, [assistantText, input.enabled]);
}
