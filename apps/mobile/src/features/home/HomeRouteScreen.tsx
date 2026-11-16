import { uuidv4 } from "../../lib/uuid";
import { ThreadUndoNotice } from "./ThreadUndoNotice";
import { use } from "react";
import { useDeviceType } from "../../native/native-layout-metrics";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Platform } from "react-native";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";

import { useProjects } from "../../state/entities";
import { steadyNavigationThreadShellsAtom } from "../../state/threads";
import { useLaunchingThreads, usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { SIDEBAR_SPACE_BAR_HEIGHT } from "../threads/SidebarSpaces";
import { useHomeListOptions } from "./home-list-options";
import {
  runWhenHomeCovered,
  useAtomValueWhileVisible,
  useHomeRouteVisible,
} from "./home-route-visibility";
import {
  buildHomeProjectScopes,
  resolveHomeProjectFilterScope,
  sortHomeProjectScopes,
} from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { openSettings } from "../settings/settings-navigation";
import { useSelectWorkspaceTab } from "../layout/workspace/useSelectWorkspaceTab";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { WorkspaceListEmptyDetail } from "../layout/workspace/WorkspaceListEmptyDetail";
import { WorkspaceListHeader } from "../layout/workspace/WorkspaceListHeader";
import { buildHomeListFilterMenuItems, homeListFilterEnvironments } from "./home-list-filter-menu";

export function HomeRouteScreen() {
  const nativePrimaryColumn = use(NativePrimaryColumnContext);
  const { layout, setPrimarySidebarSearchQuery, startNewTask } = useAdaptiveWorkspaceLayout();
  const { primarySidebarSearchQuery } = useWorkspacePaneState();
  const deviceType = useDeviceType();
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  // Stop rebuilding the streaming thread list while Thread covers Home.
  const visible = useHomeRouteVisible();
  const threads = useLaunchingThreads(
    useAtomValueWhileVisible(steadyNavigationThreadShellsAtom, visible),
  );
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const selectTab = useSelectWorkspaceTab();
  const workspace = useWorkspaceTabs();
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  // Phone Home and the retained landscape sidebar share one query across navigation.
  const searchQuery =
    Platform.OS === "android" || deviceType === "phone"
      ? primarySidebarSearchQuery
      : (workspace?.state.tabs.threads.query ?? localSearchQuery);
  const setSearchQuery = (query: string) => {
    if (Platform.OS === "android" || deviceType === "phone") setPrimarySidebarSearchQuery(query);
    if (Platform.OS !== "android") {
      if (workspace) workspace.dispatch({ type: "query", query, tab: "threads" });
      else setLocalSearchQuery(query);
    }
  };
  // Split layouts keep the query; only the stacked layout opens the thread over the list.
  // Android's search field keeps its own open state, which a cleared query would leave open.
  const clearsSearchOnOpen = Platform.OS !== "android" && !layout.usesSplitView;
  const selectThreadRoute = (params: ReactNavigation.RootParamList["Thread"]) => {
    if (searchQuery !== "" && clearsSearchOnOpen && workspace)
      runWhenHomeCovered(() => workspace.cancelSearch("threads"));
    selectDetail({ name: "Thread", params });
  };
  const handleSelectThread = (thread: EnvironmentThreadShell) =>
    selectThreadRoute({ environmentId: String(thread.environmentId), threadId: String(thread.id) });
  const handleNewThreadOnBranch = (thread: EnvironmentThreadShell) => {
    selectThreadRoute({
      draft: {
        requestId: uuidv4(),
        environmentId: String(thread.environmentId),
        projectId: String(thread.projectId),
        branch: thread.branch,
        worktreePath: thread.worktreePath,
      },
    });
  };

  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
    unsettleThread,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } =
    usePendingTaskListActions(selectThreadRoute);
  const environments = homeListFilterEnvironments(workspaceEnvironments);
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const {
    options: listOptions,
    setSelectedEnvironmentId,
    setSelectedProjectKey,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: selectedEnvironmentId,
        projectGroupingMode: listOptions.projectGroupingMode,
      }),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentId],
  );
  const projectFilterOptions = useMemo(
    () =>
      pickableProjectGroups(
        sortHomeProjectScopes({
          scopes: projectScopes,
          threads,
          pendingTasks: [],
          projectSortOrder: "updated_at",
        }),
      ).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projectScopes, threads],
  );
  const selectedProjectKey =
    resolveHomeProjectFilterScope(projectScopes, projects, listOptions)?.key ?? null;

  if (layout.usesSplitView && !nativePrimaryColumn) {
    return (
      <WorkspaceListEmptyDetail
        hasConnections={catalogState.hasConnections}
        // The phone workspace owns its header across rotation. Clearing it here
        // leaves cached workspace options empty after returning to portrait.
        keepsRouteHeader={workspace !== null && deviceType === "phone" && Platform.OS === "ios"}
        onAddConnection={() => openSettings(navigation, "SettingsEnvironmentNew")}
        onStartNewTask={startNewTask}
      />
    );
  }

  return (
    <AndroidHomeFabLayout onStartNewTask={startNewTask}>
      <>
        <WorkspaceListHeader
          accessibilityLabel="T3 Code, Threads"
          onOpenEnvironments={() => openSettings(navigation, "SettingsEnvironments")}
          search={{
            value: searchQuery,
            onChangeText: setSearchQuery,
            placeholder: "Search",
            accessibilityLabel: "Search threads",
          }}
          filter={{
            customized: selectedEnvironmentId !== null || selectedProjectKey !== null,
            items: buildHomeListFilterMenuItems({
              environments,
              projects: projectFilterOptions,
              selectedEnvironmentId,
              selectedProjectKey,
              onEnvironmentChange: setSelectedEnvironmentId,
              onProjectChange: setSelectedProjectKey,
            }),
          }}
        />

        <HomeScreen
          catalogState={catalogState}
          environments={environments}
          onAddConnection={() => openSettings(navigation, "SettingsEnvironmentNew")}
          onArchiveThread={archiveThread}
          onDeleteThread={confirmDeleteThread}
          onSettleThread={settleThread}
          onSnoozeThread={snoozeThread}
          onUnsnoozeThread={unsnoozeThread}
          onUnsettleThread={unsettleThread}
          onPinThread={pinThread}
          onUnpinThread={unpinThread}
          onSetThreadAutoSettle={setThreadAutoSettle}
          onMoveThread={moveThread}
          onRenameThread={renameThread}
          onRegenerateThreadTitle={regenerateThreadTitle}
          onOpenSettings={() => selectTab("settings")}
          onSearchQueryChange={setSearchQuery}
          onSelectThread={handleSelectThread}
          onClearThread={() => navigation.dispatch(StackActions.popToTop())}
          onSelectPendingTask={openPendingTask}
          onDeletePendingTask={confirmDeletePendingTask}
          onNewThreadOnBranch={handleNewThreadOnBranch}
          onNewThreadInProject={(project) => {
            selectThreadRoute({
              draft: {
                requestId: uuidv4(),
                environmentId: String(project.environmentId),
                projectId: String(project.id),
                title: project.title,
              },
            });
          }}
          onStartNewTask={startNewTask}
          pendingTasks={pendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={projects}
          projectSortOrder={listOptions.projectSortOrder}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          threads={threads}
          visible={visible}
        />
        <ThreadUndoNotice
          visible={visible}
          tabsClearance={
            Platform.OS === "ios" && workspace
              ? workspace.bottomClearance + SIDEBAR_SPACE_BAR_HEIGHT
              : undefined
          }
        />
      </>
    </AndroidHomeFabLayout>
  );
}
