import { expect, it } from "vite-plus/test";

import { nativeSmokeConfigFailure, parseNativeSmokeConfig } from "./native-connection-smoke-config";

const target = {
  name: "local_server-1",
  environmentId: "environment-1",
  httpBaseUrl: "http://localhost:3000",
  bearerToken: "private-token",
};

it("accepts private config without adding credentials to results", () => {
  const parsed = parseNativeSmokeConfig(JSON.stringify({ runId: "run-1", targets: [target] }));
  expect(parsed.config?.targets).toEqual([target]);
  expect(nativeSmokeConfigFailure(parsed.runId)).toEqual({
    runId: "run-1",
    status: "failed",
    targets: [{ name: "configuration", status: "failed", stage: "config", schemaRejected: true }],
  });
});

it.each([
  { runId: "run-1", targets: [] },
  { runId: "run-1", targets: [{ ...target, name: "unsafe/token" }] },
  { runId: "run-1", targets: [{ ...target, name: "x".repeat(49) }] },
  { runId: "run-1", targets: [{ ...target, environmentId: "" }] },
  { runId: "run-1", targets: [{ ...target, bearerToken: " " }] },
])("rejects malformed config while preserving safe correlation: %j", (value) => {
  expect(parseNativeSmokeConfig(JSON.stringify(value))).toEqual({ config: null, runId: "run-1" });
});

it.each(["private-token/unsafe", "", "x".repeat(97)])("rejects unsafe run ID: %s", (runId) => {
  const parsed = parseNativeSmokeConfig(JSON.stringify({ runId, targets: [target] }));
  expect(parsed).toEqual({ config: null, runId: "invalid-config" });
});

it("sanitizes malformed private JSON", () => {
  const parsed = parseNativeSmokeConfig('{"bearerToken":"private-token');
  expect(parsed).toEqual({ config: null, runId: "invalid-config" });
  expect(JSON.stringify(nativeSmokeConfigFailure(parsed.runId))).not.toContain("private-token");
});
