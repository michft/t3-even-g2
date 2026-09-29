import type { ThreadFeedEntry } from "../../lib/threadActivity";

/** Matches phone activity while a glasses submission waits for an assistant reply. */
export function evenG2ThreadActivityText(input: {
  readonly connected: boolean;
  readonly hasError: boolean;
  readonly needsApproval: boolean;
  readonly needsInput: boolean;
  readonly queued: boolean;
  readonly working: boolean;
}): string {
  if (!input.connected) return "Waiting for connection…";
  if (input.hasError) return "Check error on phone";
  if (input.needsApproval) return "Approval needed on phone";
  if (input.needsInput) return "Answer needed on phone";
  if (input.queued) return "Sending to T3 Code…";
  return input.working ? "Thinking…" : "";
}

/** Returns the newest non-empty assistant message for display on the glasses. */
export function latestAssistantText(feed: ReadonlyArray<ThreadFeedEntry>): string | null {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    const text = entry.message.text.trim();
    if (text.length > 0) {
      return text;
    }
  }
  return null;
}

/** Appends non-empty speech to a typed draft with a blank line separator when needed. */
export function mergeDraftWithTranscript(draft: string, transcript: string): string {
  const speech = transcript.trim();
  if (speech.length === 0) {
    return draft;
  }
  const separator = draft.length === 0 || draft.endsWith("\n") ? "" : "\n\n";
  return `${draft}${separator}${speech}`;
}
