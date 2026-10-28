import type { MenuAction } from "@react-native-menu/menu";
import {
  SIDEBAR_SPACE_COLORS,
  sidebarProjectRefKey,
  sidebarSpaceTouchSwipeDirection,
} from "@t3tools/client-runtime/state/sidebar-spaces";
import { useState } from "react";
import * as Crypto from "expo-crypto";
import {
  spaceMemberColour,
  spaceRepositoryKey,
  spaceRepositorySelectors,
  type MobileSidebarSpace as SidebarSpace,
  type MobileSpacePreferences,
  type SpaceGroupBy,
} from "../../lib/sidebarSpaces";
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
  readonly machines: readonly { readonly environmentId: string; readonly label: string }[];
  readonly machineColours: ReadonlyMap<string, string | null>;
}) {
  const { spaces } = props;
  const [sheet, setSheet] = useState<SheetState | null>(null);
  // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan is a gesture factory, not a React component.
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
  /** Read shared member colours so overlapping Space edits appear here too. */
  const appearance = (space: SidebarSpace) =>
    spaceMemberColour(space, spaces.preferences, spaces.projects, props.machineColours);
  const activeAppearance = active ? appearance(active) : null;
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
                style={activeAppearance ? { backgroundColor: activeAppearance.colour } : undefined}
              />
              <Text
                numberOfLines={1}
                className="shrink text-sm font-t3-medium text-drawer-foreground"
              >
                {active?.name ?? "All projects"}
                {activeAppearance?.mixed ? " · Mixed" : ""}
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
                    style={space ? { backgroundColor: appearance(space).colour } : undefined}
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
          machines={props.machines}
          spaces={spaces}
          onCancel={() => setSheet(null)}
          onSave={(input, metadata, applyColour) => {
            if (sheet.mode === "edit")
              spaces.updateSpace(sheet.space.id, input, metadata, applyColour);
            else spaces.createSpace(input, metadata);
            setSheet(null);
          }}
        />
      ) : null}
    </>
  );
}

/** Edit one Space and review its selected identity before persisting metadata or colours. */
function SidebarSpaceSheet(props: {
  readonly initial: SidebarSpace | null;
  readonly defaultColor: string;
  readonly projects: readonly SidebarSpaceProjectOption[];
  readonly onCancel: () => void;
  readonly machines: readonly { readonly environmentId: string; readonly label: string }[];
  readonly spaces: SidebarSpaces;
  readonly onSave: (
    input: Omit<SidebarSpace, "id">,
    metadata: Partial<MobileSpacePreferences>,
    applyColour: boolean,
  ) => void;
}) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(props.initial?.name ?? "");
  const [color, setColor] = useState(props.initial?.color ?? props.defaultColor);
  const [projectRefs, setProjectRefs] = useState<readonly string[]>(
    props.initial?.projectRefs ?? [],
  );
  const [repositoryKeys, setRepositoryKeys] = useState<readonly string[]>(
    props.initial ? spaceRepositorySelectors(props.initial, props.spaces.projects) : [],
  );
  const [colourEdited, setColourEdited] = useState(false);
  const [groupBy, setGroupBy] = useState<SpaceGroupBy>(props.initial?.groupBy ?? "repo");
  const [machineIds, setMachineIds] = useState<readonly string[]>(props.initial?.machineIds ?? []);
  const [workTypeIds, setWorkTypeIds] = useState<readonly string[]>(
    props.initial?.workTypeIds ?? [],
  );
  const [workTypes, setWorkTypes] = useState<
    readonly { readonly id: string; readonly name: string }[]
  >(props.spaces.workTypes);
  const [assignments, setAssignments] = useState(
    props.spaces.preferences.repositoryWorkTypes ?? {},
  );
  const [newType, setNewType] = useState("");
  const trimmedName = name.trim();
  const validTypes =
    workTypes.every((type) => type.name.trim().length > 0) &&
    new Set(workTypes.map((type) => type.name.trim().toLowerCase())).size === workTypes.length;
  /** Add or remove one reviewed member without duplicate IDs. */
  const toggle = (values: readonly string[], key: string, included: boolean) =>
    included ? [...new Set([...values, key])] : values.filter((value) => value !== key);
  /** Resolve the projects behind a displayed repo group to their canonical identities. */
  const keysFor = (option: SidebarSpaceProjectOption) => [
    ...new Set(
      props.spaces.projects
        .filter((project) =>
          option.projectRefs.some(
            (ref) => ref.environmentId === project.environmentId && ref.projectId === project.id,
          ),
        )
        .map((project) => spaceRepositoryKey(project, props.spaces.projects)),
    ),
  ];
  /** Commit the reviewed group and category edits together. */
  const save = () => {
    const ids = new Set(workTypes.map((type) => type.id));
    const metadata = {
      workTypes: workTypes.map((type) => ({ ...type, name: type.name.trim() })),
      repositoryWorkTypes: Object.fromEntries(
        Object.entries(assignments).filter(([, id]) => ids.has(id)),
      ),
    };
    props.onSave(
      {
        name: trimmedName,
        color,
        groupBy,
        projectRefs: groupBy === "repo" ? projectRefs : [],
        repositoryKeys: groupBy === "repo" ? repositoryKeys : [],
        machineIds: groupBy === "machine" ? machineIds : [],
        workTypeIds:
          groupBy === "work_type"
            ? workTypeIds.filter((id) => id === "unclassified" || ids.has(id))
            : [],
      },
      metadata,
      colourEdited,
    );
  };
  /** Keep canonical selectors and legacy project references consistent. */
  const toggleProject = (project: SidebarSpaceProjectOption, included: boolean) => {
    const keys = project.projectRefs.map(sidebarProjectRefKey);
    const canonicalKeys = keysFor(project);
    setRepositoryKeys((current) =>
      included
        ? [...new Set([...current, ...canonicalKeys])]
        : current.filter(
            (key) => !canonicalKeys.includes(key) && !keys.some((ref) => key === `project:${ref}`),
          ),
    );
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
              disabled: trimmedName.length === 0 || !validTypes,
              onPress: save,
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
            <ListSection title="Group by">
              <Menu
                actions={(
                  [
                    ["machine", "Machine"],
                    ["repo", "Repo"],
                    ["work_type", "Work type"],
                  ] as const
                ).map(([id, title]) => ({ id, title, state: groupBy === id ? "on" : "off" }))}
                onPressAction={({ nativeEvent }) => {
                  const id = nativeEvent.event;
                  if (id === "machine" || id === "repo" || id === "work_type") setGroupBy(id);
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Group by: ${groupBy === "work_type" ? "Work type" : groupBy === "machine" ? "Machine" : "Repo"}`}
                  className="flex-row items-center justify-between px-4 py-3"
                >
                  <Text className="text-base text-foreground">
                    {groupBy === "work_type"
                      ? "Work type"
                      : groupBy === "machine"
                        ? "Machine"
                        : "Repo"}
                  </Text>
                  <SymbolView
                    name="chevron.down"
                    size={12}
                    tintColorClassName="accent-foreground-muted"
                  />
                </Pressable>
              </Menu>
            </ListSection>
            <Text className="text-sm text-foreground-muted">
              Review members when changing grouping. Colour edits apply to these members everywhere
              on this device.
            </Text>
            <ListSection title="Color">
              <View className="flex-row flex-wrap gap-3 p-4">
                {SIDEBAR_SPACE_COLORS.map((swatch) => (
                  <Pressable
                    key={swatch}
                    accessibilityRole="radio"
                    accessibilityLabel={`Color ${swatch}`}
                    accessibilityState={{ checked: color === swatch }}
                    onPress={() => {
                      setColor(swatch);
                      setColourEdited(true);
                    }}
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
            {groupBy === "machine" ? (
              <ListSection title="Machines">
                {props.machines.map((machine) => (
                  <ListToggleRow
                    key={machine.environmentId}
                    label={machine.label}
                    value={machineIds.includes(machine.environmentId)}
                    onValueChange={(included) =>
                      setMachineIds((current) => toggle(current, machine.environmentId, included))
                    }
                  />
                ))}
              </ListSection>
            ) : null}
            {groupBy === "work_type" ? (
              <>
                <ListSection title="Included work types">
                  {[{ id: "unclassified", name: "Unclassified" }, ...workTypes].map((type) => (
                    <ListToggleRow
                      key={type.id}
                      label={type.name}
                      value={workTypeIds.includes(type.id)}
                      onValueChange={(included) =>
                        setWorkTypeIds((current) => toggle(current, type.id, included))
                      }
                    />
                  ))}
                </ListSection>
                <ListSection title="Manage work types">
                  {workTypes.map((type) => (
                    <View key={type.id} className="flex-row items-center gap-3 px-4 py-2">
                      <TextInput
                        accessibilityLabel={`Work type name: ${type.name}`}
                        value={type.name}
                        onChangeText={(value) =>
                          setWorkTypes((current) =>
                            current.map((item) =>
                              item.id === type.id ? { ...item, name: value } : item,
                            ),
                          )
                        }
                        className="min-w-0 flex-1 text-base text-foreground"
                      />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Delete work type ${type.name}`}
                        onPress={() =>
                          setWorkTypes((current) => current.filter((item) => item.id !== type.id))
                        }
                        className="p-3"
                      >
                        <Text className="text-sm text-danger-foreground">Delete</Text>
                      </Pressable>
                    </View>
                  ))}
                  <View className="flex-row items-center gap-3 px-4 py-3">
                    <TextInput
                      accessibilityLabel="New work type"
                      placeholder="Work type name"
                      value={newType}
                      onChangeText={setNewType}
                      className="min-w-0 flex-1 text-base text-foreground"
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Add work type"
                      disabled={
                        !newType.trim() ||
                        workTypes.some(
                          (type) => type.name.trim().toLowerCase() === newType.trim().toLowerCase(),
                        )
                      }
                      onPress={() => {
                        setWorkTypes((current) => [
                          ...current,
                          { id: Crypto.randomUUID(), name: newType.trim() },
                        ]);
                        setNewType("");
                      }}
                      className="p-3"
                    >
                      <Text className="text-sm text-foreground">Add</Text>
                    </Pressable>
                  </View>
                </ListSection>
                {!validTypes ? (
                  <Text className="text-sm text-danger-foreground">
                    Work type names must be unique and nonempty.
                  </Text>
                ) : null}
                <ListSection title="Assign repositories">
                  {props.projects.map((project) => {
                    const keys = keysFor(project);
                    const selected = new Set(keys.map((key) => assignments[key] ?? "unclassified"));
                    const id = selected.size === 1 ? [...selected][0] : undefined;
                    return (
                      <Menu
                        key={project.key}
                        actions={[
                          {
                            id: "unclassified",
                            title: "Unclassified",
                            state: id === "unclassified" ? "on" : "off",
                          },
                          ...workTypes.map((type) => ({
                            id: type.id,
                            title: type.name,
                            state: id === type.id ? ("on" as const) : ("off" as const),
                          })),
                        ]}
                        onPressAction={({ nativeEvent }) =>
                          setAssignments((current) => ({
                            ...current,
                            ...Object.fromEntries(keys.map((key) => [key, nativeEvent.event])),
                          }))
                        }
                      >
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Work type for ${project.title}`}
                          className="gap-1 px-4 py-3"
                        >
                          <Text className="text-base text-foreground">{project.title}</Text>
                          <Text className="text-sm text-foreground-muted">
                            {id === undefined
                              ? "Mixed"
                              : (workTypes.find((type) => type.id === id)?.name ?? "Unclassified")}
                          </Text>
                        </Pressable>
                      </Menu>
                    );
                  })}
                </ListSection>
              </>
            ) : null}
            {groupBy === "repo" ? (
              <ListSection title="Repositories">
                {props.projects.length === 0 ? (
                  <Text className="p-4 text-sm text-foreground-muted">No projects yet</Text>
                ) : (
                  props.projects.map((project) => (
                    <ListToggleRow
                      key={project.key}
                      label={project.title}
                      value={
                        keysFor(project).some((key) => repositoryKeys.includes(key)) ||
                        project.projectRefs.some((ref) =>
                          repositoryKeys.includes(`project:${sidebarProjectRefKey(ref)}`),
                        )
                      }
                      onValueChange={(included) => toggleProject(project, included)}
                    />
                  ))
                )}
              </ListSection>
            ) : null}
          </ScrollView>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
