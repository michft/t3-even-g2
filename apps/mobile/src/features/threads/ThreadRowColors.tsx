import { memo, useId } from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import type { ThreadOriginColorMode } from "@t3tools/contracts";

/** Static edge washes sit beneath row content; tabs remain visible in every display mode. */
export const ThreadRowColors = memo(function ThreadRowColors(props: {
  readonly serverColor: string | null | undefined;
  readonly repositoryColor: string | null;
  readonly mode: ThreadOriginColorMode;
  readonly leftStrength: number;
  readonly rightStrength: number;
  readonly workType?: { readonly name: string; readonly colour: string | null } | null;
}) {
  const id = useId().replaceAll(":", "");
  const left = props.mode === "tint" && props.serverColor && props.leftStrength > 0;
  const right = props.mode === "tint" && props.repositoryColor && props.rightStrength > 0;
  return (
    <>
      {props.workType?.colour ? (
        <View
          accessible
          accessibilityLabel={`Work type: ${props.workType.name}`}
          pointerEvents="none"
          className="absolute bottom-0 left-4 right-4 h-0.5"
          style={{ backgroundColor: props.workType.colour }}
        />
      ) : null}
      {left || right ? (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="absolute inset-0"
        >
          <Svg width="100%" height="100%">
            <Defs>
              {left ? (
                <LinearGradient id={`${id}-left`} x1="0%" x2="100%" y1="0%" y2="0%">
                  <Stop
                    offset="0%"
                    stopColor={props.serverColor!}
                    stopOpacity={props.leftStrength / 100}
                  />
                  <Stop offset="100%" stopColor={props.serverColor!} stopOpacity={0} />
                </LinearGradient>
              ) : null}
              {right ? (
                <LinearGradient id={`${id}-right`} x1="0%" x2="100%" y1="0%" y2="0%">
                  <Stop offset="0%" stopColor={props.repositoryColor!} stopOpacity={0} />
                  <Stop
                    offset="100%"
                    stopColor={props.repositoryColor!}
                    stopOpacity={props.rightStrength / 100}
                  />
                </LinearGradient>
              ) : null}
            </Defs>
            {left ? <Rect width="100%" height="100%" fill={`url(#${id}-left)`} /> : null}
            {right ? <Rect width="100%" height="100%" fill={`url(#${id}-right)`} /> : null}
          </Svg>
        </View>
      ) : null}
      {props.serverColor ? (
        <View
          accessible={false}
          pointerEvents="none"
          className="absolute bottom-0 left-0 top-0 w-1"
          style={{ backgroundColor: props.serverColor }}
        />
      ) : null}
      {props.repositoryColor ? (
        <View
          accessible={false}
          pointerEvents="none"
          className="absolute bottom-0 right-0 top-0 w-1.5"
          style={{ backgroundColor: props.repositoryColor }}
        />
      ) : null}
    </>
  );
});
