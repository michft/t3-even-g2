import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const repoEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock("../../scripts/lib/public-config.ts", () => ({ loadRepoEnv: () => repoEnv }));

const forkEnv = {
  APP_VARIANT: "development",
  T3CODE_IOS_PERSONAL_TEAM: "1",
  T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.g2",
  T3CODE_IOS_TESTFLIGHT: "1",
  T3CODE_IOS_TEAM_ID: "ABCDE12345",
  T3CODE_EXPO_OWNER: "example-fork",
  T3CODE_EXPO_PROJECT_ID: "11111111-2222-4333-8444-555555555555",
  T3CODE_MOBILE_UPDATES_ENABLED: "1",
};

beforeEach(() => {
  vi.resetModules();
  Object.assign(repoEnv, forkEnv);
  for (const key of Object.keys(forkEnv)) vi.stubEnv(key, undefined);
  vi.stubEnv("MOBILE_VERSION_POLICY", undefined);
});
afterEach(() => vi.unstubAllEnvs());

/** Reloads the evaluated Expo config with this test's isolated build environment. */
async function readConfig() {
  return (await import("./app.config.ts")).default;
}

describe("fork TestFlight config", () => {
  it("preserves the Dev app identity and pins signing/Expo to the fork", async () => {
    const config = await readConfig();
    expect(config).toMatchObject({
      name: "T3 Code Dev",
      scheme: "t3code-dev",
      owner: forkEnv.T3CODE_EXPO_OWNER,
      ios: {
        supportsTablet: true,
        bundleIdentifier: forkEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID,
        appleTeamId: forkEnv.T3CODE_IOS_TEAM_ID,
        entitlements: {
          "keychain-access-groups": ["$(AppIdentifierPrefix)com.example.g2"],
        },
      },
      updates: {
        enabled: false,
        url: `https://u.expo.dev/${forkEnv.T3CODE_EXPO_PROJECT_ID}`,
      },
      extra: { eas: { projectId: forkEnv.T3CODE_EXPO_PROJECT_ID }, iosPersonalTeamBuild: true },
    });
    expect(config.ios?.associatedDomains).toBeUndefined();
  });

  it("rejects missing or malformed fork identities instead of falling back to upstream", async () => {
    delete repoEnv.T3CODE_IOS_TEAM_ID;
    await expect(readConfig()).rejects.toThrow("T3CODE_IOS_TEAM_ID");
    vi.resetModules();
    repoEnv.T3CODE_IOS_TEAM_ID = "invalid";
    await expect(readConfig()).rejects.toThrow("T3CODE_IOS_TEAM_ID");
    vi.resetModules();
    repoEnv.T3CODE_IOS_TEAM_ID = forkEnv.T3CODE_IOS_TEAM_ID;
    delete repoEnv.T3CODE_EXPO_OWNER;
    await expect(readConfig()).rejects.toThrow("T3CODE_EXPO_OWNER");
    vi.resetModules();
    repoEnv.T3CODE_EXPO_OWNER = forkEnv.T3CODE_EXPO_OWNER;
    repoEnv.T3CODE_EXPO_PROJECT_ID = "invalid";
    await expect(readConfig()).rejects.toThrow("T3CODE_EXPO_PROJECT_ID");
  });

  it("rejects upstream Apple, bundle, Expo owner, and Expo project identities", async () => {
    repoEnv.T3CODE_IOS_TEAM_ID = "ARK85ZXQ4Z";
    await expect(readConfig()).rejects.toThrow("fork Apple Developer team");
    vi.resetModules();
    repoEnv.T3CODE_IOS_TEAM_ID = forkEnv.T3CODE_IOS_TEAM_ID;
    repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID = "com.t3tools.t3code.dev";
    await expect(readConfig()).rejects.toThrow("fork bundle ID");
    vi.resetModules();
    repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID = forkEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID;
    repoEnv.T3CODE_EXPO_OWNER = "pingdotgg";
    await expect(readConfig()).rejects.toThrow("fork Expo account");
    vi.resetModules();
    repoEnv.T3CODE_EXPO_OWNER = forkEnv.T3CODE_EXPO_OWNER;
    repoEnv.T3CODE_EXPO_PROJECT_ID = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";
    await expect(readConfig()).rejects.toThrow("fork Expo project's UUID");
  });

  it("rejects a production identity or full-capability prebuild", async () => {
    repoEnv.APP_VARIANT = "production";
    await expect(readConfig()).rejects.toThrow("APP_VARIANT=development");
    vi.resetModules();
    repoEnv.APP_VARIANT = "development";
    repoEnv.T3CODE_IOS_PERSONAL_TEAM = "0";
    await expect(readConfig()).rejects.toThrow("T3CODE_IOS_PERSONAL_TEAM=1");
  });

  it("accepts a supported runtime policy and rejects invalid overrides", async () => {
    vi.stubEnv("MOBILE_VERSION_POLICY", "fingerprint");
    expect((await readConfig()).runtimeVersion).toEqual({ policy: "fingerprint" });
    vi.resetModules();
    vi.stubEnv("MOBILE_VERSION_POLICY", "invalid");
    await expect(readConfig()).rejects.toThrow("Unsupported MOBILE_VERSION_POLICY");
  });

  it("keeps ordinary upstream builds on their existing identity and updates", async () => {
    repoEnv.T3CODE_IOS_TESTFLIGHT = "0";
    repoEnv.T3CODE_IOS_PERSONAL_TEAM = "0";
    repoEnv.APP_VARIANT = "production";
    const config = await readConfig();
    expect(config).toMatchObject({
      name: "T3 Code",
      owner: "pingdotgg",
      ios: { bundleIdentifier: "com.t3tools.t3code", appleTeamId: "ARK85ZXQ4Z" },
      updates: { enabled: true, url: "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454" },
      extra: { eas: { projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454" } },
    });
  });
});
