import { describe, expect, it } from "vite-plus/test";
import {
  formatUserInputQuestions,
  resolveUserInputTextAnswer,
  getQuestionAnswerPreview,
  getQuestionAnswerText,
} from "./userInput.ts";

const question = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime?",
  options: [
    { label: "Same label", description: "First runtime", value: " first\t" },
    { label: "Same label", description: "Second runtime", value: "second" },
  ],
};

describe("plain text question answers", () => {
  it("maps a typed number to the exact provider value", () => {
    expect(resolveUserInputTextAnswer(question, " 1 ")).toBe(" first\t");
    expect(resolveUserInputTextAnswer(question, "2")).toBe("second");
    expect(
      resolveUserInputTextAnswer({ ...question, options: [{ label: "Only label" }] }, "1"),
    ).toBe("Only label");
  });
  it("preserves free text and requires words for Something else", () => {
    expect(resolveUserInputTextAnswer(question, "Use the existing runtime")).toBe(
      "Use the existing runtime",
    );
    expect(resolveUserInputTextAnswer(question, "3")).toBeNull();
    expect(resolveUserInputTextAnswer(question, "99")).toBe("99");
    expect(resolveUserInputTextAnswer({ ...question, options: [] }, "3")).toBe("3");
  });
  it("enforces offered options when custom answers are forbidden", () => {
    const constrained = { ...question, allowCustomAnswer: false };
    expect(resolveUserInputTextAnswer(constrained, "1")).toBe(" first\t");
    expect(resolveUserInputTextAnswer(constrained, "another runtime")).toBeNull();
    expect(resolveUserInputTextAnswer(constrained, "99")).toBeNull();
    expect(resolveUserInputTextAnswer(constrained, "1,2")).toBeNull();
  });
  it("maps comma-separated multi-select answers, deduplicating in reply order", () => {
    const multi = { ...question, multiSelect: true, allowCustomAnswer: false };
    expect(resolveUserInputTextAnswer(multi, "2, 1,2")).toEqual(["second", " first\t"]);
    expect(resolveUserInputTextAnswer(multi, "2")).toEqual(["second"]);
    expect(resolveUserInputTextAnswer(multi, "2,99")).toBeNull();
  });
  it("matches labels without changing provider value casing or whitespace", () => {
    const constrained = { ...question, allowCustomAnswer: false };
    expect(resolveUserInputTextAnswer(constrained, "same LABEL")).toBe(" first\t");
    expect(resolveUserInputTextAnswer(constrained, "SECOND")).toBeNull();
    expect(resolveUserInputTextAnswer(constrained, "second")).toBe("second");
  });
  it("resolves multi-select labels and values in reply order without partial selection", () => {
    const multi = {
      ...question,
      multiSelect: true,
      allowCustomAnswer: false,
      options: [
        { label: "Blue", description: "", value: " blue-id\t" },
        { label: "Red", description: "", value: "red-id" },
        { label: "Green, Gold", description: "", value: "green-gold" },
      ],
    };
    expect(resolveUserInputTextAnswer(multi, "red-id, BLUE, Red")).toEqual([
      "red-id",
      " blue-id\t",
    ]);
    expect(resolveUserInputTextAnswer(multi, "Green, Gold")).toEqual(["green-gold"]);
    expect(resolveUserInputTextAnswer(multi, "Blue, unknown")).toBeNull();
    expect(resolveUserInputTextAnswer({ ...multi, allowCustomAnswer: true }, "Blue, unknown")).toBe(
      "Blue, unknown",
    );
  });
  it("renders numbered inert choices and only offers free text when supported", () => {
    expect(formatUserInputQuestions([question])).toContain("1. Same label: First runtime");
    expect(formatUserInputQuestions([question])).toContain(
      "3. Something else: reply in your own words.",
    );
    expect(formatUserInputQuestions([{ ...question, allowCustomAnswer: false }])).not.toContain(
      "Something else",
    );
    expect(
      formatUserInputQuestions([question, { ...question, id: "next", multiSelect: true }]),
    ).toContain("Question 2 of 2:");
    expect(formatUserInputQuestions([{ ...question, multiSelect: true }])).toContain(
      "separated by commas",
    );
  });
});

it("preserves empty provider option IDs", () => {
  expect(
    resolveUserInputTextAnswer(
      { ...question, options: [{ label: "Empty result", value: "" }] },
      "1",
    ),
  ).toBe("");
});

// Shape the web client submits for an answer holding a review-comment chip.
const answerWithReviewComment = [
  "See my note: [Review comment: notes.md L2; ref=review-comment_c1]",
  "",
  '<t3_context version="1">',
  '<context kind="review-comment" id="review-comment_c1">',
  "file: notes.md",
  "range: L2 (2-2)",
  "comment:",
  "  Rename this",
  "diff:",
  "  +line changed",
  "</context>",
  "</t3_context>",
].join("\n");

describe("question answer display", () => {
  it("keeps the provider context envelope out of answer history and preview", () => {
    const history = getQuestionAnswerText(answerWithReviewComment);
    const preview = getQuestionAnswerPreview({
      requestId: "request-1",
      answers: { q1: answerWithReviewComment },
      attachmentsByQuestionId: {},
      questionTextById: { q1: "What should change?" },
    });

    expect(history).toBe("See my note: [Review comment: notes.md L2]");
    expect(preview).toContain("See my note:");
    expect(preview).not.toContain("<t3_context");

    const typedXml =
      'Use this XML literally: <t3_context version="1"><context kind="review-comment" id="example">keep me</context></t3_context>';
    expect(getQuestionAnswerText(typedXml)).toBe(typedXml);
  });
});

it("keeps option previews inside their numbered transcript choices", () => {
  const formatted = formatUserInputQuestions([
    {
      ...question,
      options: [
        {
          label: "Report",
          description: "Report",
          preview: "Title: Login fails\n\nBody: A quote breaks login.",
        },
        { label: "Skip", description: "Do nothing" },
      ],
    },
  ]);
  expect(formatted).toContain(
    "1. Report\n\n   Title: Login fails\n   \n   Body: A quote breaks login.\n2. Skip: Do nothing",
  );
  expect(formatted).toContain("3. Something else: reply in your own words.");
});
