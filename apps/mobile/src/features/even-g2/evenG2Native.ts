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
  /** Removes the native event listener represented by this handle. */
  remove(): void;
}

interface EvenG2NativeModule {
  /** Returns the current connection and display state. */
  getStatus(): EvenG2Status;
  /** Connects when automatic connection is enabled. */
  ensureAutoConnect(): void;
  /** Persists the automatic connection preference. */
  setAutoConnect(enabled: boolean): void;
  /** Sets the direction used to advance through displayed content. */
  setNaturalScrolling(enabled: boolean): void;
  /** Starts a connection to the glasses. */
  connect(): void;
  /** Closes the current glasses connection. */
  disconnect(): void;
  /** Resumes a display session that paused after a page failure. */
  resumeDisplay(): void;
  /** Displays text on the glasses. */
  displayText(text: string): void;
  /** Clears the current display. */
  clearDisplay(): void;
  /** Switches between active-thread input and the thread picker. */
  setInputEnabled(enabled: boolean): void;
  /** Marks which thread receives speech input. */
  setActiveThread(key: string, enabled: boolean): void;
  /** Replaces the thread choices shown by the glasses. */
  setThreadChoices(choices: ReadonlyArray<EvenG2ThreadChoice>): void;
  /** Opens the glasses' thread picker. */
  showThreadPicker(): void;
  /** Starts speech recognition for the current dictation session. */
  beginDictation(): Promise<void>;
  /** Finishes speech recognition and emits the final transcript. */
  finishDictation(): Promise<void>;
  /** Cancels speech recognition without submitting its partial transcript. */
  cancelDictation(): Promise<void>;
  /** Registers a listener for a native module event. */
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

/** Loads the iOS native module once, or returns null where direct mode is unavailable. */
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

/** Updates the JS status snapshot and notifies every subscribed screen. */
function publishStatus(status: EvenG2Status): void {
  cachedStatus = status;
  for (const subscriber of statusSubscribers) {
    subscriber();
  }
}

/** Attaches one native status listener while JS subscribers are present. */
function ensureNativeStatusSubscription(): void {
  const module = nativeModule();
  if (!module || nativeStatusSubscription) {
    return;
  }
  nativeStatusSubscription = module.addListener<EvenG2Status>("onStatus", publishStatus);
  publishStatus(module.getStatus());
}

/** Returns the latest cached native status, loading the module if needed. */
export function getEvenG2Status(): EvenG2Status {
  nativeModule();
  return cachedStatus;
}

/** Subscribes to status changes and removes the native listener after the last unsubscribe. */
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

/** Reads native status as a React external store, with an unsupported server snapshot. */
export function useEvenG2Status(): EvenG2Status {
  return useSyncExternalStore(subscribeEvenG2Status, getEvenG2Status, () => unavailableStatus);
}

/** Subscribes to speech results from the native dictation session. */
export function subscribeEvenG2Transcripts(
  listener: (event: EvenG2TranscriptEvent) => void,
): () => void {
  const subscription = nativeModule()?.addListener<EvenG2TranscriptEvent>("onTranscript", listener);
  return () => subscription?.remove();
}

/** Asks native code to connect when the saved auto-connect preference allows it. */
export function ensureEvenG2AutoConnect(): void {
  nativeModule()?.ensureAutoConnect();
}

/** Saves whether the glasses should reconnect automatically. */
export function setEvenG2AutoConnect(enabled: boolean): void {
  nativeModule()?.setAutoConnect(enabled);
}

/** Sets whether vertical gestures follow the natural-scroll direction. */
export function setEvenG2NaturalScrolling(enabled: boolean): void {
  nativeModule()?.setNaturalScrolling(enabled);
}

/** Starts connecting to the Even glasses. */
export function connectEvenG2(): void {
  nativeModule()?.connect();
}

/** Disconnects from the Even glasses. */
export function disconnectEvenG2(): void {
  nativeModule()?.disconnect();
}

/** Restarts the native display after its page session has paused. */
export function resumeEvenG2Display(): void {
  nativeModule()?.resumeDisplay();
}

/** Sends reply text to the native display. */
export function displayEvenG2Text(text: string): void {
  nativeModule()?.displayText(text);
}

/** Switches between active-thread input and the thread picker. */
export function setEvenG2InputEnabled(enabled: boolean): void {
  nativeModule()?.setInputEnabled(enabled);
}

/** Marks the workspace thread that should receive Even dictation. */
export function setEvenG2ActiveThread(key: string, enabled: boolean): void {
  nativeModule()?.setActiveThread(key, enabled);
}

/** Replaces the choices shown when R1 opens the native thread picker. */
export function setEvenG2ThreadChoices(choices: ReadonlyArray<EvenG2ThreadChoice>): void {
  nativeModule()?.setThreadChoices(choices);
}

/** Opens the native picker, including when its current choice list is stale. */
export function showEvenG2ThreadPicker(): void {
  nativeModule()?.showThreadPicker();
}

/** Subscribes to native picker selections and returns the listener cleanup. */
export function subscribeEvenG2ThreadSelections(
  listener: (event: { readonly key: string }) => void,
): () => void {
  const subscription = nativeModule()?.addListener("onThreadSelected", listener);
  return () => subscription?.remove();
}
