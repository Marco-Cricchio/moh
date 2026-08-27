import {
  catalogEntryFor,
  thinkingLevelStates,
  thinkingStatesForRef,
  THINKING_LEVELS,
  type ThinkingEndpoint,
  type ThinkingLevel,
  type ThinkingLevelState,
} from "@moh/core";

/** Model-level control data shared by the slash command and bottom-bar
 * action (#242). Undefined means the active model declares no capability
 * (#256: config declaration or catalog map). */
export interface ThinkingLevelControl {
  ref: string;
  endpointName: string;
  states: Record<ThinkingLevel, ThinkingLevelState>;
  offered: ThinkingLevel[];
}

/** #256: derives the control from the session's endpoint profiles through
 * the core's one capability calculation — per-model config declaration >
 * endpoint-level declaration > normalized catalog map. The bare
 * `providerType` fallback covers callers without profile access (tests,
 * headless) with the catalog-only half of the same chain. */
export function thinkingLevelControl(
  ref: string | undefined,
  endpoints: ReadonlyArray<ThinkingEndpoint> | undefined,
  providerType?: string,
): ThinkingLevelControl | undefined {
  if (!ref) return undefined;
  const slash = ref.indexOf("/");
  if (slash === -1) return undefined;
  const states =
    (endpoints ? thinkingStatesForRef(ref, endpoints) : undefined) ??
    (providerType ? thinkingLevelStates(catalogEntryFor(providerType, ref.slice(slash + 1))) : undefined);
  if (!states) return undefined;
  return {
    ref,
    endpointName: ref.slice(0, slash),
    states,
    offered: THINKING_LEVELS.filter((level) => states[level] !== "provider-default"),
  };
}
