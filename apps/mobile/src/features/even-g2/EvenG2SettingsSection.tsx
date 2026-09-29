import { useEffect } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  connectEvenG2,
  disconnectEvenG2,
  ensureEvenG2AutoConnect,
  resumeEvenG2Display,
  setEvenG2AutoConnect,
  setEvenG2NaturalScrolling,
  useEvenG2Status,
} from "./evenG2Native";

const statusLabels = {
  disconnected: "Not connected",
  scanning: "Scanning",
  connecting: "Connecting",
  starting: "Starting",
  ready: "Connected",
  paused: "Display paused",
  error: "Retry",
  unsupported: "Unavailable",
} as const;

export function EvenG2SettingsSection() {
  const status = useEvenG2Status();

  useEffect(() => {
    ensureEvenG2AutoConnect();
  }, []);

  if (Platform.OS !== "ios") {
    return null;
  }

  const active = status.connected || ["scanning", "connecting", "starting"].includes(status.status);
  const toggleConnection = () => {
    if (active) {
      setEvenG2AutoConnect(false);
      disconnectEvenG2();
      return;
    }
    setEvenG2AutoConnect(true);
    connectEvenG2();
  };

  return (
    <View className="gap-3">
      <SettingsSection title="Even G2">
        <SettingsRow
          icon="eye"
          label="G2 + R1"
          value={statusLabels[status.status]}
          disabled={status.status === "unsupported"}
          onPress={toggleConnection}
        />
        {status.status === "paused" && (
          <SettingsRow icon="eye" label="Resume T3 display" onPress={resumeEvenG2Display} />
        )}
        <SettingsSwitchRow
          icon="eye"
          label="Natural scrolling"
          subtitle="On: swipe up advances through content. Off: swipe down advances. Quickly swipe up then down to go back."
          value={status.naturalScrolling}
          disabled={status.status === "unsupported"}
          onValueChange={setEvenG2NaturalScrolling}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {status.detail ||
          "Quit the Even app first. Tap to open a thread, dictate, or send. Quickly swipe up then down to cancel or go back. A lone up swipe scrolls after a short pause. Hold also works if supported by your glasses."}
      </Text>
    </View>
  );
}
