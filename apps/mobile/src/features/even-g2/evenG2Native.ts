import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { useSyncExternalStore } from "react";

export type EvenG2ConnectionStatus =
  | "disconnected"
  | "scanning"
  | "connecting"
  | "starting"
  | "ready"
  | "paused"
  | "error"
  | "unsupported";

export interface EvenG2Status {
  readonly status: EvenG2ConnectionStatus;
  readonly detail: string;
  readonly connected: boolean;
  readonly listening: boolean;
  readonly autoConnect: boolean;
  readonly naturalScrolling: boolean;
}

export interface EvenG2TranscriptEvent {
  readonly text: string;
  readonly isFinal: boolean;
  readonly cancelled?: boolean;
}

export interface EvenG2ThreadChoice {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
}

interface EventSubscription {
  remove(): void;
}

interface EvenG2NativeModule {
  getStatus(): EvenG2Status;
  ensureAutoConnect(): void;
  setAutoConnect(enabled: boolean): void;
  setNaturalScrolling(enabled: boolean): void;
  connect(): void;
  disconnect(): void;
  resumeDisplay(): void;
  displayText(text: string): void;
  clearDisplay(): void;
  setInputEnabled(enabled: boolean): void;
  setActiveThread(key: string, enabled: boolean): void;
  setThreadChoices(choices: ReadonlyArray<EvenG2ThreadChoice>): void;
  showThreadPicker(): void;
  beginDictation(): Promise<void>;
  finishDictation(): Promise<void>;
  cancelDictation(): Promise<void>;
  addListener<T>(eventName: string, listener: (event: T) => void): EventSubscription;
}

const unavailableStatus: EvenG2Status = {
  status: "unsupported",
  detail:
    Platform.OS === "ios"
      ? "Install a native T3 Code build containing the Even G2 module."
      : "Even G2 direct mode is available on iOS 26 or later.",
  connected: false,
  listening: false,
  autoConnect: false,
  naturalScrolling: true,
};

let cachedModule: EvenG2NativeModule | null | undefined;
let cachedStatus = unavailableStatus;
const statusSubscribers = new Set<() => void>();
let nativeStatusSubscription: EventSubscription | null = null;

function nativeModule(): EvenG2NativeModule | null {
  if (cachedModule !== undefined) {
    return cachedModule;
  }
  cachedModule =
    Platform.OS === "ios" ? requireOptionalNativeModule<EvenG2NativeModule>("T3EvenG2") : null;
  if (cachedModule) {
    cachedStatus = cachedModule.getStatus();
  }
  return cachedModule;
}

function publishStatus(status: EvenG2Status): void {
  cachedStatus = status;
  for (const subscriber of statusSubscribers) {
    subscriber();
  }
}

function ensureNativeStatusSubscription(): void {
  const module = nativeModule();
  if (!module || nativeStatusSubscription) {
    return;
  }
  nativeStatusSubscription = module.addListener<EvenG2Status>("onStatus", publishStatus);
  publishStatus(module.getStatus());
}

export function getEvenG2Status(): EvenG2Status {
  nativeModule();
  return cachedStatus;
}

export function subscribeEvenG2Status(subscriber: () => void): () => void {
  statusSubscribers.add(subscriber);
  ensureNativeStatusSubscription();
  return () => {
    statusSubscribers.delete(subscriber);
    if (statusSubscribers.size === 0) {
      nativeStatusSubscription?.remove();
      nativeStatusSubscription = null;
    }
  };
}

export function useEvenG2Status(): EvenG2Status {
  return useSyncExternalStore(subscribeEvenG2Status, getEvenG2Status, () => unavailableStatus);
}

export function subscribeEvenG2Transcripts(
  listener: (event: EvenG2TranscriptEvent) => void,
): () => void {
  const subscription = nativeModule()?.addListener<EvenG2TranscriptEvent>("onTranscript", listener);
  return () => subscription?.remove();
}

export function ensureEvenG2AutoConnect(): void {
  nativeModule()?.ensureAutoConnect();
}

export function setEvenG2AutoConnect(enabled: boolean): void {
  nativeModule()?.setAutoConnect(enabled);
}

export function setEvenG2NaturalScrolling(enabled: boolean): void {
  nativeModule()?.setNaturalScrolling(enabled);
}

export function connectEvenG2(): void {
  nativeModule()?.connect();
}

export function disconnectEvenG2(): void {
  nativeModule()?.disconnect();
}

export function resumeEvenG2Display(): void {
  nativeModule()?.resumeDisplay();
}

export function displayEvenG2Text(text: string): void {
  nativeModule()?.displayText(text);
}

export function setEvenG2InputEnabled(enabled: boolean): void {
  nativeModule()?.setInputEnabled(enabled);
}

export function setEvenG2ActiveThread(key: string, enabled: boolean): void {
  nativeModule()?.setActiveThread(key, enabled);
}

export function setEvenG2ThreadChoices(choices: ReadonlyArray<EvenG2ThreadChoice>): void {
  nativeModule()?.setThreadChoices(choices);
}

export function showEvenG2ThreadPicker(): void {
  nativeModule()?.showThreadPicker();
}

export function subscribeEvenG2ThreadSelections(
  listener: (event: { readonly key: string }) => void,
): () => void {
  const subscription = nativeModule()?.addListener("onThreadSelected", listener);
  return () => subscription?.remove();
}
