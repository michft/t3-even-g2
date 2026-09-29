import { useEffect, useEffectEvent, useMemo } from "react";
import { Platform } from "react-native";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";

import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useProjects, useThreadShells } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  ensureEvenG2AutoConnect,
  setEvenG2ThreadChoices,
  showEvenG2ThreadPicker,
  subscribeEvenG2ThreadSelections,
  useEvenG2Status,
} from "./evenG2Native";

/** Lives with the workspace, so R1 can choose a thread from Home or Settings. */
export function EvenG2ThreadPickerBridge() {
  const status = useEvenG2Status();
  return status.autoConnect || status.connected ? <ThreadPickerContent /> : null;
}

/** Keeps the native picker current and routes R1 selections into the workspace. */
function ThreadPickerContent() {
  const threads = useThreadShells();
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { selectThread } = useAdaptiveWorkspaceLayout();
  const choices = useMemo(() => {
    const projectNames = new Map(
      projects.map((project) => [
        scopedProjectKey(project.environmentId, project.id),
        project.title,
      ]),
    );
    return sortThreads(
      threads.filter((thread) => thread.archivedAt === null),
      "updated_at",
    ).map((thread) => ({
      key: scopedThreadKey(thread.environmentId, thread.id),
      title: thread.title.trim() || "Untitled",
      subtitle: [
        savedConnectionsById[thread.environmentId]?.environmentLabel,
        projectNames.get(scopedProjectKey(thread.environmentId, thread.projectId)),
      ]
        .filter(Boolean)
        .join(" · "),
    }));
  }, [threads, projects, savedConnectionsById]);

  /** Opens a current thread selection or refreshes the picker if that thread vanished. */
  const chooseThread = useEffectEvent(({ key }: { readonly key: string }) => {
    const thread = threads.find(
      (item) => scopedThreadKey(item.environmentId, item.id) === key && item.archivedAt === null,
    );
    if (thread) selectThread(thread);
    else showEvenG2ThreadPicker();
  });

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const unsubscribe = subscribeEvenG2ThreadSelections(chooseThread);
    ensureEvenG2AutoConnect();
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (Platform.OS === "ios") setEvenG2ThreadChoices(choices);
  }, [choices]);

  return null;
}
