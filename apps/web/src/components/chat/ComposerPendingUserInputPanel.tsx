import { useGT } from "gt-react";
import { type RuntimeRequestId } from "@t3tools/contracts";
import { memo } from "react";
import { type PendingUserInput } from "../../session-logic";
import { ComposerBanner } from "./ComposerBanner";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  questionIndex: number;
  onDismiss: (requestId: RuntimeRequestId) => void;
}

/** Questions live in the transcript; the composer only reports answer progress. */
function ComposerPendingUserInputPanel({
  pendingUserInputs,
  disabled = false,
  respondingRequestIds,
  questionIndex,
  onDismiss,
}: PendingUserInputPanelProps) {
  const gt = useGT();
  const request = pendingUserInputs[0];
  const question = request?.questions[questionIndex];
  if (!request || !question) return null;
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Content>
        <span className="text-sm text-secondary-label" role="status">
          {request.responseCapability === "not_resumable"
            ? gt("This question is no longer available. Stop or restart the turn to continue.")
            : gt("Answer question {current} of {total}: {header}", {
                current: questionIndex + 1,
                total: request.questions.length,
                header: question.header,
              })}
        </span>
      </ComposerBanner.Content>
      {request.dismissible ? (
        <ComposerBanner.Actions>
          <ComposerBanner.Dismiss
            aria-label={gt("Dismiss question without answering")}
            title={gt("Dismiss question without answering")}
            disabled={disabled || respondingRequestIds.includes(request.requestId)}
            onClick={
              /** Dismiss this asynchronous request without submitting an answer. */ () =>
                onDismiss(request.requestId)
            }
          />
        </ComposerBanner.Actions>
      ) : null}
    </ComposerBanner.Row>
  );
}

const MemoizedComposerPendingUserInputPanel = memo(ComposerPendingUserInputPanel);
export { MemoizedComposerPendingUserInputPanel as ComposerPendingUserInputPanel };
