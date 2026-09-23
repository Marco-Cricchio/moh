/**
 * User-level provider config layered over project moh.json (issue #129).
 *
 * The `provider` and `endpoints` sections may live in the user config
 * (`~/.moh/config`, owned by the guardian, ADR-0006) as well as in the
 * project `moh.json`. This module is the single merge seam (decision 5):
 * session assembly, the TUI display path, and the add-provider wizard all
 * read providers through `loadMergedConfig` / `mergeProviderConfigs`.
 *
 * Semantics (owner-approved, see issue #129):
 * - endpoints merge by `name`, per-field with inheritance: a project
 *   endpoint wins field-by-field; fields absent there inherit from the
 *   user-level one;
 * - a name collision with a different endpoint identity (issue #695) is
 *   refused loudly: a project endpoint whose `type` or `baseUrl` differs
 *   from the user-level endpoint of the same name makes the merge throw,
 *   naming the conflicting endpoint — otherwise the user's stored
 *   credentials would resolve onto the project-supplied endpoint and be
 *   sent to its baseUrl. A collision with a matching identity merges as
 *   before.
 * - precedence for an endpoint key: env var (`MOH_ENDPOINT_<NAME>_API_KEY`)
 *   > project moh.json > user config; same order for the default
 *   `provider` reference (default "mock" stays the zero-config floor);
 * - the user `provider`/`endpoints` sections are validated strictly when
 *   present (a broken section fails loudly at session start); the rest of
 *   the file stays tolerant/preservative per the guardian design.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { endpointProfileSchema, loadMohConfig, upsertEndpoint, type EndpointProfile, type MohConfig } from "./config";
import { envApiKey } from "./route";
import { readUserConfigFile, updateUserConfigFile, userConfigFile, type UserConfigData, type UserConfigIo } from "./user-config";
import { z } from "zod";

/** The provider-relevant sections of `~/.moh/config`. */
export interface UserProviderConfig {
  provider?: string;
  endpoints?: EndpointProfile[];
}

const userProviderSectionSchema = z
  .object({
    provider: z.string().optional(),
    endpoints: z.array(endpointProfileSchema).optional(),
  })
  .strict();

/**
 * Reads the `provider`/`endpoints` sections of a user config file.
 * Strict when the sections are present: an invalid one throws (session
 * start must fail loudly, decision 6). A file without them — including a
 * corrupt whole file (guardian tolerance for chrome) — reads as empty.
 */
export function readUserProviderConfig(
  file: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): UserProviderConfig {
  const data: UserConfigData = readUserConfigFile(file, read);
  if (data.provider === undefined && data.endpoints === undefined) return {};
  const parsed = userProviderSectionSchema.safeParse({ provider: data.provider, endpoints: data.endpoints });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid ${file} provider/endpoints section: ${issues}`);
  }
  return parsed.data;
}


function definedFields<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** One endpoint merged per-field: project fields win, absent fields inherit from user. */
function mergeEndpoint(project: EndpointProfile, user: EndpointProfile | undefined): EndpointProfile {
  if (!user) return project;
  const capabilities = mergeCapabilities(user, project);
  return { ...user, ...definedFields(project), ...(capabilities !== undefined ? { capabilities } : {}) };
}

function mergeCapabilities(user: EndpointProfile, project: EndpointProfile): EndpointProfile["capabilities"] {
  if (user.capabilities === undefined && project.capabilities === undefined) return undefined;
  return { ...user.capabilities, ...project.capabilities };
}

/** Decision 3: an env-var key beats both files — project and user-only endpoints alike. */
function withEnvKey(endpoint: EndpointProfile, env: Record<string, string | undefined>): EndpointProfile {
  const envKey = envApiKey(endpoint.name, env);
  return envKey !== undefined ? { ...endpoint, apiKey: envKey } : endpoint;
}

/**
 * Merges the user-level provider config over/under a project config.
 * Only `provider` and `endpoints` merge; every other section stays
 * project-only. Endpoint keys resolve as env > project > user (decision 3).
 */
export function mergeProviderConfigs(
  project: MohConfig,
  user: UserProviderConfig,
  env: Record<string, string | undefined> = process.env,
): MohConfig {
  const byName = new Map((user.endpoints ?? []).map((e) => [e.name, e]));
  const projectEndpoints = project.endpoints ?? [];
  for (const e of projectEndpoints) {
    const userEndpoint = byName.get(e.name);
    if (userEndpoint && (userEndpoint.type !== e.type || (userEndpoint.baseUrl ?? undefined) !== (e.baseUrl ?? undefined))) {
      throw new Error(
        `endpoint name collision: project moh.json endpoint "${e.name}" (type "${e.type}", baseUrl ${e.baseUrl ? `"${e.baseUrl}"` : "unset"}) ` +
          `conflicts with the user-level endpoint of the same name (type "${userEndpoint.type}", baseUrl ${userEndpoint.baseUrl ? `"${userEndpoint.baseUrl}"` : "unset"}); ` +
          `refusing to merge because user-stored credentials resolve by name — rename one of the two endpoints`,
      );
    }
  }
  const merged = projectEndpoints.map((e) => {
    const perField = mergeEndpoint(e, byName.get(e.name));
    byName.delete(e.name);
    return withEnvKey(perField, env);
  });
  const endpoints = [...merged, ...[...byName.values()].map((e) => withEnvKey(e, env))];
  const provider = project.provider ?? user.provider;
  return {
    ...project,
    ...(provider !== undefined ? { provider } : {}),
    ...(endpoints.length ? { endpoints } : {}),
  };
}

export interface MergedConfigOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  read?: (file: string) => string;
}

/**
 * The single read seam (decision 5): project moh.json + user provider
 * sections, merged. Throws on an invalid project moh.json or an invalid
 * user `provider`/`endpoints` section.
 */
export function loadMergedConfig(cwd: string, options: MergedConfigOptions = {}): MohConfig {
  const project = loadMohConfig(join(cwd, "moh.json"), options.read);
  const user = readUserProviderConfig(userConfigFile(options.home), options.read);
  return mergeProviderConfigs(project, user, options.env ?? process.env);
}

/**
 * Adds or replaces a user-level endpoint profile by name, through the
 * config guardian: unrelated keys and unknown sections survive (ADR-0006).
 */
export function upsertUserEndpoint(file: string, profile: EndpointProfile, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      const current = Array.isArray(data.endpoints) ? data.endpoints : [];
      data.endpoints = upsertEndpoint({ endpoints: current as EndpointProfile[] }, profile).endpoints;
    },
    io,
  );
}

/** Sets the user-level default provider reference through the guardian. */
export function saveUserProviderRef(file: string, ref: string, io: UserConfigIo = {}): void {
  updateUserConfigFile(file, (data) => void (data.provider = ref), io);
}

/**
 * Sets (or clears, with `null`) the preferred model of a user-level
 * endpoint — the `defaultModel` field, which is also the model that
 * endpoint serves when it is an automatic fallback stop (ADR-0012). The
 * endpoint's other fields, unrelated keys and unknown sections survive.
 *
 * Throws when the endpoint is not declared in the user config: this writes
 * to one named profile, and silently creating one would invent a provider
 * the user never configured. Clearing a model that is already absent is a
 * no-op (nothing to remove).
 */
export function setUserEndpointModel(
  file: string,
  name: string,
  modelId: string | null,
  io: UserConfigIo = {},
): void {
  let found = false;
  updateUserConfigFile(
    file,
    (data) => {
      if (!Array.isArray(data.endpoints)) return;
      data.endpoints = data.endpoints.map((entry) => {
        const e = entry as EndpointProfile;
        if (e?.name !== name) return entry;
        found = true;
        if (modelId === null) {
          const { defaultModel: _dropped, ...rest } = e;
          return rest;
        }
        return { ...e, defaultModel: modelId };
      });
    },
    io,
  );
  if (!found) {
    throw new Error(`no user-level endpoint "${name}" in ${file}; add it before setting a preferred model`);
  }
}

/**
 * Excludes (or re-includes) a user-level endpoint in the automatic fallback
 * chain — the `fallbackEligible` flag, default `true` (ADR-0012). This is
 * the whole-provider switch, independent of the preferred model: an
 * endpoint can keep its model and still be kept out of the chain.
 *
 * Re-including REMOVES the field rather than writing `true`, so a config
 * never accumulates redundant keys. Throws for an endpoint the user config
 * does not declare, like `setUserEndpointModel` — the UI always operates on
 * a provider that exists.
 */
export function setUserEndpointFallbackEligible(
  file: string,
  name: string,
  eligible: boolean,
  io: UserConfigIo = {},
): void {
  let found = false;
  updateUserConfigFile(
    file,
    (data) => {
      if (!Array.isArray(data.endpoints)) return;
      data.endpoints = data.endpoints.map((entry) => {
        const e = entry as EndpointProfile;
        if (e?.name !== name) return entry;
        found = true;
        if (eligible) {
          const { fallbackEligible: _dropped, ...rest } = e;
          return rest;
        }
        return { ...e, fallbackEligible: false };
      });
    },
    io,
  );
  if (!found) {
    throw new Error(`no user-level endpoint "${name}" in ${file}; add it before excluding it from the chain`);
  }
}

/** Removes a user-level endpoint profile by name, through the guardian. */
export function removeUserEndpoint(file: string, name: string, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      if (!Array.isArray(data.endpoints)) return;
      data.endpoints = data.endpoints.filter((e) => (e as { name?: unknown }).name !== name);
    },
    io,
  );
}
