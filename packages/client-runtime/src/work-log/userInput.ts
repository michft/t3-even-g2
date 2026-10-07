import {
  type OrchestrationV2UserInputQuestion,
  type UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function getQuestionAnswerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(getQuestionAnswerText).filter(Boolean).join(", ");
  const nested = record(value);
  return nested ? getQuestionAnswerText(nested.answers) : "";
}

export function getQuestionTextPreview(answer: UserInputAttachmentAnswerPayload): string {
  return Object.values(answer.questionTextById ?? {})
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
}

export function getQuestionAnswerPreview(answer: UserInputAttachmentAnswerPayload): string {
  const answers = Object.values(answer.answers).map(getQuestionAnswerText).filter(Boolean);
  const attachments = Object.values(answer.attachmentsByQuestionId)
    .flat()
    .map((attachment) => attachment.name);
  return (
    answers.length > 0
      ? answers.join(" · ")
      : attachments.length > 0
        ? attachments.join(", ")
        : Object.values(answer.questionTextById ?? {}).join(" · ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function hasQuestionAnswer(answer: UserInputAttachmentAnswerPayload): boolean {
  return (
    Object.values(answer.answers).some(getQuestionAnswerText) ||
    Object.values(answer.attachmentsByQuestionId).some((attachments) => attachments.length > 0)
  );
}

/** Render provider questions as ordinary conversation text, keeping choices inert. */
export function formatUserInputQuestions(
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
): string {
  return questions
    .map(
      /** Render each question with numbered choices and only supported reply hints. */ (
        question,
        index,
      ) => {
        const lines = [
          questions.length > 1
            ? `Question ${index + 1} of ${questions.length}: ${question.question}`
            : question.question,
        ];
        if (question.options.length > 0) {
          lines.push(
            "",
            ...question.options.map(
              /** Number display labels without repeating identical option descriptions. */ (
                option,
                optionIndex,
              ) =>
                `${optionIndex + 1}. ${option.label}${option.description && option.description !== option.label ? ` — ${option.description}` : ""}`,
            ),
          );
          if (question.allowCustomAnswer !== false)
            lines.push(`${question.options.length + 1}. Something else — reply in your own words.`);
          lines.push(
            "",
            question.multiSelect
              ? "Reply with one or more option numbers separated by commas."
              : "Reply with an option number.",
          );
        }
        if (question.allowCustomAnswer !== false)
          lines.push("Reply in your own words if you prefer.");
        return lines.join("\n");
      },
    )
    .join("\n\n");
}

/**
 * Resolve typed choices without changing provider option IDs or allowing forbidden custom answers.
 * Trim the reply and match valid 1-based option numbers before case-insensitive
 * labels or exact option values, using the label when an option has no value.
 * For multi-select questions, accept comma-separated numbers or labels/values;
 * a whole label/value match takes precedence over splitting a word list.
 * Matched multi-select values are deduplicated in reply order and returned as
 * an array; a single-select match returns its value, which may be empty.
 * Return null for blank replies or the displayed "Something else" number alone.
 * Unmatched replies, including partially matched lists, return trimmed custom
 * text when allowed, or null otherwise.
 */
export function resolveUserInputTextAnswer(
  question: OrchestrationV2UserInputQuestion,
  text: string,
): string | string[] | null {
  const answer = text.trim();
  if (!answer) return null;
  const numbers = /^(?:[1-9]\d*)(?:\s*,\s*[1-9]\d*)*$/.test(answer)
    ? answer
        .split(",")
        .map(
          /** Parse numeric list tokens after the complete reply passes syntax validation. */ (
            number,
          ) => Number(number.trim()),
        )
    : null;
  if (
    numbers &&
    (question.multiSelect || numbers.length === 1) &&
    numbers.every(
      /** Require every displayed option number to be within the available choices. */ (number) =>
        number <= question.options.length,
    )
  ) {
    const values = [
      ...new Set(
        numbers.map(
          /** Translate a displayed number to its exact provider value. */ (number) => {
            const option = question.options[number - 1]!;
            return option.value ?? option.label;
          },
        ),
      ),
    ];
    return question.multiSelect ? values : values[0]!;
  }
  // The final numbered choice asks for words, rather than sending a synthetic option to the provider.
  if (
    numbers?.length === 1 &&
    numbers[0] === question.options.length + 1 &&
    question.options.length > 0 &&
    question.allowCustomAnswer !== false
  )
    return null;
  const option = question.options.find(
    /** Match labels without case sensitivity while preserving exact provider-value matching. */ (
      option,
    ) => option.label.toLowerCase() === answer.toLowerCase() || option.value === answer,
  );
  if (option)
    return question.multiSelect ? [option.value ?? option.label] : (option.value ?? option.label);
  if (question.multiSelect) {
    const options = answer.split(",").map(
      /** Resolve each comma-separated word independently before accepting a multi-select list. */ (
        part,
      ) => {
        const choice = part.trim();
        return question.options.find(
          /** Match a listed label case-insensitively or its provider value exactly. */ (option) =>
            option.label.toLowerCase() === choice.toLowerCase() || option.value === choice,
        );
      },
    );
    if (
      options.every(
        /** Require a complete list match so unknown words cannot silently drop selections. */ (
          option,
        ) => option !== undefined,
      )
    )
      return [
        ...new Set(
          options.map(
            /** Preserve exact provider values when collecting the validated selections. */ (
              option,
            ) => option!.value ?? option!.label,
          ),
        ),
      ];
  }
  return question.allowCustomAnswer === false ? null : answer;
}
