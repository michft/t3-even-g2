import { describe, expect, it } from "vite-plus/test";
import { ApprovalRequestId, type UserInputAttachmentAnswerPayload } from "@t3tools/contracts";
import {
  formatUserInputQuestions,
  resolveUserInputTextAnswer,
  getQuestionTextPreview,
} from "./userInput.ts";

function answer(
  overrides: Partial<UserInputAttachmentAnswerPayload> = {},
): UserInputAttachmentAnswerPayload {
  return {
    requestId: ApprovalRequestId.make("request-1"),
    questionTextById: { scope: "Which repository?" },
    answers: { scope: "Use the private repository" },
    attachmentsByQuestionId: {},
    ...overrides,
  };
}

describe("getQuestionTextPreview", () => {
  it("joins the question texts", () => {
    expect(
      getQuestionTextPreview(
        answer({ questionTextById: { scope: "Which repository?", name: "What name?" } }),
      ),
    ).toBe("Which repository? · What name?");
  });

  it("normalizes whitespace and skips blank texts", () => {
    expect(
      getQuestionTextPreview(
        answer({ questionTextById: { scope: "Which\nrepository?", x: "  " } }),
      ),
    ).toBe("Which repository?");
  });

  it("returns an empty string without question texts", () => {
    expect(getQuestionTextPreview(answer({ questionTextById: undefined }))).toBe("");
  });
});

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
      resolveUserInputTextAnswer(
        { ...question, options: [{ label: "Only label", description: "" }] },
        "1",
      ),
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
  it("renders numbered inert choices and only offers free text when supported", () => {
    expect(formatUserInputQuestions([question])).toContain("1. Same label — First runtime");
    expect(formatUserInputQuestions([question])).toContain(
      "3. Something else — reply in your own words.",
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
      { ...question, options: [{ label: "Empty result", description: "", value: "" }] },
      "1",
    ),
  ).toBe("");
});
