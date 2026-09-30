import * as Option from "effect/Option";

import { useThreadSelection } from "./use-thread-selection";

/**
 * The selection owns the subscription so it can hold it back while a queued
 * creation has not reached the server yet.
 */
export function useSelectedThreadDetailState() {
  return useThreadSelection().selectedThreadDetailState;
}

export function useSelectedThreadDetail() {
  return Option.getOrNull(useSelectedThreadDetailState().data);
}
