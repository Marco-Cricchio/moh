import {
  catalogEntryFor,
  thinkingLevelStates,
  THINKING_LEVELS,
  type ThinkingLevel,
  type ThinkingLevelState,
} from "@moh/core";

/** Model-level control data shared by the slash command and bottom-bar
 * action (#242). Undefined means the active model declares no level map. */
export interface ThinkingLevelControl {
  ref: string;
  endpointName: string;
  states: Record<ThinkingLevel, ThinkingLevelState>;
  offered: ThinkingLevel[];
}

export function thinkingLevelControl(
  ref: string | undefined,
  providerType: string | undefined,
): ThinkingLevelControl | undefined {
  if (!ref || !providerType) return undefined;
  const slash = ref.indexOf("/");
  if (slash === -1) return undefined;
  const states = thinkingLevelStates(catalogEntryFor(providerType, ref.slice(slash + 1)));
  if (!states) return undefined;
  return {
    ref,
    endpointName: ref.slice(0, slash),
    states,
    offered: THINKING_LEVELS.filter((level) => states[level] !== "provider-default"),
  };
}
