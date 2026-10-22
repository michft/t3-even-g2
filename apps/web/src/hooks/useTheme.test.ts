import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferredPublication() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function desktopAppearanceFixture(appearanceMode: "system" | "dark" = "system") {
  const storage = createStorage();
  storage.setItem("t3code:theme-appearance-mode", appearanceMode);
  let dark = appearanceMode === "dark";
  let systemListener: (() => void) | undefined;
  let themeSubscribe: ((listener: () => void) => () => void) | undefined;
  let publication = deferredPublication();
  const setTheme = vi.fn(async () => publication.resolve());
  const root = {
    dataset: {} as Record<string, string>,
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    offsetHeight: 0,
  };
  vi.doMock("react", () => ({
    useCallback: <A>(callback: A) => callback,
    useEffect: () => undefined,
    useSyncExternalStore: (
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => unknown,
    ) => {
      themeSubscribe = subscribe;
      return getSnapshot();
    },
  }));
  vi.stubGlobal("window", {
    localStorage: storage,
    desktopBridge: { setTheme },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => ({
      matches: dark,
      addEventListener: (_type: string, listener: () => void) => {
        systemListener = listener;
      },
      removeEventListener: vi.fn(),
    }),
  });
  vi.stubGlobal("document", {
    documentElement: root,
    body: { style: {} },
    head: { append: vi.fn() },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute: vi.fn() }),
  });
  vi.stubGlobal("getComputedStyle", () => ({
    backgroundColor: "#fcfcfc",
    getPropertyValue: () => "",
  }));
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  const module = await import("./useTheme");
  await publication.promise;
  const hook = module.useTheme();
  themeSubscribe?.(() => undefined);
  const nextPublication = () => {
    publication = deferredPublication();
    return publication.promise;
  };
  return {
    hook,
    root,
    storage,
    setTheme,
    nextPublication,
    setSystemDark: (value: boolean) => {
      dark = value;
      systemListener?.();
    },
  };
}

describe("host Appearance publication", () => {
  it("retries failed canvas publication without leaking the IPC cause", async () => {
    const fixture = await desktopAppearanceFixture();
    const cause = new Error("desktop IPC unavailable");
    const failed = deferredPublication();
    using errorLog = vi.spyOn(console, "error").mockImplementation(() => failed.resolve());
    fixture.setTheme.mockRejectedValueOnce(cause);
    fixture.hook.setTheme("grove");
    await failed.promise;

    const published = fixture.nextPublication();
    fixture.hook.refreshTheme();
    await published;
    expect(fixture.setTheme).toHaveBeenCalledTimes(3);
    expect(fixture.setTheme.mock.calls[1]).toEqual(fixture.setTheme.mock.calls[2]);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the grove theme to the desktop shell.",
      expect.objectContaining({ theme: "grove", errorTag: "DesktopThemeSyncError" }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);
  });

  it("publishes canvas changes between themes with the same native appearance", async () => {
    const fixture = await desktopAppearanceFixture("dark");
    const { GROVE_THEME, OCEAN_THEME, themeColorToHex } = await import("../themePalette");
    let published = fixture.nextPublication();
    fixture.hook.setTheme("grove");
    await published;
    expect(fixture.setTheme).toHaveBeenLastCalledWith(
      "dark",
      themeColorToHex(GROVE_THEME.variants!.dark!.canvas),
    );

    published = fixture.nextPublication();
    fixture.hook.setTheme("ocean");
    await published;
    expect(fixture.setTheme).toHaveBeenLastCalledWith(
      "dark",
      themeColorToHex(OCEAN_THEME.variants!.dark!.canvas),
    );
  });

  it("follows the selected light and dark halves when system appearance changes", async () => {
    const fixture = await desktopAppearanceFixture();
    const { GROVE_THEME, OCEAN_THEME, themeColorToHex } = await import("../themePalette");
    let published = fixture.nextPublication();
    fixture.hook.setThemeHalf("light", "grove");
    await published;
    fixture.hook.setThemeHalf("dark", "ocean");
    expect(fixture.setTheme).toHaveBeenLastCalledWith(
      "system",
      themeColorToHex(GROVE_THEME.colors.canvas),
    );

    published = fixture.nextPublication();
    fixture.setSystemDark(true);
    await published;
    expect(fixture.setTheme).toHaveBeenLastCalledWith(
      "system",
      themeColorToHex(OCEAN_THEME.variants!.dark!.canvas),
    );
  });

  it("publishes saved custom canvas edits while keeping editor drafts local", async () => {
    const fixture = await desktopAppearanceFixture();
    const palette = await import("../themePalette");
    const custom = palette.installCustomTheme({
      id: "host-custom",
      label: "Host custom",
      appearance: "light",
      colors: { ...palette.getStandardThemeColors("light"), canvas: "#112233" },
    });
    let published = fixture.nextPublication();
    fixture.hook.setTheme(custom.id);
    await published;
    expect(fixture.setTheme).toHaveBeenLastCalledWith("light", "#112233");
    const beforePreview = fixture.setTheme.mock.calls.length;
    palette.applyThemeColorPreview({ ...custom.colors, canvas: "#ff0000" }, "light");
    fixture.hook.refreshTheme({ preservePreview: true });
    expect(fixture.setTheme).toHaveBeenCalledTimes(beforePreview);

    palette.updateCustomTheme({ ...custom, colors: { ...custom.colors, canvas: "#445566" } });
    published = fixture.nextPublication();
    fixture.hook.refreshTheme();
    await published;
    expect(fixture.setTheme).toHaveBeenLastCalledWith("light", "#445566");
  });

  it("serializes rapid changes so the latest host canvas lands last", async () => {
    const fixture = await desktopAppearanceFixture();
    const firstWrite = deferredPublication();
    const started = deferredPublication();
    fixture.setTheme.mockImplementationOnce(async () => {
      started.resolve();
      await firstWrite.promise;
    });
    const next = fixture.nextPublication();
    fixture.hook.setTheme("grove");
    fixture.hook.setTheme("ocean");
    await started.promise;
    expect(fixture.setTheme).toHaveBeenCalledTimes(2);
    firstWrite.resolve();
    await next;
    const { OCEAN_THEME, themeColorToHex } = await import("../themePalette");
    expect(fixture.setTheme).toHaveBeenLastCalledWith(
      "system",
      themeColorToHex(OCEAN_THEME.colors.canvas),
    );
  });

  it("flattens transparent imported canvases for the opaque server projection", async () => {
    const fixture = await desktopAppearanceFixture();
    const palette = await import("../themePalette");
    const custom = palette.installCustomTheme({
      id: "transparent-canvas",
      label: "Transparent canvas",
      appearance: "light",
      colors: { ...palette.getStandardThemeColors("light"), canvas: "#11223380" },
    });
    const published = fixture.nextPublication();
    fixture.hook.setTheme(custom.id);
    await published;
    expect(fixture.setTheme).toHaveBeenLastCalledWith("light", "#868f97");
  });

  it("leaves browser-only Appearance local", async () => {
    const fixture = await desktopAppearanceFixture();
    vi.stubGlobal("window", {
      localStorage: fixture.storage,
      matchMedia: () => ({ matches: false }),
    });
    const before = fixture.setTheme.mock.calls.length;
    fixture.hook.setTheme("grove");
    expect(fixture.setTheme).toHaveBeenCalledTimes(before);
  });
});
