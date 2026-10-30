import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  let preferencesJson: string | null = null;
  let preferencesUpdatedAt = 0;
  let loadPreferencesFails = false;
  let savePreferencesFails = false;
  return {
    clear: () => {
      values.clear();
      preferencesJson = null;
      preferencesUpdatedAt = 0;
      loadPreferencesFails = false;
      savePreferencesFails = false;
    },
    getStoredValue: (key: string) => values.get(key) ?? null,
    getPreferencesJson: () => preferencesJson,
    setPreferencesJson: (value: string, updatedAt: number) => {
      preferencesJson = value;
      preferencesUpdatedAt = updatedAt;
    },
    setDatabaseFailures: (load: boolean, save: boolean) => {
      loadPreferencesFails = load;
      savePreferencesFails = save;
    },
    getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItemAsync: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: vi.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
    database: {
      closeAsync: vi.fn(() => Promise.resolve()),
      execAsync: vi.fn(() => Promise.resolve()),
      withExclusiveTransactionAsync: vi.fn(
        (run: (transaction: { execAsync: () => Promise<void> }) => Promise<void>) =>
          run({ execAsync: () => Promise.resolve() }),
      ),
      getFirstAsync: vi.fn((sql: string) => {
        if (sql.includes("PRAGMA user_version")) {
          return Promise.resolve({ user_version: 1 });
        }
        if (loadPreferencesFails) {
          return Promise.reject(new Error("database unavailable"));
        }
        return Promise.resolve(
          preferencesJson === null
            ? null
            : { payload: preferencesJson, updatedAt: preferencesUpdatedAt },
        );
      }),
      runAsync: vi.fn((_sql: string, payload?: unknown, updatedAt?: unknown) => {
        if (savePreferencesFails) {
          return Promise.reject(new Error("database unavailable"));
        }
        if (typeof payload === "string") {
          preferencesJson = payload;
        }
        if (typeof updatedAt === "number") {
          preferencesUpdatedAt = updatedAt;
        }
        return Promise.resolve();
      }),
    },
  };
});

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => null,
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: mocks.deleteItemAsync,
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
}));

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: vi.fn(() => Promise.resolve(mocks.database)),
}));

vi.mock("expo-crypto", () => ({
  getRandomBytes: vi.fn(() => new Uint8Array(16)),
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active" },
  Platform: {
    OS: "ios",
  },
}));

import { loadPreferences, savePreferencesPatch } from "../persistence/imperative";
import { CONNECTION_CATALOG_KEY, make as makeCatalogStore } from "../connection/catalog-store";
import { layer as secureStorageLayer } from "../persistence/mobile-secure-storage";

describe("mobile connection storage", () => {
  beforeEach(() => {
    mocks.clear();
    vi.clearAllMocks();
  });

  it("persists tab order locally and retains it when another preference changes", async () => {
    const navigationTabOrder = ["usage", "threads", "pullRequests"];
    const hiddenNavigationTabs = ["issues", "home"];
    await savePreferencesPatch({ navigationTabOrder, hiddenNavigationTabs });
    await savePreferencesPatch({ baseFontSize: 19 });
    await expect(loadPreferences()).resolves.toEqual({
      navigationTabOrder,
      hiddenNavigationTabs,
      baseFontSize: 19,
    });
  });

  it("ignores invalid tab-order entries without dropping other saved preferences", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        navigationTabOrder: ["usage", null, 4, "threads"],
        hiddenNavigationTabs: ["home", null],
        baseFontSize: 18,
      }),
      1,
    );
    await expect(loadPreferences()).resolves.toEqual({
      navigationTabOrder: ["usage", "threads"],
      hiddenNavigationTabs: ["home"],
      baseFontSize: 18,
    });
  });

  effectIt.effect(
    "includes native read diagnostics in catalog failures without discarding stored data",
    () =>
      Effect.gen(function* () {
        const cause = Object.assign(new Error("User interaction is not allowed."), {
          code: "ERR_SECURESTORE_READ",
        });
        mocks.getItemAsync.mockRejectedValueOnce(cause);
        const catalog = yield* makeCatalogStore();
        const error = yield* Effect.flip(catalog.read);

        expect(error).toMatchObject({
          _tag: "ConnectionTransientError",
          detail:
            `Could not load the local connection catalog: MobileSecureStorageError: ` +
            `Mobile secure storage operation read failed for key ${CONNECTION_CATALOG_KEY}. ` +
            "User interaction is not allowed. (ERR_SECURESTORE_READ)",
        });
        expect(mocks.getItemAsync).toHaveBeenCalledExactlyOnceWith(CONNECTION_CATALOG_KEY);
        expect(mocks.deleteItemAsync).not.toHaveBeenCalled();
        expect(mocks.setItemAsync).not.toHaveBeenCalled();
      }).pipe(Effect.provide(secureStorageLayer)),
  );

  it("loads legacy preferences when SQLite is unavailable", async () => {
    mocks.setDatabaseFailures(true, true);
    await mocks.setItemAsync("t3code.preferences", JSON.stringify({ baseFontSize: 17 }));

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 17 });
  });

  it.each(["tint", "solid", "off"] as const)(
    "persists thread origin display mode %s without changing the theme",
    async (threadOriginColorMode) => {
      await savePreferencesPatch({ themeMode: "dark" });
      await savePreferencesPatch({ threadOriginColorMode });
      await expect(loadPreferences()).resolves.toEqual({
        themeMode: "dark",
        threadOriginColorMode,
      });
    },
  );

  it("ignores an unknown thread origin display mode in saved preferences", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({ threadOriginColorMode: "unknown", themeMode: "dark" }),
      10,
    );
    await expect(loadPreferences()).resolves.toEqual({ themeMode: "dark" });
  });

  it("persists independent tint strengths including zero without changing highlights or theme", async () => {
    const neighbors = {
      themeMode: "dark",
      threadHighlights: { "mini:thread": "#ec4899" },
      threadOriginColorMode: "tint",
    } as const;
    await savePreferencesPatch({
      ...neighbors,
      threadLeftTintStrength: 22,
      threadRightTintStrength: 45,
    });
    await savePreferencesPatch({ threadLeftTintStrength: 0 });
    await expect(loadPreferences()).resolves.toEqual({
      ...neighbors,
      threadLeftTintStrength: 0,
      threadRightTintStrength: 45,
    });
    await savePreferencesPatch({ threadRightTintStrength: 60 });
    const persisted = JSON.parse(mocks.getPreferencesJson() ?? "");
    expect(persisted).toEqual({
      ...neighbors,
      threadLeftTintStrength: 0,
      threadRightTintStrength: 60,
    });
    mocks.clear();
    mocks.setPreferencesJson(JSON.stringify(persisted), 10);
    await expect(loadPreferences()).resolves.toEqual(persisted);
  });

  it("keeps valid sidebar spaces and drops malformed ones and a dangling active space", async () => {
    const work = { id: "w", name: "Work", color: "#3b82f6", projectRefs: ["mini:api"] };
    mocks.setPreferencesJson(
      JSON.stringify({
        themeMode: "dark",
        sidebarSpaces: { spaces: [work, { id: 1 }], activeSpaceId: "missing" },
      }),
      10,
    );
    await expect(loadPreferences()).resolves.toEqual({
      themeMode: "dark",
      sidebarSpaces: { spaces: [work], activeSpaceId: null },
    });
  });

  it("round-trips per-Space grouping, custom work types, assignments and canonical colours", async () => {
    const preferences = {
      themeMode: "dark" as const,
      sidebarSpaces: {
        spaces: [
          {
            id: "api",
            name: "APIs",
            color: "#3b82f6",
            projectRefs: [],
            groupBy: "work_type" as const,
            workTypeIds: ["custom"],
          },
        ],
        activeSpaceId: "api",
      },
      workTypes: [{ id: "custom", name: "My APIs" }],
      repositoryWorkTypes: { "repository:github.com/example/api": "custom" },
      repositoryHighlights: { "repository:github.com/example/api": "#123456" as const },
      machineHighlights: { host: "none" as const },
      workTypeHighlights: { custom: "#3b82f6" as const },
    };
    await savePreferencesPatch(preferences);
    const persisted = mocks.getPreferencesJson()!;
    mocks.clear();
    mocks.setPreferencesJson(persisted, 10);
    await expect(loadPreferences()).resolves.toEqual(preferences);
  });

  it("persists per-Space last-opened threads and discards malformed memories", async () => {
    const sidebarSpaceLastThreadKeys = { all: "host:all-thread", "space:work": "host:work-thread" };
    await savePreferencesPatch({ sidebarSpaceLastThreadKeys });
    await expect(loadPreferences()).resolves.toMatchObject({ sidebarSpaceLastThreadKeys });
    mocks.setPreferencesJson(
      JSON.stringify({ themeMode: "dark", sidebarSpaceLastThreadKeys: { "space:work": 42 } }),
      20,
    );
    await expect(loadPreferences()).resolves.toEqual({ themeMode: "dark" });
  });

  it("clamps and rounds finite saved tint strengths", async () => {
    await expect(
      savePreferencesPatch({ threadLeftTintStrength: -5, threadRightTintStrength: 90 }),
    ).resolves.toEqual({
      threadLeftTintStrength: 0,
      threadRightTintStrength: 60,
    });
    await savePreferencesPatch({ threadLeftTintStrength: 12.6, threadRightTintStrength: 20.4 });
    await expect(loadPreferences()).resolves.toEqual({
      threadLeftTintStrength: 13,
      threadRightTintStrength: 20,
    });
  });

  it("drops nonfinite tint patches without losing neighboring preferences", async () => {
    await savePreferencesPatch({
      themeMode: "dark",
      threadLeftTintStrength: 22,
      threadRightTintStrength: 22,
    });
    await savePreferencesPatch({
      threadLeftTintStrength: Number.NaN,
      threadRightTintStrength: Number.POSITIVE_INFINITY,
    });
    await expect(loadPreferences()).resolves.toEqual({ themeMode: "dark" });
    await savePreferencesPatch({ threadLeftTintStrength: Number.NEGATIVE_INFINITY });
    await expect(loadPreferences()).resolves.toEqual({ themeMode: "dark" });
  });

  it("sanitizes stored tint strengths without adding defaults to older preferences", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        threadLeftTintStrength: -3.8,
        threadRightTintStrength: 100,
        themeMode: "dark",
      }),
      10,
    );
    await expect(loadPreferences()).resolves.toEqual({
      threadLeftTintStrength: 0,
      threadRightTintStrength: 60,
      themeMode: "dark",
    });
    mocks.setPreferencesJson(
      JSON.stringify({
        threadLeftTintStrength: "30",
        threadRightTintStrength: null,
        themeMode: "dark",
      }),
      20,
    );
    await expect(loadPreferences()).resolves.toEqual({ themeMode: "dark" });
  });

  it("persists and resets repository colors without altering legacy thread colors or theme", async () => {
    const neighbors = {
      themeMode: "dark",
      threadHighlights: { "mini:thread": "#ec4899" },
      threadLeftTintStrength: 0,
      threadRightTintStrength: 45,
    } as const;
    await savePreferencesPatch(neighbors);
    await savePreferencesPatch({
      repositoryHighlights: { "mini:project": "#3b82f6", "beef:project": "none" },
    });
    await expect(loadPreferences()).resolves.toEqual({
      ...neighbors,
      repositoryHighlights: { "mini:project": "#3b82f6", "beef:project": "none" },
    });
    await savePreferencesPatch({ repositoryHighlights: { "beef:project": "none" } });
    await expect(loadPreferences()).resolves.toEqual({
      ...neighbors,
      repositoryHighlights: { "beef:project": "none" },
    });
    await savePreferencesPatch({ repositoryHighlights: {} });
    await expect(loadPreferences()).resolves.toEqual({ ...neighbors, repositoryHighlights: {} });
  });

  it("sanitizes repository colors separately from legacy thread colors", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        themeMode: "dark",
        threadHighlights: { "mini:thread": "#ec4899" },
        repositoryHighlights: {
          "mini:project": "#ABCDEF",
          "beef:project": "none",
          invalid: "blue",
          nonString: true,
        },
      }),
      10,
    );
    await expect(loadPreferences()).resolves.toEqual({
      themeMode: "dark",
      threadHighlights: { "mini:thread": "#ec4899" },
      repositoryHighlights: { "mini:project": "#ABCDEF", "beef:project": "none" },
    });
  });

  it("persists local thread highlights and reset while preserving unrelated preferences", async () => {
    await savePreferencesPatch({
      themeMode: "dark",
      threadHighlights: { "mini:thread": "#ec4899", "beef:thread": "none" },
    });
    await expect(loadPreferences()).resolves.toEqual({
      themeMode: "dark",
      threadHighlights: { "mini:thread": "#ec4899", "beef:thread": "none" },
    });
    await savePreferencesPatch({ threadHighlights: { "beef:thread": "none" } });
    await expect(loadPreferences()).resolves.toEqual({
      themeMode: "dark",
      threadHighlights: { "beef:thread": "none" },
    });
  });

  it("ignores invalid stored highlight entries without losing the rest of the preferences", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        themeMode: "dark",
        threadHighlights: { valid: "#abcdef", hidden: "none", invalid: "blue", nonString: true },
      }),
      10,
    );
    await expect(loadPreferences()).resolves.toEqual({
      themeMode: "dark",
      threadHighlights: { valid: "#abcdef", hidden: "none" },
    });
  });

  it("falls back to secure storage when SQLite cannot save preferences", async () => {
    mocks.setDatabaseFailures(true, true);
    await expect(savePreferencesPatch({ baseFontSize: 19 })).resolves.toEqual({ baseFontSize: 19 });
    const fallback = JSON.parse(mocks.getStoredValue("t3code.preferences.fallback") ?? "") as {
      readonly payload: string;
      readonly updatedAt: number;
    };
    expect(JSON.parse(fallback.payload)).toEqual({ baseFontSize: 19 });
    expect(fallback.updatedAt).toEqual(expect.any(Number));
  });

  it("reconciles fallback preferences after SQLite recovers", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 15 }), 10);
    await mocks.setItemAsync(
      "t3code.preferences.fallback",
      JSON.stringify({
        payload: JSON.stringify({ baseFontSize: 19 }),
        updatedAt: 20,
      }),
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 19 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 19 });
    expect(mocks.getStoredValue("t3code.preferences.fallback")).toBeNull();
  });

  it("ignores a stale fallback when its previous deletion failed", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync(
      "t3code.preferences.fallback",
      JSON.stringify({
        payload: JSON.stringify({ baseFontSize: 19 }),
        updatedAt: 20,
      }),
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
    expect(mocks.getStoredValue("t3code.preferences.fallback")).toBeNull();
  });

  it("keeps SQLite authoritative when stale legacy preferences remain", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync("t3code.preferences", JSON.stringify({ baseFontSize: 19 }));

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
  });
});
