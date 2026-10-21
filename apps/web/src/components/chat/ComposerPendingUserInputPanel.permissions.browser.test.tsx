import { RuntimeRequestId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

it("blocks dismissal on revocation or while responding and resumes after a new grant", async () => {
  const onDismiss = vi.fn();
  const prompt = {
    requestId: RuntimeRequestId.make("scoped-answer"),
    createdAt: "2026-09-05T00:00:00.000Z",
    dismissible: true,
    responseCapability: "live" as const,
    questions: [
      {
        id: "approach",
        header: "Approach",
        question: "Which approach?",
        options: [{ label: "Incremental", description: "One module at a time" }],
        multiSelect: false,
      },
    ],
  };
  const panel = (disabled: boolean, respondingRequestIds: RuntimeRequestId[] = []) => (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      disabled={disabled}
      respondingRequestIds={respondingRequestIds}
      questionIndex={0}
      onDismiss={onDismiss}
    />
  );
  await using screen = await render(panel(false));
  const { container } = screen;
  const dismissButton = () => {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss question without answering"]',
    );
    expect(button).not.toBeNull();
    return button!;
  };
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.textContent).not.toContain("Incremental");
  await act(async () => dismissButton().click());
  expect(onDismiss).toHaveBeenCalledExactlyOnceWith(prompt.requestId);

  await screen.rerender(panel(true));
  expect(dismissButton().disabled).toBe(true);
  await act(async () => dismissButton().click());
  expect(onDismiss).toHaveBeenCalledTimes(1);

  await screen.rerender(panel(false, [prompt.requestId]));
  expect(dismissButton().disabled).toBe(true);
  await act(async () => dismissButton().click());
  expect(onDismiss).toHaveBeenCalledTimes(1);

  await screen.rerender(panel(false, [RuntimeRequestId.make("other-request")]));
  expect(dismissButton().disabled).toBe(false);
  await act(async () => dismissButton().click());
  expect(onDismiss).toHaveBeenCalledTimes(2);
  expect(onDismiss).toHaveBeenLastCalledWith(prompt.requestId);

  await screen.rerender(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[{ ...prompt, dismissible: false }]}
      respondingRequestIds={[]}
      questionIndex={0}
      onDismiss={onDismiss}
    />,
  );
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Answer question 1 of 1: Approach",
  );
});
