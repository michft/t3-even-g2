import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, vi } from "vite-plus/test";

const application = vi.hoisted(() => {
  let currentState = "active";
  const listeners = new Set<(state: string) => void>();
  return {
    subscribed: () => {},
    listeners,
    /** Publish a foreground/background transition to pending storage reads. */
    setState(state: string) {
      currentState = state;
      for (const listener of listeners) listener(state);
    },
    AppState: {
      /** Expose the native state snapshot inspected before subscribing. */
      get currentState() {
        return currentState;
      },
      /** Retain a cancellable listener and signal that the read is waiting. */
      addEventListener(_event: string, listener: (state: string) => void) {
        listeners.add(listener);
        application.subscribed();
        return { remove: () => listeners.delete(listener) };
      },
    },
  };
});
vi.mock("react-native", () => ({ AppState: application.AppState }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import * as CatalogStore from "../connection/catalog-store";
import { migrateLegacyConnectionCatalog } from "../connection/migration";
import * as MobileSecureStorage from "./mobile-secure-storage";

/** Replays the native protected-data failure captured on the user's iPhone. */
function lockedKeychainError() {
  return Object.assign(new Error("KeyChainException: User interaction is not allowed."), {
    code: "ERR_KEY_CHAIN",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  application.listeners.clear();
  application.subscribed = () => {};
  application.setState("active");
});

describe("mobile secure storage protected-data recovery", () => {
  it.effect("allows healthy background reads without waiting for a foreground event", () =>
    Effect.gen(function* () {
      application.setState("background");
      const subscribed = yield* Deferred.make<void>();
      application.subscribed = () => Deferred.doneUnsafe(subscribed, Effect.void);
      vi.mocked(SecureStore.getItemAsync).mockResolvedValue("saved");
      const storage = yield* MobileSecureStorage.MobileSecureStorage.pipe(
        Effect.provide(MobileSecureStorage.layer),
      );
      expect(
        yield* Effect.race(
          storage.getItem("test-key"),
          Deferred.await(subscribed).pipe(Effect.as("blocked")),
        ),
      ).toBe("saved");
      expect(application.listeners.size).toBe(0);
    }),
  );
  it.effect("recovers the saved catalog after a transient locked read without replacing it", () =>
    Effect.gen(function* () {
      const saved = yield* migrateLegacyConnectionCatalog(
        JSON.stringify({
          connections: [
            {
              environmentId: "saved-environment",
              environmentLabel: "Saved",
              pairingUrl: "https://saved.example.test/pair",
              displayUrl: "https://saved.example.test",
              httpBaseUrl: "https://saved.example.test",
              wsBaseUrl: "wss://saved.example.test",
              bearerToken: "test-token",
              authenticationMethod: "bearer",
            },
          ],
        }),
      );
      const attempted = yield* Deferred.make<void>();
      vi.mocked(SecureStore.getItemAsync)
        .mockImplementationOnce(() => {
          Deferred.doneUnsafe(attempted, Effect.void);
          return Promise.reject(lockedKeychainError());
        })
        .mockResolvedValue(JSON.stringify(saved));
      const catalog = yield* CatalogStore.make().pipe(Effect.provide(MobileSecureStorage.layer));
      const reading = yield* Effect.forkScoped(catalog.read);
      yield* Deferred.await(attempted);
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(reading)).targets).toEqual(saved.targets);
      expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2);
      expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    }),
  );

  it.effect("waits for foreground after a protected-data denial and releases its listener", () =>
    Effect.gen(function* () {
      application.setState("background");
      const subscribed = yield* Deferred.make<void>();
      application.subscribed = () => Deferred.doneUnsafe(subscribed, Effect.void);
      vi.mocked(SecureStore.getItemAsync)
        .mockRejectedValueOnce(lockedKeychainError())
        .mockResolvedValue("saved");
      const storage = yield* MobileSecureStorage.MobileSecureStorage.pipe(
        Effect.provide(MobileSecureStorage.layer),
      );
      const reading = yield* Effect.forkScoped(storage.getItem("test-key"));
      yield* Deferred.await(subscribed);
      expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);
      application.setState("active");
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(reading)).toBe("saved");
      expect(application.listeners.size).toBe(0);
    }),
  );

  it.effect("cancels protected-data recovery without a listener leak or another native read", () =>
    Effect.gen(function* () {
      application.setState("background");
      const subscribed = yield* Deferred.make<void>();
      application.subscribed = () => Deferred.doneUnsafe(subscribed, Effect.void);
      vi.mocked(SecureStore.getItemAsync).mockRejectedValue(lockedKeychainError());
      const storage = yield* MobileSecureStorage.MobileSecureStorage.pipe(
        Effect.provide(MobileSecureStorage.layer),
      );
      const reading = yield* Effect.forkScoped(storage.getItem("test-key"));
      yield* Deferred.await(subscribed);
      yield* Fiber.interrupt(reading);
      expect(application.listeners.size).toBe(0);
      expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("surfaces permanent errors immediately without retrying or modifying storage", () =>
    Effect.gen(function* () {
      const cause = Object.assign(new Error("Missing entitlement"), { code: "ERR_KEY_CHAIN" });
      vi.mocked(SecureStore.getItemAsync).mockRejectedValue(cause);
      const storage = yield* MobileSecureStorage.MobileSecureStorage.pipe(
        Effect.provide(MobileSecureStorage.layer),
      );
      expect((yield* Effect.flip(storage.getItem("test-key"))).cause).toBe(cause);
      expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);
      expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    }),
  );

  it.effect("bounds retries and retains the error if protected data remains unavailable", () =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      vi.mocked(SecureStore.getItemAsync).mockImplementation(() => {
        Deferred.doneUnsafe(attempted, Effect.void);
        return Promise.reject(lockedKeychainError());
      });
      const storage = yield* MobileSecureStorage.MobileSecureStorage.pipe(
        Effect.provide(MobileSecureStorage.layer),
      );
      const reading = yield* Effect.forkScoped(Effect.flip(storage.getItem("test-key")));
      yield* Deferred.await(attempted);
      yield* TestClock.adjust("3 seconds");
      expect((yield* Fiber.join(reading)).operation).toBe("read");
      expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(9);
      expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    }),
  );
});
