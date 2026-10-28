import {
  checkServerConnection,
  SmokeFailure,
  validateSmokeOrigin,
} from "@t3tools/client-runtime/connection";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { File, Paths } from "expo-file-system";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  nativeSmokeConfigFailure,
  parseNativeSmokeConfig,
  type NativeSmokeResult,
} from "./native-connection-smoke-config";

const isSmokeFailure = Schema.is(SmokeFailure);

/** Consume credentials before parsing; never import the app's saved connection runtime. */
async function runNativeConnectionSmoke(): Promise<NativeSmokeResult> {
  let runId = "invalid-config";
  let result = nativeSmokeConfigFailure();
  try {
    const input = new File(Paths.document, "t3-native-smoke.json");
    let raw: string;
    try {
      raw = await input.text();
    } finally {
      if (input.exists) input.delete();
    }
    const parsed = parseNativeSmokeConfig(raw);
    runId = parsed.runId;
    if (parsed.config === null) {
      result = nativeSmokeConfigFailure(runId);
    } else {
      const targets = parsed.config.targets.map((target) => ({
        ...target,
        httpBaseUrl: validateSmokeOrigin(target.httpBaseUrl),
      }));
      const layer = Layer.mergeAll(
        layerRemoteHttpClient(fetch),
        Socket.layerWebSocketConstructorGlobal,
        Logger.layer([]),
      );
      const outcomes: NativeSmokeResult["targets"][number][] = [];
      for (const { bearerToken, ...target } of targets) {
        const exit = await Effect.runPromiseExit(
          checkServerConnection(target, bearerToken).pipe(Effect.provide(layer)),
        );
        if (exit._tag === "Success") {
          outcomes.push({ name: target.name, status: "passed" });
        } else {
          const failure = exit.cause.reasons.find(Cause.isFailReason)?.error;
          const knownFailure = isSmokeFailure(failure);
          outcomes.push({
            name: target.name,
            status: "failed",
            stage: knownFailure ? failure.stage : "config",
            schemaRejected: knownFailure ? failure.schemaRejected : false,
          });
        }
      }
      result = {
        runId,
        status: outcomes.every((outcome) => outcome.status === "passed") ? "passed" : "failed",
        targets: outcomes,
      };
    }
  } catch {
    result = nativeSmokeConfigFailure(runId);
  }
  try {
    const output = new File(Paths.document, "t3-native-smoke-result.json");
    const staged = new File(Paths.document, `t3-native-smoke-result-${runId}.tmp`);
    staged.create({ overwrite: true });
    await staged.write(JSON.stringify(result));
    // Publish only a fully written file; the reader tolerates the missing-file gap.
    if (output.exists) output.delete();
    staged.move(output);
    return result;
  } catch {
    // An unwritable result must not appear as a successful on-device test.
    return nativeSmokeConfigFailure(runId);
  }
}

let smokeRun: Promise<NativeSmokeResult> | undefined;

/** Render only safe progress; remounts share the one credential-consuming run. */
export default function NativeConnectionSmoke() {
  const [status, setStatus] = useState("Testing native connections…");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides the native splash and subscribes this screen to the shared smoke run while mounted
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => {});
    if (smokeRun === undefined) smokeRun = runNativeConnectionSmoke();
    let mounted = true;
    void smokeRun.then((result) => {
      if (mounted) setStatus(`Native connection smoke ${result.status}.`);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return (
    <View style={styles.root}>
      <Text accessibilityRole="header">Native connection smoke</Text>
      <Text accessibilityLiveRegion="polite">{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
});
