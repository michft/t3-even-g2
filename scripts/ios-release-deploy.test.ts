import { describe, expect, it } from "vite-plus/test";
import {
  validateBuildNumber,
  validateIdentity,
  validateProvisioning,
  validateRelease,
} from "./ios-release-deploy.ts";

const bundle = "net.example.t3code.g2";
const identity = {
  "application-identifier": `TEAM123456.${bundle}`,
  "com.apple.developer.team-identifier": "TEAM123456",
  "keychain-access-groups": [`TEAM123456.${bundle}`],
};
const profile = {
  ExpirationDate: "2030-01-01T00:00:00Z",
  TeamIdentifier: ["TEAM123456"],
  ProvisionedDevices: ["00000001-0011223344556677", "00000002-8899AABBCCDDEEFF"],
  Entitlements: {
    "application-identifier": identity["application-identifier"],
    "com.apple.developer.team-identifier": "TEAM123456",
  },
};
const info = {
  CFBundleIdentifier: bundle,
  CFBundleExecutable: "T3CodeDev",
  CFBundleShortVersionString: "2.0.0",
  CFBundleVersion: "2",
  CFBundleSupportedPlatforms: ["iPhoneOS"],
  UIDeviceFamily: [1, 2],
};
const now = Date.parse("2026-10-09T00:00:00Z");

describe("iOS Release deployment safety", () => {
  it("accepts a provisioned universal Dev update preserving identity", () => {
    expect(() => validateIdentity(identity, identity, bundle, bundle)).not.toThrow();
    expect(() =>
      validateProvisioning(
        profile,
        identity,
        profile.ProvisionedDevices,
        "2030-01-01T00:00:00Z",
        now,
      ),
    ).not.toThrow();
    expect(() => validateRelease(info, "arm64", 4000, false)).not.toThrow();
    expect(() => validateBuildNumber("111", "110")).not.toThrow();
  });
  it("rejects application, team, bundle and keychain identity changes", () => {
    expect(() =>
      validateIdentity(
        { ...identity, "application-identifier": "TEAM123456.other" },
        identity,
        bundle,
        bundle,
      ),
    ).toThrow("Application identifier");
    expect(() =>
      validateIdentity(
        { ...identity, "com.apple.developer.team-identifier": "OTHER12345" },
        identity,
        bundle,
        bundle,
      ),
    ).toThrow("Signing team");
    expect(() =>
      validateIdentity(
        { ...identity, "keychain-access-groups": ["other"] },
        identity,
        bundle,
        bundle,
      ),
    ).toThrow("Keychain");
    expect(() => validateIdentity(identity, identity, "net.other", bundle)).toThrow("bundle");
    expect(() =>
      validateIdentity(identity, identity, "com.t3tools.t3code.dev", "com.t3tools.t3code.dev"),
    ).toThrow("Custom Dev");
  });
  it("rejects expired and invalid profile or signing certificate dates", () => {
    expect(() =>
      validateProvisioning(
        { ...profile, ExpirationDate: "2026-10-08" },
        identity,
        profile.ProvisionedDevices,
        "2030-01-01",
        now,
      ),
    ).toThrow("Provisioning profile expired");
    expect(() =>
      validateProvisioning(profile, identity, profile.ProvisionedDevices, "2026-10-08", now),
    ).toThrow("Signing certificate expired");
    expect(() =>
      validateProvisioning(profile, identity, profile.ProvisionedDevices, "invalid", now),
    ).toThrow("Signing certificate expired");
  });
  it("requires every requested device and the signed team/application in the profile", () => {
    expect(() => validateProvisioning(profile, identity, ["unknown"], "2030-01-01", now)).toThrow(
      "Device not provisioned",
    );
    expect(() =>
      validateProvisioning(
        { ...profile, TeamIdentifier: ["OTHER12345"] },
        identity,
        profile.ProvisionedDevices,
        "2030-01-01",
        now,
      ),
    ).toThrow("Provisioning team");
    expect(() =>
      validateProvisioning(
        {
          ...profile,
          Entitlements: { ...profile.Entitlements, "application-identifier": "TEAM123456.other" },
        },
        identity,
        profile.ProvisionedDevices,
        "2030-01-01",
        now,
      ),
    ).toThrow("Provisioning application");
    expect(() =>
      validateProvisioning(
        {
          ...profile,
          Entitlements: { ...profile.Entitlements, "application-identifier": "TEAM123456.*" },
        },
        identity,
        profile.ProvisionedDevices,
        "2030-01-01",
        now,
      ),
    ).not.toThrow();
  });
  it("rejects OTA-enabled, empty, simulator and phone-only artifacts", () => {
    expect(() => validateRelease(info, "arm64", 100, true)).toThrow("OTA");
    expect(() => validateRelease(info, "arm64", 0, false)).toThrow("JavaScript");
    expect(() =>
      validateRelease(
        { ...info, CFBundleSupportedPlatforms: ["iPhoneSimulator"] },
        "arm64",
        100,
        false,
      ),
    ).toThrow("iPhoneOS");
    expect(() => validateRelease(info, "x86_64", 100, false)).toThrow("arm64");
    expect(() => validateRelease({ ...info, UIDeviceFamily: [1] }, "arm64", 100, false)).toThrow(
      "iPhone and iPad",
    );
  });
  it("rejects unchanged, older and nonnumeric installed build numbers", () => {
    for (const [next, previous] of [
      ["2", "2"],
      ["1", "2"],
      ["2.1", "2"],
      ["3", "unknown"],
    ])
      expect(() => validateBuildNumber(next!, previous!)).toThrow("build number");
  });
});
