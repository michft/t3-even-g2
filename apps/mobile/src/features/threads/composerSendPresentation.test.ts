import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSendPresentation } from "./composerSendPresentation";

const idle = {
  editingQueuedMessage: false,
  running: false,
  canSteer: false,
  followUpBehavior: "queue",
  deliveryDeferred: false,
} as const;

describe("resolveComposerSendPresentation", () => {
  it("sends runtime answers directly even when ordinary prompt delivery is deferred", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      answeringQuestion: true,
      deliveryDeferred: true,
    });
    expect(presentation).toEqual({
      label: "Send",
      icon: "arrow.up",
      action: null,
      alternate: null,
      offersFollowUpChoice: false,
    });
    expect(
      resolveComposerSendPresentation({
        ...idle,
        answeringQuestion: true,
        running: true,
        canSteer: true,
        deliveryDeferred: true,
      }).label,
    ).toBe("Send");
    // The neighboring ordinary prompt still uses its outbox and Queue label.
    expect(resolveComposerSendPresentation({ ...idle, deliveryDeferred: true }).label).toBe(
      "Queue",
    );
  });

  it("never promises steering the provider cannot do", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: false,
      followUpBehavior: "steer",
    });

    expect(presentation.label).toBe("Queue");
    expect(presentation.action).toBe("queue");
    expect(presentation.alternate).toBeNull();
    expect(presentation.offersFollowUpChoice).toBe(false);
  });
});
