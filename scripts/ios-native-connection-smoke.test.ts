// @effect-diagnostics nodeBuiltinImport:off - Host-only fixture verifies private file modes and cleanup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

import {
  parseOptions,
  runIosNativeConnectionSmoke,
  validateNativeSmokeResult,
} from "./ios-native-connection-smoke.ts";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFS>()),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
}));

const runId = "b501566b-a2a0-493b-9274-a99c7931f07e";
const names = ["local", "remote"];
const passed = {
  runId,
  status: "passed",
  targets: names.map((name) => ({ name, status: "passed" })),
};
const privateValue = "private-bearer-and-permissions-never-print";

/** Simulate CoreDevice transfers against real private host files without starting a process. */
function fixture(
  response: (currentRunId: string, read: number) => unknown = (currentRunId) => ({
    ...passed,
    runId: currentRunId,
  }),
  failAt?: "copy" | "launch" | "result" | "restore",
) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-smoke-test-"));
  const config = NodePath.join(directory, "config.json");
  const output = NodePath.join(directory, "receipt.json");
  NodeFS.writeFileSync(
    config,
    JSON.stringify({
      targets: names.map((name) => ({
        name,
        environmentId: `environment-${name}`,
        httpBaseUrl: `https://${name}.example.test`,
        bearerTokenEnv: `T3CODE_SMOKE_TOKEN_${name.toUpperCase()}`,
      })),
    }),
    { mode: 0o600 },
  );
  const commands: string[][] = [];
  const transferredInputs: unknown[] = [];
  let currentRunId = "";
  let scratch = "";
  let reads = 0;
  let inputMode = 0;
  const options = { device: "test-udid", bundle: "test.existing.bundle", output };
  const environment = {
    T3CODE_SMOKE_CONFIG: config,
    T3CODE_SMOKE_TOKEN_LOCAL: privateValue,
    T3CODE_SMOKE_TOKEN_REMOTE: privateValue,
  };
  const run = async (args: readonly string[]) => {
    commands.push([...args]);
    const source = args[args.indexOf("--source") + 1]!;
    const destination = args[args.indexOf("--destination") + 1]!;
    if (args.includes("copy") && args.includes("to")) {
      const input = JSON.parse(NodeFS.readFileSync(source, "utf8"));
      transferredInputs.push(input);
      currentRunId = input.runId;
      scratch = NodePath.dirname(source);
      inputMode = NodeFS.statSync(source).mode & 0o777;
      if (failAt === "copy") throw new Error(privateValue);
    } else if (args.includes("copy")) {
      reads++;
      if (failAt === "result") throw new Error(privateValue);
      const value = response(currentRunId, reads);
      NodeFS.writeFileSync(destination, typeof value === "string" ? value : JSON.stringify(value));
    } else {
      const launchEnvironment = JSON.parse(args[args.indexOf("--environment-variables") + 1]!);
      if (Object.keys(launchEnvironment).length === 0)
        throw new Error("CoreDevice rejects empty environment dictionaries.");
      const smoke = launchEnvironment.T3CODE_NATIVE_SMOKE === "1";
      if ((smoke && failAt === "launch") || (!smoke && failAt === "restore"))
        throw new Error(privateValue);
    }
  };
  return {
    options,
    environment,
    commands,
    transferredInputs,
    get scratch() {
      return scratch;
    },
    get reads() {
      return reads;
    },
    get inputMode() {
      return inputMode;
    },
    dependencies: { run, pause: async () => {}, maxAttempts: 2 },
    receipt: () => JSON.parse(NodeFS.readFileSync(output, "utf8")),
    [Symbol.dispose]: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
  };
}

it("ignores a stale prior result before inspecting its payload", () => {
  expect(
    validateNativeSmokeResult({ runId: "old-run", permissions: privateValue }, runId, names),
  ).toBeNull();
});

it.each([
  { ...passed, targets: passed.targets.slice(0, 1) },
  { ...passed, targets: [passed.targets[0], passed.targets[0]] },
  { ...passed, targets: [...passed.targets, { name: "unknown", status: "passed" }] },
  { ...passed, targets: [{ name: "unknown", status: "passed" }, passed.targets[1]] },
  { ...passed, status: "failed" },
  { ...passed, targets: [{ name: "local", status: "failed" }, passed.targets[1]] },
  {
    ...passed,
    targets: [{ name: "local", status: "passed", stage: privateValue }, passed.targets[1]],
  },
  { runId, status: "passed", targets: privateValue },
])("rejects missing, duplicate, foreign or inconsistent target evidence %#", (value) => {
  expect(() => validateNativeSmokeResult(value, runId, names)).toThrow(
    "Native smoke result is malformed.",
  );
});

it("retains failed-stage evidence while stripping all unknown private fields", () => {
  const value = {
    runId,
    status: "failed",
    permissions: privateValue,
    targets: [
      { name: "remote", status: "passed", token: privateValue },
      {
        name: "local",
        status: "failed",
        stage: "config",
        schemaRejected: true,
        error: privateValue,
      },
    ],
  };
  expect(validateNativeSmokeResult(value, runId, names)).toEqual({
    runId,
    status: "failed",
    targets: [
      { name: "remote", status: "passed" },
      { name: "local", status: "failed", stage: "config", schemaRejected: true },
    ],
  });
});

it("waits past stale evidence, transfers credentials privately, restores normal app and removes temp", async () => {
  using test = fixture((currentRunId, read) => ({
    ...passed,
    runId: read === 1 ? "stale" : currentRunId,
    permissions: privateValue,
  }));
  const receipt = await runIosNativeConnectionSmoke(
    test.options,
    test.environment,
    test.dependencies,
  );
  expect(test.reads).toBe(2);
  expect(receipt.status).toBe("passed");
  expect(test.receipt()).toEqual(receipt);
  expect(JSON.stringify(receipt)).not.toContain(privateValue);
  expect(JSON.stringify(test.commands)).not.toContain(privateValue);
  expect(test.transferredInputs).toEqual([
    {
      runId: receipt.runId,
      targets: names.map((name) => ({
        name,
        environmentId: `environment-${name}`,
        httpBaseUrl: `https://${name}.example.test`,
        bearerToken: privateValue,
      })),
    },
  ]);
  expect(test.inputMode).toBe(0o600);
  expect(NodeFS.statSync(test.options.output).mode & 0o777).toBe(0o600);
  expect(NodeFS.existsSync(test.scratch)).toBe(false);
  expect(test.commands.at(-1)?.slice(-4)).toEqual([
    "--terminate-existing",
    "--environment-variables",
    '{"T3CODE_NATIVE_SMOKE":"0"}',
    test.options.bundle,
  ]);
});

it("stops immediately on a matching native failure and keeps its sanitized receipt", async () => {
  using test = fixture((currentRunId) => ({
    ...passed,
    runId: currentRunId,
    status: "failed",
    targets: [
      { name: "local", status: "failed", stage: "permissions", permissions: privateValue },
      { name: "remote", status: "passed" },
    ],
  }));
  await expect(
    runIosNativeConnectionSmoke(test.options, test.environment, test.dependencies),
  ).rejects.toThrow("Native connection smoke failed at native.");
  expect(test.reads).toBe(1);
  expect(test.receipt().targets[0]).toEqual({
    name: "local",
    status: "failed",
    stage: "permissions",
  });
  expect(JSON.stringify(test.receipt())).not.toContain(privateValue);
  expect(NodeFS.existsSync(test.scratch)).toBe(false);
  expect(test.commands.at(-1)).toContain('{"T3CODE_NATIVE_SMOKE":"0"}');
});

it.each(["copy", "launch", "result", "restore"] as const)(
  "redacts %s errors, scrubs unconsumed credentials and attempts normal restore",
  async (failAt) => {
    using test = fixture(undefined, failAt);
    await expect(
      runIosNativeConnectionSmoke(test.options, test.environment, test.dependencies),
    ).rejects.toThrow(`Native connection smoke failed at ${failAt}.`);
    expect(test.receipt().hostStage).toBe(failAt);
    expect(JSON.stringify(test.receipt())).not.toContain(privateValue);
    expect(JSON.stringify(test.commands)).not.toContain(privateValue);
    expect(NodeFS.existsSync(test.scratch)).toBe(false);
    expect(test.commands.at(-1)).toContain('{"T3CODE_NATIVE_SMOKE":"0"}');
    if (failAt !== "restore") expect(test.transferredInputs.at(-1)).toMatchObject({ targets: [] });
  },
);

/** Exercise simctl discovery/launch with real container files and no simulator or subprocess. */
function simulatorFixture(
  simulator = "iphone-simulator-udid",
  response: (currentRunId: string, read: number) => unknown = (currentRunId) => ({
    ...passed,
    runId: currentRunId,
    permissions: privateValue,
  }),
  failAt?: "container" | "launch" | "restore",
) {
  const host = fixture();
  const container = NodePath.join(NodePath.dirname(host.options.output), "Installed App Data");
  const documents = NodePath.join(container, "Documents");
  NodeFS.mkdirSync(documents, { recursive: true });
  const input = NodePath.join(documents, "t3-native-smoke.json");
  const result = NodePath.join(documents, "t3-native-smoke-result.json");
  const catalog = NodePath.join(documents, "saved-servers.json");
  NodeFS.writeFileSync(catalog, privateValue);
  const commands: { args: readonly string[]; environment: Readonly<Record<string, string>> }[] = [];
  let transferredInput: { runId: string; targets: unknown[] } | undefined;
  let inputMode = 0;
  let publications = 0;
  let inputExistsAtRestore: boolean | undefined;
  /** Publish on explicit fixture milestones instead of waiting for native work. */
  const publish = () => {
    if (!transferredInput) throw new Error("No simulator input.");
    const value = response(transferredInput.runId, ++publications);
    NodeFS.writeFileSync(result, typeof value === "string" ? value : JSON.stringify(value));
  };
  /** Emulate only container lookup and native launch; never run xcrun. */
  const run = async (
    args: readonly string[],
    environment: Readonly<Record<string, string>> = {},
  ) => {
    commands.push({ args: [...args], environment: { ...environment } });
    if (args[1] === "get_app_container") {
      if (failAt === "container") throw new Error(privateValue);
      return `${container}\n`;
    }
    if (environment.SIMCTL_CHILD_T3CODE_NATIVE_SMOKE === "1") {
      transferredInput = JSON.parse(NodeFS.readFileSync(input, "utf8"));
      inputMode = NodeFS.statSync(input).mode & 0o777;
      if (failAt === "launch") throw new Error(privateValue);
      NodeFS.rmSync(input);
      publish();
    } else {
      inputExistsAtRestore = NodeFS.existsSync(input);
      if (failAt === "restore") throw new Error(privateValue);
    }
  };
  return {
    options: { simulator, bundle: host.options.bundle, output: host.options.output },
    environment: host.environment,
    container,
    input,
    result,
    catalog,
    commands,
    get transferredInput() {
      return transferredInput;
    },
    get inputMode() {
      return inputMode;
    },
    get publications() {
      return publications;
    },
    get inputExistsAtRestore() {
      return inputExistsAtRestore;
    },
    dependencies: { run, pause: async () => publish(), maxAttempts: 2 },
    receipt: host.receipt,
    [Symbol.dispose]: () => host[Symbol.dispose](),
  };
}

it.each(["iphone-simulator-udid", "ipad-simulator-udid"])(
  "uses current receipts, private files and explicit nonsecret env on %s",
  async (simulator) => {
    using test = simulatorFixture(simulator, (currentRunId, read) => ({
      ...passed,
      runId: read === 1 ? "stale" : currentRunId,
      permissions: privateValue,
    }));
    const previousSmoke = process.env.SIMCTL_CHILD_T3CODE_NATIVE_SMOKE;
    const receipt = await runIosNativeConnectionSmoke(
      test.options,
      test.environment,
      test.dependencies,
    );
    expect(test.publications).toBe(2);
    expect(receipt).toEqual({ ...passed, runId: receipt.runId });
    expect(test.receipt()).toEqual(receipt);
    expect(test.transferredInput).toEqual({
      runId: receipt.runId,
      targets: names.map((name) => ({
        name,
        environmentId: `environment-${name}`,
        httpBaseUrl: `https://${name}.example.test`,
        bearerToken: privateValue,
      })),
    });
    expect(test.inputMode).toBe(0o600);
    expect(NodeFS.statSync(test.options.output).mode & 0o777).toBe(0o600);
    expect(test.inputExistsAtRestore).toBe(false);
    expect(NodeFS.readFileSync(test.catalog, "utf8")).toBe(privateValue);
    expect(test.commands).toEqual([
      {
        args: ["simctl", "get_app_container", simulator, test.options.bundle, "data"],
        environment: {},
      },
      {
        args: ["simctl", "launch", "--terminate-running-process", simulator, test.options.bundle],
        environment: { SIMCTL_CHILD_T3CODE_NATIVE_SMOKE: "1" },
      },
      {
        args: ["simctl", "launch", "--terminate-running-process", simulator, test.options.bundle],
        environment: { SIMCTL_CHILD_T3CODE_NATIVE_SMOKE: "0" },
      },
    ]);
    expect(JSON.stringify(test.commands)).not.toContain(privateValue);
    expect(JSON.stringify(receipt)).not.toContain(privateValue);
    expect(process.env.SIMCTL_CHILD_T3CODE_NATIVE_SMOKE).toBe(previousSmoke);
  },
);

it("keeps invalid-token native failure evidence and restores the simulator normally", async () => {
  using test = simulatorFixture(undefined, (currentRunId) => ({
    runId: currentRunId,
    status: "failed",
    bearerToken: privateValue,
    targets: [
      { name: "local", status: "failed", stage: "permissions", error: privateValue },
      { name: "remote", status: "passed" },
    ],
  }));
  test.environment.T3CODE_SMOKE_TOKEN_LOCAL = "invalid-token";
  await expect(
    runIosNativeConnectionSmoke(test.options, test.environment, test.dependencies),
  ).rejects.toEqual(new Error("Native connection smoke failed at native."));
  expect(test.publications).toBe(1);
  expect(test.receipt()).toEqual({
    runId: test.transferredInput?.runId,
    status: "failed",
    targets: [
      { name: "local", status: "failed", stage: "permissions" },
      { name: "remote", status: "passed" },
    ],
  });
  expect(test.commands.at(-1)?.environment).toEqual({ SIMCTL_CHILD_T3CODE_NATIVE_SMOKE: "0" });
  expect(test.inputExistsAtRestore).toBe(false);
  expect(JSON.stringify(test.commands)).not.toContain("invalid-token");
  expect(JSON.stringify(test.receipt())).not.toContain(privateValue);
});

it.each(["container", "launch", "restore"] as const)(
  "sanitizes simulator %s errors, deletes unconsumed input and attempts restore",
  async (failAt) => {
    using test = simulatorFixture(undefined, undefined, failAt);
    const stage = failAt === "container" ? "copy" : failAt;
    await expect(
      runIosNativeConnectionSmoke(test.options, test.environment, test.dependencies),
    ).rejects.toEqual(new Error(`Native connection smoke failed at ${stage}.`));
    expect(test.receipt().hostStage).toBe(stage);
    expect(JSON.stringify(test.receipt())).not.toContain(privateValue);
    expect(JSON.stringify(test.commands)).not.toContain(privateValue);
    expect(test.commands.at(-1)?.environment).toEqual({ SIMCTL_CHILD_T3CODE_NATIVE_SMOKE: "0" });
    expect(test.commands).toHaveLength(failAt === "container" ? 2 : 3);
    expect(test.inputExistsAtRestore).toBe(false);
    expect(NodeFS.existsSync(test.input)).toBe(false);
    expect(NodeFS.readFileSync(test.catalog, "utf8")).toBe(privateValue);
  },
);

it("deletes a partially copied simulator input directly before normal restore", async () => {
  using test = simulatorFixture();
  let scratch = "";
  using _copy = vi.spyOn(NodeFS, "copyFileSync").mockImplementation((source, destination) => {
    scratch = NodePath.dirname(source.toString());
    NodeFS.writeFileSync(destination, privateValue);
    throw new Error(privateValue);
  });
  await expect(
    runIosNativeConnectionSmoke(test.options, test.environment, test.dependencies),
  ).rejects.toEqual(new Error("Native connection smoke failed at copy."));
  expect(test.receipt().hostStage).toBe("copy");
  expect(JSON.stringify(test.receipt())).not.toContain(privateValue);
  expect(JSON.stringify(test.commands)).not.toContain(privateValue);
  expect(test.commands).toHaveLength(2);
  expect(test.commands.at(-1)?.environment).toEqual({ SIMCTL_CHILD_T3CODE_NATIVE_SMOKE: "0" });
  expect(test.inputExistsAtRestore).toBe(false);
  expect(NodeFS.existsSync(test.input)).toBe(false);
  expect(NodeFS.existsSync(scratch)).toBe(false);
  expect(NodeFS.readFileSync(test.catalog, "utf8")).toBe(privateValue);
});

it("passes only host paths and explicit smoke flags through the real command runner", async () => {
  using test = simulatorFixture();
  using exec = vi.spyOn(NodeChildProcess, "execFile").mockImplementation((...args) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("Missing exec callback.");
    callback(new Error(privateValue), privateValue, privateValue);
    return new NodeChildProcess.ChildProcess();
  });
  await expect(runIosNativeConnectionSmoke(test.options, test.environment)).rejects.toEqual(
    new Error("Native connection smoke failed at restore."),
  );
  expect(exec).toHaveBeenCalledTimes(2);
  expect(exec.mock.calls.map((call) => call[1])).toEqual([
    ["simctl", "get_app_container", test.options.simulator, test.options.bundle, "data"],
    [
      "simctl",
      "launch",
      "--terminate-running-process",
      test.options.simulator,
      test.options.bundle,
    ],
  ]);
  const hostEnvironment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    DEVELOPER_DIR: process.env.DEVELOPER_DIR,
  };
  expect(exec.mock.calls.map((call) => call[2])).toEqual([
    { timeout: 15_000, maxBuffer: 1024 * 1024, env: hostEnvironment },
    {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...hostEnvironment, SIMCTL_CHILD_T3CODE_NATIVE_SMOKE: "0" },
    },
  ]);
  expect(JSON.stringify(test.receipt())).not.toContain(privateValue);
});

it.each([undefined, "", "relative/container", "/container\n/private-data", "/container\0"])(
  "rejects unusable simulator container output %# and still restores normally",
  async (container) => {
    using test = simulatorFixture();
    const run = vi.fn(test.dependencies.run).mockResolvedValueOnce(container);
    await expect(
      runIosNativeConnectionSmoke(test.options, test.environment, { ...test.dependencies, run }),
    ).rejects.toEqual(new Error("Native connection smoke failed at copy."));
    expect(test.receipt().hostStage).toBe("copy");
    expect(test.commands).toHaveLength(1);
    expect(test.commands[0]?.environment).toEqual({ SIMCTL_CHILD_T3CODE_NATIVE_SMOKE: "0" });
    expect(NodeFS.existsSync(test.input)).toBe(false);
    expect(NodeFS.readFileSync(test.catalog, "utf8")).toBe(privateValue);
  },
);

it.each(["stale", "malformed"])(
  "rejects %s simulator evidence through the shared validator",
  async (kind) => {
    using test = simulatorFixture(undefined, (currentRunId) =>
      kind === "stale"
        ? { ...passed, runId: "old-run" }
        : { runId: currentRunId, targets: privateValue },
    );
    await expect(
      runIosNativeConnectionSmoke(test.options, test.environment, test.dependencies),
    ).rejects.toEqual(new Error("Native connection smoke failed at result."));
    expect(test.publications).toBe(kind === "stale" ? 2 : 1);
    expect(test.receipt().hostStage).toBe("result");
    expect(JSON.stringify(test.receipt())).not.toContain(privateValue);
    expect(test.commands).toHaveLength(3);
    expect(test.commands.at(-1)?.environment).toEqual({ SIMCTL_CHILD_T3CODE_NATIVE_SMOKE: "0" });
    expect(test.inputExistsAtRestore).toBe(false);
  },
);

it.each(["--device", "--simulator"])("parses explicit %s targeting", (flag) => {
  expect(
    parseOptions([flag, "test-udid", "--bundle", "test.bundle", "--output", "receipt.json"]),
  ).toEqual({
    [flag.slice(2)]: "test-udid",
    bundle: "test.bundle",
    output: "receipt.json",
  });
});

it.each(
  [
    [],
    ["--device", "phone", "--simulator", "tablet"],
    ["--simulator", "phone", "--simulator", "tablet"],
    ["--simulator", "--private-value"],
    ["--unknown", privateValue],
  ].map((target) => ({ target })),
)(
  "rejects missing, conflicting or malformed CLI targets %# without echoing values",
  ({ target }) => {
    expect(() =>
      parseOptions([...target, "--bundle", "test.bundle", "--output", "receipt.json"]),
    ).toThrow(
      "Usage: (--device UDID | --simulator UDID) --bundle EXISTING_ID --output PRIVATE_RECEIPT_PATH",
    );
  },
);

it("fails safely when an old installed build never writes a matching result", async () => {
  using test = fixture(() => ({ ...passed, runId: "old-build-result" }));
  await expect(
    runIosNativeConnectionSmoke(test.options, test.environment, test.dependencies),
  ).rejects.toThrow("Native connection smoke failed at result.");
  expect(test.reads).toBe(2);
  expect(test.transferredInputs.at(-1)).toMatchObject({ targets: [] });
  expect(test.commands.at(-1)).toContain('{"T3CODE_NATIVE_SMOKE":"0"}');
  expect(NodeFS.existsSync(test.scratch)).toBe(false);
});

it("rejects a matching malformed result immediately without leaking its content", async () => {
  using test = fixture((currentRunId) => ({ runId: currentRunId, targets: privateValue }));
  await expect(
    runIosNativeConnectionSmoke(test.options, test.environment, test.dependencies),
  ).rejects.toThrow("Native connection smoke failed at result.");
  expect(test.reads).toBe(1);
  expect(JSON.stringify(test.receipt())).not.toContain(privateValue);
  expect(test.commands.at(-1)).toContain('{"T3CODE_NATIVE_SMOKE":"0"}');
});

it.each(["", '{"runId":', "null", "{}"])(
  "waits past uncorrelated malformed prior receipt %s",
  async (raw) => {
    using test = fixture((currentRunId, read) =>
      read === 1 ? raw : { ...passed, runId: currentRunId },
    );
    const result = await runIosNativeConnectionSmoke(
      test.options,
      test.environment,
      test.dependencies,
    );
    expect(result.status).toBe("passed");
    expect(test.reads).toBe(2);
    expect(test.commands.at(-1)).toContain('{"T3CODE_NATIVE_SMOKE":"0"}');
  },
);
