import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { RowPressable } from "../../components/RowPressable";
import { THREAD_HIGHLIGHT_COLORS } from "../../lib/threadHighlight";
import { useThreadHighlight } from "./use-thread-highlight";

export function ThreadHighlightSetting(props: { readonly threadKey: string }) {
  const highlight = useThreadHighlight(props.threadKey);
  const label =
    highlight.override === undefined
      ? "Use server"
      : highlight.override === "none"
        ? "None"
        : (THREAD_HIGHLIGHT_COLORS.find(({ color }) => color === highlight.override?.toLowerCase())
            ?.title ?? highlight.override);
  return (
    <View className="mx-4 mt-4 overflow-hidden rounded-2xl bg-grouped-card">
      <ControlPillMenu
        actions={highlight.actions}
        onPressAction={({ nativeEvent }) => highlight.handleAction(nativeEvent.event)}
      >
        <RowPressable
          disabled={!highlight.loaded}
          accessibilityRole="button"
          accessibilityLabel={`Thread highlight, ${label}`}
          accessibilityHint="Choose a highlight for this thread on this device"
          className="flex-row items-center gap-3 px-4 py-3"
        >
          <Text className="flex-1 text-base text-foreground">Thread highlight</Text>
          <Text className="text-base text-foreground-muted">{label}</Text>
          <SymbolView name="chevron.down" size={12} tintColorClassName="accent-foreground-muted" />
        </RowPressable>
      </ControlPillMenu>
    </View>
  );
}
