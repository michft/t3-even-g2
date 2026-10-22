// Must stay first: the render counter wraps the DevTools hook before any React commit.
import "./src/features/development/render-counter-entry";
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

// Required for react-native-screens' iOS FormSheet sizing fix when a nested
// native stack is rendered inside a non-fitToContents formSheet.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

const App: typeof import("./src/App").default = nativeConnectionSmokeEnabled()
  ? require("./src/features/development/native-connection-smoke").default
  : require("./src/App").default;

registerRootComponent(App);
