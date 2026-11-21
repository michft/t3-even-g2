// Must stay first: the render counter and behavior probe wrap the DevTools hook before any React commit.
import "./src/features/development/render-counter-entry";
import "./src/features/development/behavior-probe-entry";
// Crash reporting loads preferences, which can load GT and capture Hermes's Intl constructors.
import "./src/i18n/intl-polyfills";
// Record errors thrown while the rest of the app loads.
import "./src/features/observability/observe";
import { registerRootComponent, requireOptionalNativeModule } from "expo";
import "react-native-gesture-handler";
import { LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

/** Select the isolated root before normal App imports can open saved connections. */
function nativeConnectionSmokeEnabled(): boolean {
  try {
    return (
      requireOptionalNativeModule<{
        getNativeConnectionSmokeEnabled?: () => boolean;
      }>("T3NativeControls")?.getNativeConnectionSmokeEnabled?.() === true
    );
  } catch {
    return false;
  }
}

// Enables iOS FormSheet sizing for nested native stacks in non-fitToContents sheets.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

const App: typeof import("./src/App").default = nativeConnectionSmokeEnabled()
  ? require("./src/features/development/native-connection-smoke").default
  : require("./src/App").default;

registerRootComponent(App);
