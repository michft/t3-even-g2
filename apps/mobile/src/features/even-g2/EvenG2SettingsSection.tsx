import { useEffect } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  connectEvenG2,
  disconnectEvenG2,
  ensureEvenG2AutoConnect,
  setEvenG2AutoConnect,
  useEvenG2Status,
} from "./evenG2Native";

const statusLabels = {
  disconnected: "Not connected",
  scanning: "Scanning",
  connecting: "Connecting",
  starting: "Starting",
  ready: "Connected",
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
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {status.detail ||
          "Quit the Even app first. In a thread, tap R1 once to start or send; double-tap to cancel."}
      </Text>
    </View>
  );
}
