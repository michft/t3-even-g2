import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Atom, AtomRegistry } from "effect/reactivity";
import { createThreadListEnvironmentsAtom } from "./thread-list-environments";

const ID = EnvironmentId.make("one");
const OTHER_ID = EnvironmentId.make("two");
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const config = {
  providers: [provider],
  environment: { capabilities: {}, platform: { machine: "laptop" } },
  settings: {},
} as unknown as ServerConfig;

function harness() {
  const registry = AtomRegistry.make();
  const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
    new Map([
      [ID, config],
      [OTHER_ID, config],
    ]),
  );
  const list = createThreadListEnvironmentsAtom(configs);
  let listNotifications = 0;
  registry.subscribe(list, () => listNotifications++);
  registry.get(list);
  listNotifications = 0;
  return {
    registry,
    configs,
    read: () => registry.get(list),
    write: (next: ServerConfig) =>
      registry.set(
        configs,
        new Map([
          [ID, next],
          [OTHER_ID, config],
        ]),
      ),
    notifications: () => listNotifications,
  };
}

describe("thread list environment projection", () => {
  it("publishes accent-only palette updates without replacing provider references", () => {
    const h = harness();
    const themed: ServerConfig = {
      ...config,
      settings: { ...config.settings, defaultTheme: "custom" },
      environmentThemes: [
        {
          id: "custom",
          name: "Custom",
          appearance: "light",
          canvas: "#fafafa",
          accent: "#ec4899",
        },
      ],
    };
    try {
      h.write(themed);
      const first = h.read();
      expect(first.environmentAccentByEnvironmentId.get(ID)).toBe("#ec4899");
      h.write({
        ...themed,
        environmentThemes: [{ ...themed.environmentThemes![0]!, accent: "#22c55e" }],
      });
      const second = h.read();
      expect(second).not.toBe(first);
      expect(second.environmentAccentByEnvironmentId.get(ID)).toBe("#22c55e");
      expect(second.environmentColorByEnvironmentId.get(ID)).toBe("#fafafa");
      expect(second.providersByEnvironmentId.get(ID)).toBe(first.providersByEnvironmentId.get(ID));
    } finally {
      h.registry.dispose();
    }
  });

  it("keeps light and dark origin colours current across remote default changes", () => {
    const registry = AtomRegistry.make();
    const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(new Map());
    const light = createThreadListEnvironmentsAtom(configs, "light");
    const dark = createThreadListEnvironmentsAtom(configs, "dark");
    try {
      for (const [defaultTheme, lightColor, darkColor] of [
        ["ember", "#f9f7f5", "#291e1a"],
        ["grove", "#f3f7f4", "#1b2821"],
      ] as const) {
        registry.set(
          configs,
          new Map([[ID, { ...config, settings: { ...config.settings, defaultTheme } }]]),
        );
        expect(registry.get(light).environmentColorByEnvironmentId.get(ID)).toBe(lightColor);
        expect(registry.get(dark).environmentColorByEnvironmentId.get(ID)).toBe(darkColor);
      }
    } finally {
      registry.dispose();
    }
  });

  it("publishes remote default-theme updates and clearing without replacing provider references", () => {
    const h = harness();
    try {
      const initial = h.read();
      const providers = initial.providersByEnvironmentId.get(ID);
      const otherProviders = initial.providersByEnvironmentId.get(OTHER_ID);
      expect(initial.environmentColorByEnvironmentId.get(ID)).toBeNull();
      h.write({
        ...config,
        settings: { ...config.settings, defaultTheme: "grove", environmentColor: "#1b2821" },
      });
      const coloured = h.read();
      expect(coloured).not.toBe(initial);
      expect(coloured.environmentColorByEnvironmentId.get(ID)).toBe("#f3f7f4");
      expect(coloured.environmentColorByEnvironmentId.get(OTHER_ID)).toBeNull();
      expect(coloured.providersByEnvironmentId.get(ID)).toBe(providers);
      expect(coloured.providersByEnvironmentId.get(OTHER_ID)).toBe(otherProviders);
      h.write({ ...config, settings: { ...config.settings, defaultTheme: "grove" } });
      expect(h.read()).toBe(coloured);
      h.write({ ...config, settings: { ...config.settings, defaultTheme: "" } });
      expect(h.read().environmentColorByEnvironmentId.get(ID)).toBeNull();
      expect(h.read().providersByEnvironmentId.get(ID)).toBe(providers);
      expect(h.notifications()).toBe(2);
    } finally {
      h.registry.dispose();
    }
  });

  it("updates each remote's colour when its published canvas changes or disappears", () => {
    const h = harness();
    const themed: ServerConfig = {
      ...config,
      settings: { ...config.settings, defaultTheme: "nightfall" },
      environmentThemes: [
        {
          id: "nightfall",
          name: "Nightfall",
          appearance: "dark",
          canvas: "#123456",
          accent: "#abcdef",
        },
      ],
    };
    try {
      h.write(themed);
      const initial = h.read();
      expect(initial.environmentColorByEnvironmentId.get(ID)).toBe("#123456");
      expect(initial.environmentColorByEnvironmentId.get(OTHER_ID)).toBeNull();
      h.write({
        ...themed,
        environmentThemes: [{ ...themed.environmentThemes![0]!, canvas: "#654321" }],
      });
      expect(h.read().environmentColorByEnvironmentId.get(ID)).toBe("#654321");
      expect(h.read().providersByEnvironmentId.get(ID)).toBe(
        initial.providersByEnvironmentId.get(ID),
      );
      h.write({ ...themed, environmentThemes: [] });
      expect(h.read().environmentColorByEnvironmentId.get(ID)).toBeNull();
    } finally {
      h.registry.dispose();
    }
  });

  it("removes origin colors for forgotten environments and restores them on reconnect", () => {
    const h = harness();
    const themed = { ...config, settings: { ...config.settings, defaultTheme: "grove" } };
    try {
      h.write(themed);
      expect(h.read().environmentColorByEnvironmentId.get(ID)).toBe("#f3f7f4");
      h.registry.set(h.configs, new Map());
      expect(h.read().environmentColorByEnvironmentId.size).toBe(0);
      expect(h.read().environmentAccentByEnvironmentId.size).toBe(0);
      h.write(themed);
      expect([...h.read().environmentColorByEnvironmentId.keys()]).toEqual([ID, OTHER_ID]);
      expect(h.read().environmentColorByEnvironmentId.get(ID)).toBe("#f3f7f4");
    } finally {
      h.registry.dispose();
    }
  });
});
