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
import { catalogEntryFor, type CatalogModel } from "./model-catalog";
import { isThinkingLevel, THINKING_FORMATS, THINKING_LEVELS, type ThinkingFormat, type ThinkingLevel } from "./types";
import { readUserConfigFile, updateUserConfigFile, type UserConfigIo } from "./user-config";

export { THINKING_LEVELS };

/** #256: a configuration-declared thinking capability (the schema lives
 * in config.ts; this is the core-side shape the capability calculation
 * reads). */
export interface ThinkingDeclaration {
  format: ThinkingFormat;
  levels: ThinkingLevel[];
}

export interface ThinkingModelDeclaration {
  format?: ThinkingFormat;
  levels: ThinkingLevel[];
}

/** The endpoint shape the capability calculation needs (#256): name,
 * provider type, and any declared thinking capabilities. `EndpointProfile`
 * satisfies this structurally. */
export interface ThinkingEndpoint {
  name: string;
  type: string;
  capabilities?: {
    thinking?: ThinkingDeclaration;
    thinkingModels?: Record<string, ThinkingModelDeclaration>;
  };
}

/** #256: canonical levels each declared format can actually express on
 * its wire — the single table `thinkingForWire` consults too (the google
 * xhigh/max drop lives here, once). */
export const FORMAT_EXPRESSIBLE_LEVELS: Record<ThinkingFormat, readonly ThinkingLevel[]> = {
  "openai-effort": THINKING_LEVELS,
  "openrouter-effort": THINKING_LEVELS,
  "anthropic-effort": THINKING_LEVELS,
  "google-thinking-level": ["off", "low", "medium", "high"],
};

/** #256: states from a declared capability — offered exactly where the
 * declaration lists the level AND the format's wire can express it.
 * Deliberate narrowing: config declarations have no `null` semantics,
 * so the supported/disabled distinction of catalog maps collapses to
 * supported vs provider-default here. */
function declaredStates(declaration: ThinkingDeclaration): Record<ThinkingLevel, ThinkingLevelState> {
  const expressible = FORMAT_EXPRESSIBLE_LEVELS[declaration.format];
  const out = {} as Record<ThinkingLevel, ThinkingLevelState>;
  for (const level of THINKING_LEVELS) {
    out[level] = declaration.levels.includes(level) && expressible.includes(level) ? "supported" : "provider-default";
  }
  return out;
}

/** #256: the one capability calculation (per model ref). Resolution
 * chain: per-model config declaration > endpoint-level declaration >
 * normalized catalog map > none (`undefined` — level selection not
 * offered). Capability is declared (catalog or config), never inferred
 * from `reasoning` alone. A per-model entry whose format cannot be
 * resolved (no own format, no endpoint-level declaration) is inert —
 * the chain falls through to the catalog map (pinned by test). */
export function thinkingStatesForRef(
  ref: string,
  endpoints: ReadonlyArray<ThinkingEndpoint>,
): Record<ThinkingLevel, ThinkingLevelState> | undefined {
  const slash = ref.indexOf("/");
  if (slash === -1) return undefined;
  const endpointName = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const endpoint = endpoints.find((e) => e.name === endpointName);
  if (!endpoint) return undefined;
  const perModel = endpoint.capabilities?.thinkingModels?.[modelId];
  const endpointLevel = endpoint.capabilities?.thinking;
  if (perModel) {
    const format = perModel.format ?? endpointLevel?.format;
    if (format) return declaredStates({ format, levels: perModel.levels });
  }
  if (endpointLevel) return declaredStates(endpointLevel);
  return thinkingLevelStates(catalogEntryFor(endpoint.type, modelId));
}

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

/** #256: shared default rule (#239 decision 8, unchanged): `medium`
 * when supported, else `undefined` = provider default. */
function defaultForStates(states: Record<ThinkingLevel, ThinkingLevelState>): ThinkingLevel | undefined {
  return states.medium === "supported" ? "medium" : undefined;
}

/** #256: shared effective rule (#239 decision 9): honor the preference
 * only where offered; an unsupported preference is never remapped — the
 * call falls to the provider default. */
function effectiveForStates(
  states: Record<ThinkingLevel, ThinkingLevelState>,
  preference: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (preference !== undefined) {
    return states[preference] === "provider-default" ? undefined : preference;
  }
  return defaultForStates(states);
}

export function defaultThinkingLevel(model: CatalogModel | undefined): ThinkingLevel | undefined {
  const states = thinkingLevelStates(model);
  if (!states) return undefined;
  return defaultForStates(states);
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
  return effectiveForStates(states, preference);
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

/** The raw `thinkingLevels` section as a plain object, or undefined when
 * absent/not an object. (`typeof null === "object"` — hence the null check.) */
function asSection(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/** Persists one endpoint's level immediately through the guardian;
 * unrelated user config survives and moh.json is never touched. The
 * mutation reads `data` (the guardian's own read-modify-write view), not
 * the disk, so a mocked `io.read` can never fork the two. Invalid
 * hand-written sibling entries are preserved verbatim — reads filter
 * them, writes must not silently "fix" the file. */
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
    const existing = { ...(asSection(data.thinkingLevels) ?? {}) };
    existing[endpoint] = level;
    data.thinkingLevels = existing;
  }, io);
}

/** Drops one endpoint's preference through the guardian; no-op when
 * absent. Checks the raw section, so clearing an invalid hand-written
 * entry removes it instead of being filtered into a no-op. */
export function clearThinkingPreference(file: string, endpoint: string, io: UserConfigIo = {}): void {
  updateUserConfigFile(file, (data) => {
    const existing = asSection(data.thinkingLevels);
    if (!existing || !(endpoint in existing)) return;
    const next = { ...existing };
    delete next[endpoint];
    if (Object.keys(next).length === 0) delete data.thinkingLevels;
    else data.thinkingLevels = next;
  }, io);
}


/**
 * The per-call thinking request for the *active* provider ref (#242):
 * `endpoint/model-id` resolved against the session's merged endpoint
 * profiles and the vendored catalog, honoring the endpoint's stored
 * preference. Re-read per call so a persisted preference change is
 * effective on the very next call. `undefined` = send nothing (custom
 * profiles and the unified capability calculation (#256: per-model
 * config declaration > endpoint-level declaration > normalized catalog
 * map), honoring the endpoint's stored preference. Re-read per call so
 * a persisted preference change is effective on the very next call.
 * `undefined` = send nothing (custom providers, no declared capability,
 * or a preference not offered — never a silent remap).
 */
/** #256: `endpoint/model-id` split — undefined when the ref is not a
 * two-part route reference. Shared by the per-call and status seams. */
function splitRef(ref: string): { endpointName: string } | undefined {
  const slash = ref.indexOf("/");
  return slash === -1 ? undefined : { endpointName: ref.slice(0, slash) };
}

export function resolveEndpointThinking(
  ref: string,
  endpoints: ReadonlyArray<ThinkingEndpoint>,
  userConfig: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): { level: ThinkingLevel } | undefined {
  const parts = splitRef(ref);
  if (!parts) return undefined;
  const states = thinkingStatesForRef(ref, endpoints);
  if (!states) return undefined;
  const level = effectiveForStates(states, readThinkingPreference(userConfig, parts.endpointName, read));
  return level === undefined ? undefined : { level };
}

/** #256: status resolution for display — the effective level plus the
 * unsupported-preference marker ("provider default (preference X
 * unsupported)" sources). The stored preference is never dropped; only
 * the call-time resolution decides what to send. */
export function endpointThinkingStatus(
  ref: string,
  endpoints: ReadonlyArray<ThinkingEndpoint>,
  userConfig: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): { level?: ThinkingLevel; unsupported?: ThinkingLevel } {
  const parts = splitRef(ref);
  if (!parts) return {};
  const states = thinkingStatesForRef(ref, endpoints);
  const preference = readThinkingPreference(userConfig, parts.endpointName, read);
  if (!states) return { ...(preference ? { unsupported: preference } : {}) };
  const level = effectiveForStates(states, preference);
  const unsupported = preference !== undefined && states[preference] === "provider-default" ? preference : undefined;
  return level === undefined ? { ...(unsupported ? { unsupported } : {}) } : { level, ...(unsupported ? { unsupported } : {}) };
}
