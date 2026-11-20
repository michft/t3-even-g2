import { msg } from "gt-react-native";
import { m, type MessageResolver } from "../../i18n/messages";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";

import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

function sfSymbolIcon(name: string): NativeHeaderIcon {
  return { type: "sfSymbol", name: name as never };
}

export function createSidebarHeaderItems(
  input: {
    readonly onOpenSettings: () => void;
  },
  resolve: MessageResolver = m,
): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      type: "button",
      axisBehavior: "horizontalOnly",
      label: resolve(msg("Settings")),
      accessibilityLabel: resolve(msg("Open settings")),
      icon: sfSymbolIcon("gearshape"),
      onPress: input.onOpenSettings,
    }),
  ];
}
