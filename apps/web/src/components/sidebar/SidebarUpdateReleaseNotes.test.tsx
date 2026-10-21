import type { DesktopUpdateState } from "@t3tools/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: testState.addToast },
}));

import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";

type AnchorElement = ReactElement<{
  readonly children?: ReactNode;
  readonly href?: string;
}>;

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "nightly",
  currentVersion: "0.0.35",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.36-nightly.3",
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function collectAnchors(node: ReactNode, anchors: AnchorElement[] = []): AnchorElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectAnchors(child, anchors);
    return anchors;
  }
  if (!isValidElement(node)) return anchors;

  const element = node as ReactElement<{ readonly children?: ReactNode }>;
  if (typeof element.type === "function") {
    const render = element.type as (props: unknown) => ReactNode;
    return collectAnchors(render(element.props), anchors);
  }
  if (element.type === "a") anchors.push(element as AnchorElement);
  return collectAnchors(element.props.children, anchors);
}

function renderNotes(state: DesktopUpdateState, openExternal = vi.fn().mockResolvedValue(true)) {
  return SidebarUpdateReleaseNotes({
    shell: { openExternal },
    state,
    tooltip: "Update available",
  });
}

describe("SidebarUpdateReleaseNotes", () => {
  beforeEach(() => {
    testState.addToast.mockReset();
    vi.stubEnv("T3CODE_DESKTOP_UPDATE_REPOSITORY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the configured repository for release links", () => {
    vi.stubEnv("T3CODE_DESKTOP_UPDATE_REPOSITORY", "JustYannicc/t3code");
    const anchors = collectAnchors(
      renderNotes({
        ...baseState,
        releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Change 3"], totalItems: 1 }],
        omittedReleaseCount: 1,
      }),
    );

    expect(anchors.map(({ props }) => props.href)).toEqual([
      "https://github.com/JustYannicc/t3code/releases/tag/v0.0.36-nightly.3",
      "https://github.com/JustYannicc/t3code/releases",
    ]);
  });
});
