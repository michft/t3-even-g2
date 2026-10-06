import { useState, useEffect } from "react";
import { View, Pressable } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ThreadComposer, type ThreadComposerProps } from "./ThreadComposer";
import { useQuestionAttachments } from "./use-question-attachments";
import {
  buildPendingUserInputAnswers,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";
import { setComposerDraftText, getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { replaceTextSelection } from "@t3tools/client-runtime/text-paste";
import type { RuntimeRequestId } from "@t3tools/contracts";

interface PendingUserInputComposerProps {
  composer: ThreadComposerProps;
  request: PendingUserInput;
  drafts: Record<string, PendingUserInputDraftAnswer>;
  respondingRequestId: RuntimeRequestId | null;
  onChangeCustomAnswer: (requestId: RuntimeRequestId, questionId: string, value: string) => void;
  onSubmit: (answers?: Record<string, string | ReadonlyArray<string>> | null) => Promise<unknown>;
  onDismiss: () => Promise<unknown>;
}

/** Ordinary composer answers one durable question at a time, preserving each attachment draft. */
export function PendingUserInputComposer(props: PendingUserInputComposerProps) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const question = props.request.questions[questionIndex] ?? props.request.questions[0];
  if (!question) return null;
  return (
    <PendingQuestionComposer
      key={question.id}
      {...props}
      questionIndex={questionIndex}
      onPrevious={() => setQuestionIndex(Math.max(0, questionIndex - 1))}
      onNext={() => setQuestionIndex(questionIndex + 1)}
    />
  );
}

/** Bind the normal editor and attachment picker to the active question, never the prompt draft. */
function PendingQuestionComposer(
  props: PendingUserInputComposerProps & {
    questionIndex: number;
    onPrevious: () => void;
    onNext: () => void;
  },
) {
  const question = props.request.questions[props.questionIndex]!;
  const draft = props.drafts[question.id];
  const text =
    draft?.customAnswer ||
    question.options
      .flatMap((option, index) =>
        draft?.selectedOptionValues?.includes(option.value ?? option.label)
          ? [String(index + 1)]
          : [],
      )
      .join(", ");
  const responding = props.respondingRequestId === props.request.requestId;
  const disconnected = props.composer.connectionState !== "connected";
  const disabled =
    responding || props.request.responseCapability === "not_resumable" || disconnected;
  const attachments = useQuestionAttachments({
    requestId: props.request.requestId,
    question,
    questions: props.request.questions,
    disabled,
  });
  // Voice input reads this same question-scoped composer draft.
  useEffect(() => {
    setComposerDraftText(attachments.key, text);
  }, [attachments.key, text]);
  const changeText = (value: string) => {
    setComposerDraftText(attachments.key, value);
    props.onChangeCustomAnswer(props.request.requestId, question.id, value);
  };
  const activeAnswer = buildPendingUserInputAnswers([question], { [question.id]: draft ?? {} });
  const composer = props.composer;
  return (
    <>
      <View className="flex-row items-center gap-3 px-5 py-2">
        <Text
          className="flex-1 font-sans text-sm text-foreground-muted"
          accessibilityLiveRegion="polite"
        >
          {props.request.responseCapability === "not_resumable"
            ? "This question is no longer available. Stop or restart the turn to continue."
            : `Answer question ${props.questionIndex + 1} of ${props.request.questions.length}: ${question.header}`}
        </Text>
        {props.questionIndex > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous question"
            onPress={props.onPrevious}
          >
            <Text className="font-sans text-sm text-foreground-secondary">Previous</Text>
          </Pressable>
        ) : null}
        {props.request.dismissible ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss question without answering"
            disabled={responding || disconnected}
            onPress={() => void props.onDismiss()}
          >
            <Text className="font-sans text-sm text-foreground-secondary">Dismiss</Text>
          </Pressable>
        ) : null}
      </View>
      <ThreadComposer
        {...composer}
        answeringQuestion
        supportsAnswerAttachments={attachments.canAttach}
        draftKey={attachments.key}
        draftMessage={text}
        draftAttachments={attachments.attachments}
        placeholder={
          question.multiSelect
            ? "Reply with numbers, separated by commas…"
            : question.allowCustomAnswer === false
              ? "Reply with an option number…"
              : "Reply with a number or your own words…"
        }
        activeThreadBusy={false}
        queuedEdit={null}
        hasCompactableConversation={false}
        sendBlockedReason={
          disabled
            ? disconnected
              ? "Reconnect to send answers"
              : responding
                ? "Sending answers…"
                : "Question unavailable"
            : !activeAnswer
              ? "Enter an answer"
              : null
        }
        onChangeDraftMessage={changeText}
        onPickDraftMedia={attachments.onPickMedia}
        onPickDraftFiles={attachments.onPickFiles}
        onNativePasteImages={attachments.onPasteImages}
        onNativePasteText={async (paste) =>
          changeText(
            replaceTextSelection({
              value: paste.value,
              selection: paste.selection,
              text: paste.text,
            }).value,
          )
        }
        onRemoveDraftImage={attachments.onRemove}
        onSendMessage={async () => {
          if (disabled) return null;
          const latest = { ...draft, customAnswer: getComposerDraftSnapshot(attachments.key).text };
          if (!buildPendingUserInputAnswers([question], { [question.id]: latest })) return null;
          if (props.questionIndex < props.request.questions.length - 1) props.onNext();
          else {
            const answers = buildPendingUserInputAnswers(props.request.questions, {
              ...props.drafts,
              [question.id]: latest,
            });
            if (answers) await props.onSubmit(answers);
          }
          return null;
        }}
      />
    </>
  );
}
