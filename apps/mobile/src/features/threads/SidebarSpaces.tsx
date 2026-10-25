import type { MenuAction } from "@react-native-menu/menu";
import {
  SIDEBAR_SPACE_COLORS,
  type SidebarSpace,
  sidebarProjectRefKey,
  sidebarSpaceIncludesGroup,
  sidebarSpaceTouchSwipeDirection,
} from "@t3tools/client-runtime/state/sidebar-spaces";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { SheetHeader } from "../../components/ui/SheetHeader";
import type { useSidebarSpaces } from "./use-sidebar-spaces";

/** A project row the space sheet can tick; one row may cover several environments' projects. */
export interface SidebarSpaceProjectOption {
  readonly key: string;
  readonly title: string;
  readonly projectRefs: readonly { environmentId: string; projectId: string }[];
}

type SidebarSpaces = ReturnType<typeof useSidebarSpaces>;

type SheetState =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly space: SidebarSpace };

/**
 * Footer control showing the current space. Tap to switch, create, edit, or delete
 * spaces; drag sideways on it to page between them. Paging lives on the bar rather
 * than the thread list because list rows already own horizontal swipes.
 */
export function SidebarSpaceBar(props: {
  readonly spaces: SidebarSpaces;
  readonly projects: readonly SidebarSpaceProjectOption[];
}) {
  const { spaces } = props;
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const swipe = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-12, 12])
    .enableTrackpadTwoFingerGesture(true)
    .runOnJS(true)
    .onEnd((event) => {
      const direction = sidebarSpaceTouchSwipeDirection(event.translationX, event.translationY);
      if (direction !== 0) spaces.step(direction);
    });

  const active = spaces.activeSpace;
  const actions: MenuAction[] = [
    { id: "space:all", title: "All projects", state: active === null ? "on" : "off" },
    ...spaces.spaces.map((space): MenuAction => ({
      id: `space:${space.id}`,
      title: space.name,
      state: active?.id === space.id ? "on" : "off",
    })),
    ...(active === null
      ? []
      : [
          {
            id: "edit",
            title: `Edit “${active.name}”…`,
            image: "pencil",
          } satisfies MenuAction,
          {
            id: "delete",
            title: "Delete space",
            image: "trash",
            attributes: { destructive: true },
          } satisfies MenuAction,
        ]),
    { id: "new", title: "New space…", image: "plus" },
  ];
  const onAction = ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
    const event = nativeEvent.event;
    if (event === "space:all") spaces.setActiveSpace(null);
    else if (event.startsWith("space:")) spaces.setActiveSpace(event.slice("space:".length));
    else if (event === "new") setSheet({ mode: "create" });
    else if (event === "edit" && active) setSheet({ mode: "edit", space: active });
    else if (event === "delete" && active) spaces.deleteSpace(active.id);
  };

  const pages = [null, ...spaces.spaces];
  return (
    <>
      <GestureDetector gesture={swipe}>
        <View
          collapsable={false}
          className="flex-row items-center gap-2 border-t border-border-subtle px-3 py-2"
        >
          <Menu actions={actions} onPressAction={onAction}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Space: ${active?.name ?? "All projects"}`}
              accessibilityHint="Switch, create, edit, or delete spaces. Swipe sideways to page."
              disabled={!spaces.loaded}
              className="min-w-0 shrink flex-row items-center gap-1.5 rounded-lg px-2 py-1.5 active:opacity-70"
            >
              <View
                className="size-2.5 rounded-full bg-drawer-foreground-muted"
                style={active ? { backgroundColor: active.color } : undefined}
              />
              <Text
                numberOfLines={1}
                className="shrink text-sm font-t3-medium text-drawer-foreground"
              >
                {active?.name ?? "All projects"}
              </Text>
              <SymbolView
                name="chevron.down"
                size={11}
                tintColorClassName="accent-drawer-foreground-muted"
                type="monochrome"
              />
            </Pressable>
          </Menu>
          {spaces.spaces.length > 0 ? (
            <View className="ml-auto flex-row items-center gap-1.5" accessibilityElementsHidden>
              {pages.map((space) => {
                const selected = (space?.id ?? null) === (active?.id ?? null);
                return (
                  <View
                    key={space?.id ?? "all"}
                    className={
                      selected
                        ? "size-2 rounded-full bg-drawer-foreground-muted"
                        : "size-1.5 rounded-full bg-drawer-foreground-muted opacity-50"
                    }
                    style={space ? { backgroundColor: space.color } : undefined}
                  />
                );
              })}
            </View>
          ) : null}
        </View>
      </GestureDetector>
      {sheet ? (
        <SidebarSpaceSheet
          initial={sheet.mode === "edit" ? sheet.space : null}
          defaultColor={
            SIDEBAR_SPACE_COLORS[spaces.spaces.length % SIDEBAR_SPACE_COLORS.length] ??
            SIDEBAR_SPACE_COLORS[0]
          }
          projects={props.projects}
          onCancel={() => setSheet(null)}
          onSave={(input) => {
            if (sheet.mode === "edit") spaces.updateSpace(sheet.space.id, input);
            else spaces.createSpace(input);
            setSheet(null);
          }}
        />
      ) : null}
    </>
  );
}

function SidebarSpaceSheet(props: {
  readonly initial: SidebarSpace | null;
  readonly defaultColor: string;
  readonly projects: readonly SidebarSpaceProjectOption[];
  readonly onCancel: () => void;
  readonly onSave: (input: Omit<SidebarSpace, "id">) => void;
}) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(props.initial?.name ?? "");
  const [color, setColor] = useState(props.initial?.color ?? props.defaultColor);
  const [projectRefs, setProjectRefs] = useState<readonly string[]>(
    props.initial?.projectRefs ?? [],
  );
  const trimmedName = name.trim();
  const toggleProject = (project: SidebarSpaceProjectOption, included: boolean) => {
    const keys = project.projectRefs.map(sidebarProjectRefKey);
    setProjectRefs((current) =>
      included
        ? [...current, ...keys.filter((key) => !current.includes(key))]
        : current.filter((key) => !keys.includes(key)),
    );
  };

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={props.onCancel}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
          <SheetHeader
            presentation="inline"
            title={props.initial ? "Edit space" : "New space"}
            onCancel={props.onCancel}
            confirm={{
              label: props.initial ? "Save" : "Create",
              disabled: trimmedName.length === 0,
              onPress: () => props.onSave({ name: trimmedName, color, projectRefs }),
            }}
          />
          <ScrollView
            contentContainerClassName="gap-6 px-4 pb-6"
            keyboardShouldPersistTaps="handled"
          >
            <Text className="text-sm text-foreground-muted">
              A space shows only its projects' threads. Spaces are saved on this device.
            </Text>
            <ListSection title="Name">
              <TextInput
                accessibilityLabel="Space name"
                autoFocus={props.initial === null}
                className="h-12 px-4 text-base text-foreground"
                onChangeText={setName}
                placeholder="Work"
                returnKeyType="done"
                value={name}
              />
            </ListSection>
            <ListSection title="Color">
              <View className="flex-row flex-wrap gap-3 p-4">
                {SIDEBAR_SPACE_COLORS.map((swatch) => (
                  <Pressable
                    key={swatch}
                    accessibilityRole="radio"
                    accessibilityLabel={`Color ${swatch}`}
                    accessibilityState={{ checked: color === swatch }}
                    onPress={() => setColor(swatch)}
                    className={
                      color === swatch
                        ? "size-8 rounded-full border-2 border-foreground"
                        : "size-8 rounded-full"
                    }
                    style={{ backgroundColor: swatch }}
                  />
                ))}
              </View>
            </ListSection>
            <ListSection title="Projects">
              {props.projects.length === 0 ? (
                <Text className="p-4 text-sm text-foreground-muted">No projects yet</Text>
              ) : (
                props.projects.map((project) => (
                  <ListToggleRow
                    key={project.key}
                    label={project.title}
                    value={sidebarSpaceIncludesGroup(
                      { projectRefs },
                      { memberProjectRefs: project.projectRefs },
                    )}
                    onValueChange={(included) => toggleProject(project, included)}
                  />
                ))
              )}
            </ListSection>
          </ScrollView>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
