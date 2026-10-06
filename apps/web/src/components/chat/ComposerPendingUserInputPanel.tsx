import { type RuntimeRequestId } from "@t3tools/contracts";
import { memo } from "react";
import { type PendingUserInput } from "../../session-logic";
import { ComposerBanner } from "./ComposerBanner";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: RuntimeRequestId[];
  questionIndex: number;
  onDismiss: (requestId: RuntimeRequestId) => void;
}

/** Questions live in the transcript; the composer only reports answer progress. */
export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  questionIndex,
  onDismiss,
}: PendingUserInputPanelProps) {
  const request = pendingUserInputs[0];
  const question = request?.questions[questionIndex];
  if (!request || !question) return null;
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Content>
        <span className="text-sm text-secondary-label" role="status">
          {request.responseCapability === "not_resumable"
            ? "This question is no longer available. Stop or restart the turn to continue."
            : `Answer question ${questionIndex + 1} of ${request.questions.length}: ${question.header}`}
        </span>
      </ComposerBanner.Content>
      {request.dismissible ? (
        <ComposerBanner.Actions>
          <ComposerBanner.Dismiss
            aria-label="Dismiss question without answering"
            title="Dismiss question without answering"
            disabled={respondingRequestIds.includes(request.requestId)}
            onClick={() => onDismiss(request.requestId)}
          />
        </ComposerBanner.Actions>
      ) : null}
    </ComposerBanner.Row>
  );
});
