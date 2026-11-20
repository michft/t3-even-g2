import { useGT, useMessages } from "gt-react-native";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { THREAD_HIGHLIGHT_COLORS } from "../../lib/threadHighlight";
import { useRepositoryHighlight } from "./use-repository-highlight";

/** Choose the colour for every thread in this repository on this device. */
export function RepositoryColorSetting(props: { readonly repositoryKey: string }) {
  const gt = useGT();
  const m = useMessages();
  const highlight = useRepositoryHighlight(props.repositoryKey);
  const label =
    highlight.override === undefined
      ? gt("Automatic")
      : highlight.override === "none"
        ? gt("None")
        : m(
            THREAD_HIGHLIGHT_COLORS.find(({ color }) => color === highlight.override?.toLowerCase())
              ?.title ?? highlight.override,
          );
  return (
    <View className="mx-4 mt-4 overflow-hidden rounded-2xl bg-grouped-card">
      <Menu
        actions={highlight.actions}
        onPressAction={({ nativeEvent }) => highlight.handleAction(nativeEvent.event)}
      >
        <RowPressable
          disabled={!highlight.loaded}
          accessibilityRole="button"
          accessibilityLabel={gt("Repository color, {label}", { label })}
          accessibilityHint={gt("Choose a color for all threads in this repository on this device")}
          className="flex-row items-center gap-3 px-4 py-3"
        >
          <Text className="flex-1 text-base text-foreground">{gt("Repository color")}</Text>
          <Text className="text-base text-foreground-muted">{label}</Text>
          <SymbolView name="chevron.down" size={12} tintColorClassName="accent-foreground-muted" />
        </RowPressable>
      </Menu>
    </View>
  );
}
