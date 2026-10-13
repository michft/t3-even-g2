import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

const MobileSecureStorageOperation = Schema.Literals(["read", "write", "delete"]);

export class MobileSecureStorageError extends Schema.TaggedError<MobileSecureStorageError>()(
  "MobileSecureStorageError",
  {
    operation: MobileSecureStorageOperation,
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const prefix = `Mobile secure storage operation ${this.operation} failed for key ${this.key}.`;
    if (!(this.cause instanceof Error)) {
      return prefix;
    }
    const code =
      "code" in this.cause && typeof this.cause.code === "string" ? ` (${this.cause.code})` : "";
    return `${prefix} ${this.cause.message}${code}`;
  }
}

export class MobileSecureStorage extends Context.Service<
  MobileSecureStorage,
  {
    readonly getItem: (key: string) => Effect.Effect<string | null, MobileSecureStorageError>;
    readonly setItem: (key: string, value: string) => Effect.Effect<void, MobileSecureStorageError>;
    readonly removeItem: (key: string) => Effect.Effect<void, MobileSecureStorageError>;
  }
>()("@t3tools/mobile/persistence/MobileSecureStorage") {}

/** Await foreground after a protected-data denial, releasing the listener on completion or cancellation. */
const waitForForeground = Effect.callback<void>((resume) => {
  if (AppState.currentState === "active") {
    resume(Effect.void);
    return;
  }
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") resume(Effect.sync(() => subscription.remove()));
  });
  // Close the race between inspecting the state and subscribing to changes.
  if (AppState.currentState === "active") resume(Effect.sync(() => subscription.remove()));
  return Effect.sync(() => subscription.remove());
});

/** Retry only Expo's specific protected-data denial, preserving other storage failures. */
function isLockedKeychain(error: MobileSecureStorageError): boolean {
  return (
    error.cause instanceof Error &&
    "code" in error.cause &&
    error.cause.code === "ERR_KEY_CHAIN" &&
    error.cause.message.includes("User interaction is not allowed")
  );
}

/** Adapts Expo SecureStore to typed Effect operations for mobile key-value persistence. */
const make = MobileSecureStorage.of({
  /** Avoid caching a locked startup failure while the device becomes available after unlock. */
  getItem: Effect.fn("MobileSecureStorage.getItem")((key) =>
    Effect.tryPromise({
      try: () => SecureStore.getItemAsync(key),
      catch: (cause) => new MobileSecureStorageError({ operation: "read", key, cause }),
    }).pipe(
      Effect.retry({
        while: (error) =>
          isLockedKeychain(error) ? waitForForeground.pipe(Effect.as(true)) : false,
        times: 8,
        schedule: Schedule.spaced("250 millis"),
      }),
    ),
  ),
  setItem: Effect.fn("MobileSecureStorage.setItem")((key, value) =>
    Effect.tryPromise({
      try: () => SecureStore.setItemAsync(key, value),
      catch: (cause) => new MobileSecureStorageError({ operation: "write", key, cause }),
    }),
  ),
  removeItem: Effect.fn("MobileSecureStorage.removeItem")((key) =>
    Effect.tryPromise({
      try: () => SecureStore.deleteItemAsync(key),
      catch: (cause) => new MobileSecureStorageError({ operation: "delete", key, cause }),
    }),
  ),
});

export const layer = Layer.succeed(MobileSecureStorage, make);
