import { convertPastedImagesToAttachments } from "../../lib/composerImages";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type UserInputQuestion } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Alert } from "react-native";
import { useEffect, useRef } from "react";
import { pickComposerFiles, pickComposerMedia } from "../../lib/composerImages";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useServerConfigs } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
  removeComposerDraftAttachment,
  releaseUnusedComposerAttachmentFiles,
} from "../../state/use-composer-drafts";
import {
  changeQuestionAttachmentPreparation,
  questionAttachmentDraftKey,
  questionAttachmentPreparationAtom,
} from "../../state/question-attachments";

/**
 * Manage the active question's attachment draft and picker, paste, and removal callbacks.
 * `questions` must include the whole request to enforce its shared attachment limit.
 * `canAttach` reflects provider support and custom-answer permission; callbacks
 * also honor `disabled`. Picker errors and rejected paste promises show alerts;
 * individual image conversion failures are skipped by the paste helper.
 * Files prepared after leaving the question or resolving its request are passed
 * to best-effort unused-file cleanup.
 */
export function useQuestionAttachments(props: {
  requestId: string;
  question: UserInputQuestion;
  questions: ReadonlyArray<UserInputQuestion>;
  disabled: boolean;
}) {
  const { selectedThread } = useThreadSelection();
  const configs = useServerConfigs();
  const drafts = useAtomValue(composerDraftsAtom);
  const scopeKey = JSON.stringify([
    selectedThread?.environmentId,
    selectedThread?.id,
    props.requestId,
    props.question.id,
  ]);
  const pickerScope = useRef<{ key: string; active: boolean } | null>(null);
  useEffect(
    /** Track whether asynchronous attachment work still belongs to the active question. */ () => {
      const scope = { key: scopeKey, active: true };
      pickerScope.current = scope;
      return /** Invalidate pending picker and paste results when the question changes or unmounts. */ () => {
        scope.active = false;
      };
    },
    [scopeKey],
  );
  /** Append within the request's remaining attachment allowance and return the rejected count. */
  const append = (
    key: string,
    attachments: Parameters<typeof appendComposerDraftAttachments>[1],
  ) => {
    if (!selectedThread) return 0;
    const current = appAtomRegistry.get(composerDraftsAtom);
    const otherCount = props.questions.reduce(
      /** Count attachments reserved by the request's other questions. */ (count, question) => {
        const target = questionAttachmentDraftKey(
          selectedThread.environmentId,
          selectedThread.id,
          props.requestId,
          question.id,
        );
        return target === key ? count : count + (current[target]?.attachments.length ?? 0);
      },
      0,
    );
    return appendComposerDraftAttachments(key, attachments, {
      maxAttachments: Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - otherCount),
    });
  };
  /** Reserve pasted images for this question; release them if its request resolves meanwhile. */
  const pasteImages = async (uris: ReadonlyArray<string>) => {
    const scope = pickerScope.current;
    if (
      !selectedThread ||
      props.disabled ||
      props.question.allowCustomAnswer === false ||
      !configs.get(selectedThread.environmentId)?.environment.capabilities.questionAttachments
    )
      return;
    const key = questionAttachmentDraftKey(
      selectedThread.environmentId,
      selectedThread.id,
      props.requestId,
      props.question.id,
    );
    changeQuestionAttachmentPreparation(key, 1);
    await convertPastedImagesToAttachments({
      uris,
      existingCount: appAtomRegistry.get(composerDraftsAtom)[key]?.attachments.length ?? 0,
    })
      .then(
        /** Append converted images if the question is still active; otherwise release unused files. */ async (
          images,
        ) => {
          if (
            scope?.active &&
            (appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) > 0
          ) {
            if (append(key, images) > 0)
              Alert.alert("Could not paste image", "Too many attachments.");
          } else await releaseUnusedComposerAttachmentFiles(images);
        },
      )
      .catch(
        /** Report a rejected paste operation using its error message when available. */ (error) =>
          Alert.alert(
            "Could not paste image",
            error instanceof Error ? error.message : "Try again.",
          ),
      )
      .finally(
        /** Release the preparation reservation after either paste success or failure. */ () =>
          changeQuestionAttachmentPreparation(key, -1),
      );
  };
  const environmentId = selectedThread?.environmentId;
  const threadId = selectedThread?.id;
  const capabilities = environmentId
    ? configs.get(environmentId)?.environment.capabilities
    : undefined;
  const canAttach =
    capabilities?.questionAttachments === true && props.question.allowCustomAnswer !== false;
  const key =
    environmentId && threadId
      ? questionAttachmentDraftKey(environmentId, threadId, props.requestId, props.question.id)
      : "";
  const attachments = drafts[key]?.attachments ?? [];
  /** Attach picked files within the request-wide limit while this question remains active. */
  const pick = async (kind: "media" | "files") => {
    if (!canAttach || props.disabled || !selectedThread) return;
    const scope = pickerScope.current;
    changeQuestionAttachmentPreparation(key, 1);
    try {
      const existingCount = appAtomRegistry.get(composerDraftsAtom)[key]?.attachments.length ?? 0;
      const result =
        kind === "files"
          ? await pickComposerFiles({
              existingCount,
              maxBytes: capabilities?.fileAttachments?.maxUploadBytes,
            })
          : await pickComposerMedia({
              existingCount,
              maxVideoBytes: capabilities?.fileAttachments?.maxUploadBytes,
            });
      const picked = "files" in result ? result.files : result.attachments;
      // Resolution on another client clears the reservation while the picker is open.
      if (
        !scope?.active ||
        (appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) === 0
      ) {
        await releaseUnusedComposerAttachmentFiles(picked);
        return;
      }
      const rejected = append(key, picked);
      if (result.error || rejected > 0)
        Alert.alert("Could not attach file", result.error ?? "Too many attachments.");
    } catch (error) {
      Alert.alert("Could not attach file", error instanceof Error ? error.message : "Try again.");
    } finally {
      changeQuestionAttachmentPreparation(key, -1);
    }
  };
  return {
    key,
    attachments,
    canAttach,
    /** Pick media into the active question's attachment draft within request-wide limits. */
    onPickMedia: () => pick("media"),
    /** Pick documents into the active question's attachment draft within request-wide limits. */
    onPickFiles: () => pick("files"),
    onPasteImages: pasteImages,
    /** Remove a question attachment while its request remains editable. */
    onRemove: (id: string) => {
      if (!props.disabled) removeComposerDraftAttachment(key, id);
    },
  };
}
