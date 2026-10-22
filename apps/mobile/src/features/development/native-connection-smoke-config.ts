import * as Schema from "effect/Schema";

const SafeRunId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,96}$/));
const NativeSmokeConfig = Schema.Struct({
  runId: SafeRunId,
  targets: Schema.NonEmptyArray(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,48}$/)),
      environmentId: Schema.String.check(Schema.isPattern(/\S/)),
      httpBaseUrl: Schema.String,
      bearerToken: Schema.String.check(Schema.isPattern(/\S/)),
    }),
  ),
});
const isSafeRunId = Schema.is(SafeRunId);
const decodeNativeSmokeConfig = Schema.decodeUnknownSync(NativeSmokeConfig);

export interface NativeSmokeResult {
  readonly runId: string;
  readonly status: "passed" | "failed";
  readonly targets: ReadonlyArray<{
    readonly name: string;
    readonly status: "passed" | "failed";
    readonly stage?: "descriptor" | "permissions" | "ticket" | "config";
    readonly schemaRejected?: boolean;
  }>;
}

/** Persist only a fixed failure plus an already-validated correlation ID. */
export function nativeSmokeConfigFailure(runId = "invalid-config"): NativeSmokeResult {
  return {
    runId,
    status: "failed",
    targets: [{ name: "configuration", status: "failed", stage: "config", schemaRejected: true }],
  };
}

/** Preserve safe correlation IDs even when other private config fields are malformed. */
export function parseNativeSmokeConfig(raw: string) {
  let runId = "invalid-config";
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && "runId" in value) {
      if (isSafeRunId(value.runId)) runId = value.runId;
    }
    return { config: decodeNativeSmokeConfig(value), runId };
  } catch {
    return { config: null, runId };
  }
}
