import { HeaderHeightContext } from "@react-navigation/elements";
import { useState, type ReactNode } from "react";
import { View, type ColorValue } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { NativeColumnLayoutMetricsContext, useNativeLayoutMetrics } from "./native-layout-metrics";
import { horizontalSafeAreaEdges, type NativeLayoutMetrics } from "../lib/reserved-regions";
import { NativeLayoutObserver } from "./NativeLayoutObserver";

export function NativeColumnContent(props: {
  readonly children: ReactNode;
  readonly primary?: boolean;
  readonly insetHorizontally?: boolean;
  readonly backgroundColor?: ColorValue;
}) {
  const [metrics, setMetrics] = useState<NativeLayoutMetrics | null>(null);
  const windowMetrics = useNativeLayoutMetrics();
  return (
    <View
      className={props.primary ? "flex-1 bg-drawer" : "flex-1 bg-screen"}
      style={
        props.backgroundColor === undefined ? undefined : { backgroundColor: props.backgroundColor }
      }
    >
      <SafeAreaProvider style={{ flex: 1 }}>
        <SafeAreaView
          edges={props.insetHorizontally === false ? [] : horizontalSafeAreaEdges(windowMetrics)}
          style={{ flex: 1 }}
        >
          {/* Observe the inset body. UIKit can reserve other columns in its safe area. */}
          <View style={{ flex: 1 }}>
            <NativeLayoutObserver onChange={setMetrics} />
            <NativeColumnLayoutMetricsContext value={metrics}>
              <HeaderHeightContext value={metrics?.safeArea.top ?? undefined}>
                {props.children}
              </HeaderHeightContext>
            </NativeColumnLayoutMetricsContext>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </View>
  );
}
