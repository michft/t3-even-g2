import { msg } from "gt-react-native";
import { m, type MessageResolver } from "../../i18n/messages";

/** Matches phone activity while a glasses submission waits for an assistant reply. */
export function evenG2ThreadActivityText(
  input: {
    readonly connected: boolean;
    readonly hasError: boolean;
    readonly needsApproval: boolean;
    readonly needsInput: boolean;
    readonly queued: boolean;
    readonly working: boolean;
  },
  resolve: MessageResolver = m,
): string {
  if (!input.connected) return resolve(msg("Waiting for connection…"));
  if (input.hasError) return resolve(msg("Check error on phone"));
  if (input.needsApproval) return resolve(msg("Approval needed on phone"));
  if (input.needsInput) return resolve(msg("Answer needed on phone"));
  if (input.queued) return resolve(msg("Sending to T3 Code…"));
  return input.working ? resolve(msg("Thinking…")) : "";
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
