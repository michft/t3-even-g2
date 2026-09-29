import { beforeEach, expect, it, vi } from "vite-plus/test";

import type { EvenG2Status } from "./evenG2Native";

const native = vi.hoisted(() => ({
  status: {
    status: "ready",
    detail: "G2 and R1 ready",
    connected: true,
    listening: false,
    autoConnect: true,
  } as EvenG2Status,
  listener: undefined as ((status: EvenG2Status) => void) | undefined,
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({
    getStatus: () => native.status,
    addListener: (_name: string, listener: (status: EvenG2Status) => void) => {
      native.listener = listener;
      return {
        remove: () => {
          native.listener = undefined;
        },
      };
    },
  }),
}));

beforeEach(() => {
  vi.resetModules();
  native.listener = undefined;
  native.status = {
    status: "ready",
    detail: "Ready",
    connected: true,
    listening: false,
    autoConnect: true,
  };
});

it("refreshes recovery status when returning after all G2 screens unsubscribed", async () => {
  const { getEvenG2Status, subscribeEvenG2Status } = await import("./evenG2Native");
  expect(getEvenG2Status().status).toBe("ready");
  const stop = subscribeEvenG2Status(() => {});
  stop();

  native.status = {
    ...native.status,
    status: "paused",
    detail: "G2 page creation timed out. Tap to retry.",
  };
  expect(native.listener).toBeUndefined();
  const stopAgain = subscribeEvenG2Status(() => {});
  expect(getEvenG2Status()).toEqual(native.status);
  stopAgain();
});
