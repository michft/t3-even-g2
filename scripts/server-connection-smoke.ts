// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Private host-side deployment preflight; never bundles credentials.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";

import {
  checkServerConnection,
  validateSmokeOrigin,
  SmokeFailure,
} from "@t3tools/client-runtime/connection";
export { checkServerConnection, validateSmokeOrigin } from "@t3tools/client-runtime/connection";
const isSmokeFailure = Schema.is(SmokeFailure);

const SmokeTarget = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,48}$/)),
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  httpBaseUrl: Schema.String,
  bearerTokenEnv: Schema.String.check(Schema.isPattern(/^T3CODE_SMOKE_TOKEN_[A-Z0-9_]+$/)),
});
const SmokeConfig = Schema.Struct({ targets: Schema.NonEmptyArray(SmokeTarget) });
const decodeSmokeConfig = Schema.decodeSync(Schema.fromJsonString(SmokeConfig));
export type SmokeTarget = typeof SmokeTarget.Type;

/** Keep malformed private inputs out of exception messages and build logs. */
export function readSmokeConfig(file: string) {
  try {
    const config = decodeSmokeConfig(NodeFS.readFileSync(file, "utf8"));
    return config.targets.map((target) => ({
      ...target,
      httpBaseUrl: validateSmokeOrigin(target.httpBaseUrl),
    }));
  } catch {
    throw new Error("Could not read a valid server smoke configuration.");
  }
}

/** Fail before install when an explicitly required gate has no configured credentials. */
export async function runServerConnectionSmoke(environment: NodeJS.ProcessEnv = process.env) {
  const file = environment.T3CODE_SMOKE_CONFIG;
  if (!file) throw new Error("T3CODE_SMOKE_CONFIG must name a private smoke configuration.");
  const targets = readSmokeConfig(file);
  const layer = Layer.mergeAll(
    layerRemoteHttpClient(globalThis.fetch),
    Socket.layerWebSocketConstructorGlobal,
    Logger.layer([]),
  );
  for (const target of targets) {
    const token = environment[target.bearerTokenEnv];
    if (!token?.trim()) throw new Error(`Smoke credential missing for ${target.name}.`);
    const result = await Effect.runPromiseExit(
      checkServerConnection(target, token).pipe(Effect.provide(layer)),
    );
    if (result._tag === "Failure") {
      const failure = result.cause.reasons.find(Cause.isFailReason)?.error;
      const stage = isSmokeFailure(failure) ? failure.stage : "connection";
      const hint =
        isSmokeFailure(failure) && failure.schemaRejected ? " (configuration schema rejected)" : "";
      throw new Error(`Server smoke failed for ${target.name} at ${stage}${hint}.`);
    }
  }
  return { status: "passed" as const, targets: targets.map((target) => target.name) };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    const result = await runServerConnectionSmoke();
    console.log(`Server connection smoke passed: ${result.targets.join(", ")}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Server connection smoke failed.");
    process.exitCode = 1;
  }
}
