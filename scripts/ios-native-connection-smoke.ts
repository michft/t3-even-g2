// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Private standalone host CLI; never bundles or logs credentials.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTimersPromises from "node:timers/promises";
import * as Schema from "effect/Schema";

import { readSmokeConfig } from "./server-connection-smoke.ts";

const inputPath = "Documents/t3-native-smoke.json";
const resultPath = "Documents/t3-native-smoke-result.json";
const status = Schema.Literals(["passed", "failed"]);
const NativeResult = Schema.Struct({
  runId: Schema.String,
  status,
  targets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status,
      stage: Schema.optionalKey(
        Schema.Literals(["input", "descriptor", "permissions", "ticket", "config", "connection"]),
      ),
      schemaRejected: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const decodeResult = Schema.decodeUnknownSync(NativeResult);
type NativeResult = typeof NativeResult.Type;
type HostStage = "input" | "copy" | "launch" | "result" | "restore" | "receipt";
type Receipt = NativeResult & { hostStage?: HostStage };
type Options = { bundle: string; output: string } & (
  | { device: string; simulator?: never }
  | { simulator: string; device?: never }
);
type CommandRunner = (
  args: readonly string[],
  environment?: Readonly<Record<string, string>>,
) => Promise<string | void>;

/** Ignore earlier runs; accept exactly the configured targets and emit only safe fields. */
export function validateNativeSmokeResult(
  value: unknown,
  runId: string,
  names: readonly string[],
): NativeResult | null {
  try {
    if (typeof value !== "object" || value === null || !("runId" in value) || value.runId !== runId)
      return null;
    const result = decodeResult(value);
    const actualNames = result.targets.map((target) => target.name);
    if (
      new Set(names).size !== names.length ||
      actualNames.length !== names.length ||
      new Set(actualNames).size !== names.length ||
      !actualNames.every((name) => names.includes(name)) ||
      (result.status === "passed") !== result.targets.every((target) => target.status === "passed")
    )
      throw new Error();
    return {
      runId,
      status: result.status,
      targets: result.targets.map(({ name, status, stage, schemaRejected }) => ({
        name,
        status,
        ...(stage === undefined ? {} : { stage }),
        ...(schemaRejected === undefined ? {} : { schemaRejected }),
      })),
    };
  } catch {
    throw new Error("Native smoke result is malformed.");
  }
}

/** Capture stdout for container discovery; never expose tool errors or inherit private inputs. */
async function runCommand(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      "xcrun",
      [...args],
      {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          DEVELOPER_DIR: process.env.DEVELOPER_DIR,
          ...environment,
        },
      },
      (error, stdout) =>
        error ? reject(new Error("Native smoke device command failed.")) : resolve(stdout),
    );
  });
}

/** Refuse symlink outputs and restrict existing as well as newly created files before writing. */
function writePrivateJson(file: string, value: unknown): void {
  const fd = NodeFS.openSync(
    file,
    NodeFS.constants.O_WRONLY |
      NodeFS.constants.O_CREAT |
      NodeFS.constants.O_TRUNC |
      NodeFS.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    NodeFS.fchmodSync(fd, 0o600);
    NodeFS.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    NodeFS.closeSync(fd);
  }
}

/** Run the installed app's isolated smoke entry, then restore its normal launch on every outcome. */
export async function runIosNativeConnectionSmoke(
  options: Options,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    run?: CommandRunner;
    pause?: () => Promise<void>;
    maxAttempts?: number;
  } = {},
): Promise<Receipt> {
  const run = dependencies.run ?? runCommand;
  const pause = dependencies.pause ?? (() => NodeTimersPromises.setTimeout(1000));
  const runId = NodeCrypto.randomUUID();
  let stage: HostStage = "input";
  let receipt: Receipt = { runId, status: "failed", targets: [] };
  let failed = false;
  let scratch: string | undefined;
  let inputCopied = false;
  let consumed = false;
  let container: string | undefined;
  const command = (args: string[]) =>
    run(["devicectl", "--timeout", "10", "--quiet", "device", ...args]);
  const copy = async (direction: "to" | "from", source: string, destination: string) => {
    if (options.simulator !== undefined) {
      if (!container) throw new Error();
      const file = NodePath.join(container, direction === "to" ? inputPath : resultPath);
      if (direction === "to") {
        // Replace only the known input; exclusive creation refuses a symlink left at that path.
        NodeFS.rmSync(file, { force: true });
        NodeFS.copyFileSync(source, file, NodeFS.constants.COPYFILE_EXCL);
        NodeFS.chmodSync(file, 0o600);
      } else {
        NodeFS.copyFileSync(file, destination);
      }
      return;
    }
    await command([
      "copy",
      direction,
      "--device",
      options.device,
      "--domain-type",
      "appDataContainer",
      "--domain-identifier",
      options.bundle,
      "--source",
      source,
      "--destination",
      destination,
    ]);
  };
  const launch = (smoke: boolean) =>
    options.simulator !== undefined
      ? run(
          ["simctl", "launch", "--terminate-running-process", options.simulator, options.bundle],
          {
            SIMCTL_CHILD_T3CODE_NATIVE_SMOKE: smoke ? "1" : "0",
          },
        )
      : command([
          "process",
          "launch",
          "--device",
          options.device,
          "--terminate-existing",
          "--environment-variables",
          // CoreDevice rejects an empty environment dictionary; explicitly disable the hook on restore.
          JSON.stringify({ T3CODE_NATIVE_SMOKE: smoke ? "1" : "0" }),
          options.bundle,
        ]);
  try {
    if (!environment.T3CODE_SMOKE_CONFIG) throw new Error();
    const targets = readSmokeConfig(environment.T3CODE_SMOKE_CONFIG).map((target) => {
      const bearerToken = environment[target.bearerTokenEnv];
      if (!bearerToken?.trim()) throw new Error();
      return {
        name: target.name,
        environmentId: target.environmentId,
        httpBaseUrl: target.httpBaseUrl,
        bearerToken,
      };
    });
    const names = targets.map((target) => target.name);
    if (new Set(names).size !== names.length) throw new Error();
    scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-smoke-"));
    const input = NodePath.join(scratch, "input.json");
    const result = NodePath.join(scratch, "result.json");
    writePrivateJson(input, { runId, targets });
    stage = "copy";
    if (options.simulator !== undefined) {
      const discovered = await run([
        "simctl",
        "get_app_container",
        options.simulator,
        options.bundle,
        "data",
      ]);
      container = discovered?.trim();
      if (!container || !NodePath.isAbsolute(container) || /[\0\r\n]/.test(container))
        throw new Error();
    }
    // A failed transfer may still have written credentials, so clean up attempted copies too.
    inputCopied = true;
    await copy("to", input, inputPath);
    stage = "launch";
    await launch(true);
    stage = "result";
    const deadline = Date.now() + 120_000;
    for (let attempt = 0; attempt < (dependencies.maxAttempts ?? 120); attempt++) {
      NodeFS.rmSync(result, { force: true });
      let copied = false;
      try {
        await copy("from", resultPath, result);
        copied = true;
      } catch {
        // Missing files are expected until the native entry finishes; never expose tool errors.
      }
      if (copied) {
        if (NodeFS.statSync(result).size > 64 * 1024) throw new Error();
        let value: unknown;
        try {
          value = JSON.parse(NodeFS.readFileSync(result, "utf8"));
        } catch {
          // An interrupted prior publisher may leave uncorrelated partial JSON.
          value = null;
        }
        const validated = validateNativeSmokeResult(value, runId, names);
        if (validated) {
          consumed = true;
          receipt = validated;
          failed = validated.status === "failed";
          break;
        }
      }
      if (Date.now() >= deadline || attempt + 1 === (dependencies.maxAttempts ?? 120))
        throw new Error();
      await pause();
    }
    if (!consumed) throw new Error();
  } catch {
    receipt = { runId, status: "failed", targets: [], hostStage: stage };
    failed = true;
  } finally {
    if (inputCopied && scratch && (options.simulator !== undefined || !consumed)) {
      try {
        if (options.simulator !== undefined && container) {
          NodeFS.rmSync(NodePath.join(container, inputPath), { force: true });
        } else {
          // CoreDevice exposes no file deletion. Scrub this exact file, then ask the hook to consume it.
          const emptyInput = NodePath.join(scratch, "empty.json");
          writePrivateJson(emptyInput, { runId, targets: [] });
          await copy("to", emptyInput, inputPath);
          await launch(true);
        }
      } catch {
        // Best effort only; the normal launch must still be attempted.
      }
    }
    try {
      await launch(false);
    } catch {
      receipt = { ...receipt, status: "failed", hostStage: "restore" };
      failed = true;
    } finally {
      if (scratch) NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  }
  try {
    writePrivateJson(options.output, receipt);
  } catch {
    throw new Error("Native connection smoke failed at receipt.");
  }
  if (failed)
    throw new Error(`Native connection smoke failed at ${receipt.hostStage ?? "native"}.`);
  return receipt;
}

/** Keep malformed command-line values out of parse failures. */
export function parseOptions(args: string[]): Options {
  const usage =
    "Usage: (--device UDID | --simulator UDID) --bundle EXISTING_ID --output PRIVATE_RECEIPT_PATH";
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key ||
      !["--device", "--simulator", "--bundle", "--output"].includes(key) ||
      !value ||
      values.has(key)
    )
      throw new Error(usage);
    values.set(key, value);
  }
  const device = values.get("--device");
  const simulator = values.get("--simulator");
  const bundle = values.get("--bundle");
  const output = values.get("--output");
  if (
    Boolean(device) === Boolean(simulator) ||
    !bundle ||
    !output ||
    (device ?? simulator)?.startsWith("-") ||
    bundle.startsWith("-")
  )
    throw new Error(usage);
  return simulator ? { simulator, bundle, output } : { device: device!, bundle, output };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    await runIosNativeConnectionSmoke(parseOptions(process.argv.slice(2)));
    console.log("Native connection smoke passed.");
  } catch {
    console.error("Native connection smoke failed; inspect the sanitized private receipt.");
    process.exitCode = 1;
  }
}
