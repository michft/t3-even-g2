// @effect-diagnostics nodeBuiltinImport:off - Host-only fixture verifies private file modes and cleanup.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import {
  runIosNativeConnectionSmoke,
  validateNativeSmokeResult,
} from "./ios-native-connection-smoke.ts";

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
