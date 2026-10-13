// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Standalone macOS deployment CLI uses host tools and local receipts.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

const IdentitySchema = Schema.Struct({
  "application-identifier": Schema.String,
  "com.apple.developer.team-identifier": Schema.String,
  "keychain-access-groups": Schema.Array(Schema.String),
});
const InfoSchema = Schema.Struct({
  CFBundleIdentifier: Schema.String,
  CFBundleExecutable: Schema.String,
  CFBundleShortVersionString: Schema.String,
  CFBundleVersion: Schema.String,
  CFBundleSupportedPlatforms: Schema.Array(Schema.String),
  UIDeviceFamily: Schema.Array(Schema.Number),
});
const ProfileSchema = Schema.Struct({
  ExpirationDate: Schema.String,
  TeamIdentifier: Schema.Array(Schema.String),
  ProvisionedDevices: Schema.Array(Schema.String),
  Entitlements: Schema.Struct({
    "application-identifier": Schema.String,
    "com.apple.developer.team-identifier": Schema.String,
  }),
});
const AppsSchema = Schema.Struct({
  result: Schema.Struct({
    apps: Schema.Array(
      Schema.Struct({
        bundleIdentifier: Schema.String,
        bundleVersion: Schema.String,
        version: Schema.String,
        url: Schema.String,
      }),
    ),
  }),
});
const ProcessesSchema = Schema.Struct({
  result: Schema.Struct({
    runningProcesses: Schema.Array(
      Schema.Struct({
        executable: Schema.String,
        processIdentifier: Schema.Number,
      }),
    ),
  }),
});
const decodeInfo = Schema.decodeSync(Schema.fromJsonString(InfoSchema));
const decodeIdentity = Schema.decodeSync(Schema.fromJsonString(IdentitySchema));
const decodeUpdates = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ EXUpdatesEnabled: Schema.Boolean })),
);
const decodeProfile = Schema.decodeUnknownSync(ProfileSchema);
const decodeStrings = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeProfileEntitlements = Schema.decodeSync(
  Schema.fromJsonString(ProfileSchema.fields.Entitlements),
);
const decodeApps = Schema.decodeUnknownSync(AppsSchema);
const decodeProcesses = Schema.decodeUnknownSync(ProcessesSchema);

type Identity = typeof IdentitySchema.Type;
type AppInfo = typeof InfoSchema.Type;
type Profile = typeof ProfileSchema.Type;

/** Reject identity changes that would lose the installed app's data or keychain access. */
export function validateIdentity(
  current: Identity,
  previous: Identity,
  bundle: string,
  previousBundle: string,
): void {
  if (bundle !== previousBundle || bundle.startsWith("com.t3tools."))
    throw new Error("Custom Dev bundle identity mismatch");
  if (current["application-identifier"] !== previous["application-identifier"])
    throw new Error("Application identifier mismatch");
  if (
    current["com.apple.developer.team-identifier"] !==
    previous["com.apple.developer.team-identifier"]
  )
    throw new Error("Signing team mismatch");
  if (
    JSON.stringify([...current["keychain-access-groups"]].sort()) !==
    JSON.stringify([...previous["keychain-access-groups"]].sort())
  )
    throw new Error("Keychain groups mismatch");
  if (!current["application-identifier"].endsWith(`.${bundle}`))
    throw new Error("Application identifier does not match bundle");
}

/** Require valid device provisioning and a live leaf certificate before touching devices. */
export function validateProvisioning(
  profile: Profile,
  identity: Identity,
  devices: readonly string[],
  certificateExpiry: string,
  now = Date.now(),
): void {
  for (const [name, date] of [
    ["Provisioning profile", profile.ExpirationDate],
    ["Signing certificate", certificateExpiry],
  ]) {
    const expiry = Date.parse(date!);
    if (!Number.isFinite(expiry) || expiry <= now) throw new Error(`${name} expired or invalid`);
  }
  const team = identity["com.apple.developer.team-identifier"];
  if (
    !profile.TeamIdentifier.includes(team) ||
    profile.Entitlements["com.apple.developer.team-identifier"] !== team
  )
    throw new Error("Provisioning team mismatch");
  const allowed = profile.Entitlements["application-identifier"];
  const app = identity["application-identifier"];
  if (allowed !== app && !(allowed.endsWith(".*") && app.startsWith(allowed.slice(0, -1))))
    throw new Error("Provisioning application identifier mismatch");
  for (const device of devices)
    if (!profile.ProvisionedDevices.includes(device))
      throw new Error(`Device not provisioned: ${device}`);
}

/** Ensure one self-contained device binary supports both iPhone and iPad without OTA substitution. */
export function validateRelease(
  info: AppInfo,
  architectures: string,
  javascriptBytes: number,
  updatesEnabled: boolean,
): void {
  if (
    !info.CFBundleSupportedPlatforms.includes("iPhoneOS") ||
    !architectures.split(/\s+/).includes("arm64")
  )
    throw new Error("Not an arm64 iPhoneOS app");
  if (!info.UIDeviceFamily.includes(1) || !info.UIDeviceFamily.includes(2))
    throw new Error("App must support iPhone and iPad");
  if (javascriptBytes <= 0) throw new Error("Embedded JavaScript is empty");
  if (updatesEnabled) throw new Error("Expo OTA updates must be disabled");
}

/** Prevent replacing a newer installation or silently reinstalling an unchanged build number. */
export function validateBuildNumber(next: string, installed: string): void {
  if (!/^\d+$/.test(next) || !/^\d+$/.test(installed) || BigInt(next) <= BigInt(installed))
    throw new Error("New numeric build number must exceed installed build");
}

/** Run fixed host tools without a shell and retain bounded failure diagnostics. */
function run(program: string, args: string[]): string {
  const result = NodeChildProcess.spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const reason =
      result.stderr?.trim().slice(0, 2000) || result.error?.message || "No error details";
    throw new Error(`${program} ${args[0]} failed (${result.status ?? "spawn"}): ${reason}`);
  }
  return result.stdout.trim();
}

/** Hash finalized ZIP bytes in bounded chunks, including large native frameworks. */
function hashFile(file: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const descriptor = NodeFS.openSync(file, "r");
  const chunk = Buffer.alloc(65536);
  try {
    let bytes: number;
    while ((bytes = NodeFS.readSync(descriptor, chunk, 0, chunk.length, null)) > 0)
      hash.update(chunk.subarray(0, bytes));
    return hash.digest("hex");
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

/** Decode an Apple plist using the host parser rather than approximating XML. */
function plist<T>(file: string, decode: (input: string) => T): T {
  return decode(run("plutil", ["-convert", "json", "-o", "-", file]));
}

/** Verify the signed baseline or replacement and read its immutable app identity. */
function inspectApp(app: string, scratch: string, name: string) {
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const info = plist(NodePath.join(app, "Info.plist"), decodeInfo);
  if (NodePath.basename(info.CFBundleExecutable) !== info.CFBundleExecutable)
    throw new Error("Invalid executable name");
  const entitlements = NodePath.join(scratch, `${name}-entitlements.plist`);
  NodeFS.writeFileSync(entitlements, run("codesign", ["--display", "--entitlements", ":-", app]));
  return { info, identity: plist(entitlements, decodeIdentity) };
}

/** Read CoreDevice's JSON result, retaining local logs for failures without exposing environment values. */
function deviceCommand(device: string, args: string[], output: string, label: string): unknown {
  const file = NodePath.join(output, `${device}-${label}.json`);
  run("xcrun", [
    "devicectl",
    "--timeout",
    "60",
    "--json-output",
    file,
    "device",
    ...args.slice(0, 2),
    "--device",
    device,
    ...args.slice(2),
  ]);
  return JSON.parse(NodeFS.readFileSync(file, "utf8"));
}

/** Find this exact installed bundle, failing closed when CoreDevice cannot identify it. */
function installedApp(device: string, bundle: string, output: string, label: string) {
  const apps = decodeApps(deviceCommand(device, ["info", "apps"], output, label)).result.apps;
  const app = apps.find((entry) => entry.bundleIdentifier === bundle);
  if (!app || !app.url.startsWith("file://"))
    throw new Error(`Existing app not found on ${device}`);
  return app;
}

/** Parse explicit inputs; repeated device flags are the only multi-valued option. */
function options(args: string[]) {
  const values = new Map<string, string>();
  const devices: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (
      !value ||
      !["--app", "--previous-app", "--source-revision", "--device", "--output"].includes(key)
    )
      throw new Error(
        "Expected --app, --previous-app, --source-revision, --device (repeatable), --output",
      );
    if (key === "--device") devices.push(value);
    else if (values.has(key)) throw new Error(`Duplicate option ${key}`);
    else values.set(key, value);
  }
  const app = values.get("--app"),
    previous = values.get("--previous-app"),
    revision = values.get("--source-revision"),
    output = values.get("--output");
  if (
    !app ||
    !previous ||
    !output ||
    !revision ||
    !/^[a-f0-9]{40}$/i.test(revision) ||
    !devices.length ||
    new Set(devices).size !== devices.length ||
    devices.some((device) => !/^[a-f0-9-]+$/i.test(device))
  )
    throw new Error("Missing or invalid deployment inputs");
  return {
    app: NodePath.resolve(app),
    previous: NodePath.resolve(previous),
    output: NodePath.resolve(output),
    revision,
    devices,
  };
}

/** Validate the whole deployment first, then install and verify each target independently. */
function main(args: string[]): void {
  const input = options(args);
  NodeFS.mkdirSync(input.output, { recursive: true });
  const receiptPath = NodePath.join(input.output, "deployment.json");
  if (NodeFS.existsSync(receiptPath))
    throw new Error("Output already has a deployment receipt; choose a fresh directory");
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ios-preflight-"));
  const devices = input.devices.map((device) => ({
    device,
    installed: false,
    launched: false,
    verified: false,
    error: undefined as string | undefined,
    processIdentifier: undefined as number | undefined,
  }));
  const receipt: Record<string, unknown> = {
    sourceRevision: input.revision,
    createdAt: new Date().toISOString(),
    devices,
  };
  /** Persist progress before and after each device operation. */
  const save = () => NodeFS.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  save();
  try {
    const stagedApp = NodePath.join(scratch, NodePath.basename(input.app));
    run("ditto", [input.app, stagedApp]);
    const current = inspectApp(stagedApp, scratch, "current");
    const previous = inspectApp(input.previous, scratch, "previous");
    validateIdentity(
      current.identity,
      previous.identity,
      current.info.CFBundleIdentifier,
      previous.info.CFBundleIdentifier,
    );
    const jsBytes = NodeFS.statSync(NodePath.join(stagedApp, "main.jsbundle")).size;
    const updates = plist(NodePath.join(stagedApp, "Expo.plist"), decodeUpdates);
    validateRelease(
      current.info,
      run("lipo", ["-archs", NodePath.join(stagedApp, current.info.CFBundleExecutable)]),
      jsBytes,
      updates.EXUpdatesEnabled,
    );
    const profileFile = NodePath.join(scratch, "profile.plist");
    NodeFS.writeFileSync(
      profileFile,
      run("security", ["cms", "-D", "-i", NodePath.join(stagedApp, "embedded.mobileprovision")]),
    );
    // Full profiles contain dates and certificate data that plutil cannot encode as JSON.
    const profile = decodeProfile({
      ExpirationDate: run("plutil", ["-extract", "ExpirationDate", "raw", "-o", "-", profileFile]),
      TeamIdentifier: decodeStrings(
        run("plutil", ["-extract", "TeamIdentifier", "json", "-o", "-", profileFile]),
      ),
      ProvisionedDevices: decodeStrings(
        run("plutil", ["-extract", "ProvisionedDevices", "json", "-o", "-", profileFile]),
      ),
      Entitlements: decodeProfileEntitlements(
        run("plutil", ["-extract", "Entitlements", "json", "-o", "-", profileFile]),
      ),
    });
    const certificatePrefix = NodePath.join(scratch, "certificate-");
    run("codesign", ["--display", `--extract-certificates=${certificatePrefix}`, stagedApp]);
    const certificateExpiry = run("openssl", [
      "x509",
      "-inform",
      "DER",
      "-in",
      `${certificatePrefix}0`,
      "-noout",
      "-enddate",
    ]).replace(/^notAfter=/, "");
    validateProvisioning(profile, current.identity, input.devices, certificateExpiry);
    for (const device of devices)
      validateBuildNumber(
        current.info.CFBundleVersion,
        installedApp(device.device, current.info.CFBundleIdentifier, input.output, "before-apps")
          .bundleVersion,
      );
    const artifact = NodePath.join(input.output, `${NodePath.basename(input.app)}.zip`);
    if (NodeFS.existsSync(artifact)) throw new Error("Output artifact already exists");
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", stagedApp, artifact]);
    receipt.artifact = {
      filename: NodePath.basename(artifact),
      sha256: hashFile(artifact),
    };
    receipt.app = {
      ...current.info,
      ...current.identity,
      javascriptBytes: jsBytes,
      profileExpiry: profile.ExpirationDate,
      certificateExpiry,
    };
    receipt.xcode = run("xcodebuild", ["-version"]);
    receipt.preflight = "passed";
    save();
    for (const device of devices) {
      try {
        deviceCommand(device.device, ["install", "app", stagedApp], input.output, "install");
        device.installed = true;
        save();
        const installed = installedApp(
          device.device,
          current.info.CFBundleIdentifier,
          input.output,
          "after-apps",
        );
        if (
          installed.bundleVersion !== current.info.CFBundleVersion ||
          installed.version !== current.info.CFBundleShortVersionString
        )
          throw new Error("Installed app version mismatch");
        deviceCommand(
          device.device,
          ["process", "launch", current.info.CFBundleIdentifier],
          input.output,
          "launch",
        );
        device.launched = true;
        save();
        const expected = new globalThis.URL(
          current.info.CFBundleExecutable,
          installed.url.endsWith("/") ? installed.url : `${installed.url}/`,
        ).href;
        const processes = decodeProcesses(
          deviceCommand(device.device, ["info", "processes"], input.output, "processes"),
        ).result.runningProcesses;
        const running = processes.find(
          (entry) => entry.executable === expected && entry.processIdentifier > 0,
        );
        if (!running) throw new Error("Installed app process not observed");
        device.processIdentifier = running.processIdentifier;
        device.verified = true;
      } catch (error) {
        device.error = error instanceof Error ? error.message : String(error);
      }
      save();
    }
    if (devices.some((device) => !device.verified)) process.exitCode = 1;
    console.log(`Deployment receipt: ${receiptPath}`);
  } catch (error) {
    receipt.preflight = "failed";
    receipt.error = error instanceof Error ? error.message : String(error);
    save();
    throw error;
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
