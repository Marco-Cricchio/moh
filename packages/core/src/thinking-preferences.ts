/**
 * Thinking-level capabilities and endpoint preferences (#241, spec
 * `docs/spec/provider-reasoning-thinking-controls.md` decisions 8/10).
 *
 * Two halves, both provider-neutral core data for the clients:
 *
 * - **Capability reporting** from the vendored catalog: the canonical
 *   level set, the per-model `thinkingLevelMap` states (supported /
 *   disabled / provider-default) and the medium-else-provider-default
 *   new-endpoint default. moh never silently remaps: an unavailable
 *   canonical level resolves to "send nothing" (provider default).
 * - **Endpoint-scoped user preferences** in the guardian-owned
 *   `~/.moh/config` (`thinkingLevels` section, schema owned here per
 *   ADR-0006): the durable, immediately-persisted level per endpoint.
 *   Project `moh.json` is never touched; unrelated user config always
 *   survives through the guardian's read-modify-write.
 */
import { readFileSync } from "node:fs";
import { catalogEntryFor, subscriptionModelCatalog, type CatalogModel } from "./model-catalog";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "./types";
import { readUserConfigFile, updateUserConfigFile, type UserConfigIo } from "./user-config";

export { THINKING_LEVELS };

/** What a canonical level means for one model (#241). */
export type ThinkingLevelState =
  /** The map carries a provider-native expression: selectable, sends it. */
  | "supported"
  /** The map carries an explicit provider-native disable (`null`): the
   * level is selectable but turns thinking off (e.g. `off`). */
  | "disabled"
  /** The map has no entry for the level: not selectable; requesting it
   * anyway resolves to the provider default, never a remap. */
  | "provider-default";

/**
 * Per-level states for one model's declared map — the data a picker
 * needs to show, enable, or disable-and-explain each canonical entry.
 * `undefined` when the model declares no map (no entry, openai-compat,
 * custom): level selection is not offered at all (#239 decision 10).
 */
export function thinkingLevelStates(
  model: CatalogModel | undefined,
): Record<ThinkingLevel, ThinkingLevelState> | undefined {
  const map = model?.thinkingLevelMap;
  if (!map) return undefined;
  const out = {} as Record<ThinkingLevel, ThinkingLevelState>;
  for (const level of THINKING_LEVELS) {
    const native = map[level];
    out[level] = native === undefined ? "provider-default" : native === null ? "disabled" : "supported";
  }
  return out;
}

/**
 * The default level for a new endpoint (#239 decision 8): `medium` when
 * the model supports it; otherwise `undefined` = provider default (moh
 * sends no thinking request and audits no level).
 */
export function defaultThinkingLevel(model: CatalogModel | undefined): ThinkingLevel | undefined {
  const states = thinkingLevelStates(model);
  if (!states) return undefined;
  return states.medium === "supported" ? "medium" : undefined;
}

/**
 * The effective level for one model call (#239 decision 9): model
 * switches and fallback targets each resolve their own call. A
 * preference is honored only when the model's map declares it
 * (supported or explicitly disabled); an unsupported preference is
 * never remapped — the call falls to the provider default. No
 * preference → the model default. Always `undefined` when the model
 * declares no map.
 */
export function effectiveThinkingLevel(
  model: CatalogModel | undefined,
  preference: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  const states = thinkingLevelStates(model);
  if (!states) return undefined;
  if (preference !== undefined) {
    return states[preference] === "provider-default" ? undefined : preference;
  }
  return defaultThinkingLevel(model);
}

/** The `thinkingLevels` section of `~/.moh/config`: endpoint name → level. */
export type ThinkingPreferences = Record<string, ThinkingLevel>;

function readSection(file: string, read?: (file: string) => string): ThinkingPreferences {
  const data = readUserConfigFile(file, read);
  const raw = data.thinkingLevels;
  if (raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return {};
  // Tolerant per-entry read: an invalid stored value reads as absent —
  // a hand-edited preference never fails a session. Valid siblings survive.
  const out: ThinkingPreferences = {};
  for (const [endpoint, level] of Object.entries(raw as Record<string, unknown>)) {
    if (isThinkingLevel(level)) out[endpoint] = level;
  }
  return out;
}

/** The stored preference for one endpoint, or undefined when none. */
export function readThinkingPreference(
  file: string,
  endpoint: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): ThinkingLevel | undefined {
  return readSection(file, read)[endpoint];
}

/** The whole stored section (e.g. for the settings panel). */
export function readThinkingPreferences(
  file: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): ThinkingPreferences {
  return readSection(file, read);
}

/** Persists one endpoint's level immediately through the guardian;
 * unrelated user config survives and moh.json is never touched. */
export function setThinkingPreference(
  file: string,
  endpoint: string,
  level: ThinkingLevel,
  io: UserConfigIo = {},
): void {
  if (!isThinkingLevel(level)) {
    throw new Error(`invalid thinking level "${String(level)}"; canonical levels: ${THINKING_LEVELS.join(", ")}`);
  }
  updateUserConfigFile(file, (data) => {
    const existing = readSection(file, io.read);
    existing[endpoint] = level;
    data.thinkingLevels = existing;
  }, io);
}

/** Drops one endpoint's preference through the guardian; no-op when absent. */
export function clearThinkingPreference(file: string, endpoint: string, io: UserConfigIo = {}): void {
  updateUserConfigFile(file, (data) => {
    if (data.thinkingLevels === undefined) return;
    const existing = readSection(file, io.read);
    if (!(endpoint in existing)) return;
    delete existing[endpoint];
    if (Object.keys(existing).length === 0) delete data.thinkingLevels;
    else data.thinkingLevels = existing;
  }, io);
}

export { catalogEntryFor, subscriptionModelCatalog };
