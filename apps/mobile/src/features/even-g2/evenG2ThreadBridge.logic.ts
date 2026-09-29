import type { ThreadFeedEntry } from "../../lib/threadActivity";

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
