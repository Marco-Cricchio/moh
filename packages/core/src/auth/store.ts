/**
 * Token persistence for the `auth` section of `~/.moh/config` (issue
 * #132, ADR-0006). All writes go through the user-config guardian
 * (read-modify-write, temp-file + rename, 0600/0700, unrelated keys
 * survive). The `auth` section is never a merge candidate: the #129
 * provider merge reads only `provider`/`endpoints` and must never see it.
 */
import { authSectionSchema, type AuthSection, type AuthToken, type StoredApiKeyOrigin } from "./types";
import { readUserConfigFile, updateUserConfigFile } from "../user-config";

/**
 * Reads the `auth` section's tokens. Tolerant like the guardian: a file
 * without the section (or a corrupt file) reads as `{}`. An invalid
 * present section throws — token state must not fail silently.
 */
export function readStoredTokens(file: string): Record<string, AuthToken> {
  return readAuthSection(file).tokens;
}

/**
 * The whole parsed `auth` section: tokens plus provider overrides.
 * Same tolerance/strictness rules as {@link readStoredTokens}.
 */
export function readAuthSection(file: string): AuthSection {
  const data = readUserConfigFile(file);
  if (data.auth === undefined) return { tokens: {} };
  const parsed = authSectionSchema.safeParse(data.auth);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid ${file} auth section: ${issues}`);
  }
  return { ...parsed.data, apiKeys: parsed.data.apiKeys ?? {} };
}

/** Tokens for one endpoint, or undefined when none are stored. */
export function getStoredToken(file: string, endpoint: string): AuthToken | undefined {
  return readStoredTokens(file)[endpoint];
}

/** Saves/replaces one endpoint's tokens through the guardian. */
export function saveTokens(file: string, endpoint: string, token: AuthToken): void {
  updateUserConfigFile(
    file,
    (data) => {
      const existing = authSectionSchema.safeParse(data.auth ?? { tokens: {} });
      if (!existing.success) {
        throw new Error(`invalid ${file} auth section; fix or remove it before saving tokens`);
      }
      const tokens = existing.data.tokens;
      tokens[endpoint] = token;
      data.auth = { ...(data.auth as Record<string, unknown>), tokens };
    },
  );
}

/** Drops one endpoint's tokens through the guardian. No-op when absent. */
export function clearTokens(file: string, endpoint: string): void {
  updateUserConfigFile(
    file,
    (data) => {
      if (data.auth === undefined || data.auth === null || typeof data.auth !== "object") return;
      const existing = data.auth as { tokens?: Record<string, AuthToken> };
      const tokens = { ...(existing.tokens ?? {}) };
      delete tokens[endpoint];
      data.auth = { ...(data.auth as Record<string, unknown>), tokens };
    },
  );
}

/** SEC-06: reads an api key the wizard stored for one endpoint. */
export function getStoredApiKey(file: string, endpoint: string): string | undefined {
  return readAuthSection(file).apiKeys?.[endpoint];
}

/** #1256: the endpoint identity a stored key was saved for, or undefined
 * when the key is absent or was stored before origins existed (unbound). */
export function getStoredApiKeyOrigin(file: string, endpoint: string): StoredApiKeyOrigin | undefined {
  return readAuthSection(file).apiKeyOrigins?.[endpoint];
}

/** SEC-06: stores/replaces one endpoint's api key in the auth store. When
 * `origin` is given the key is bound to that endpoint identity (#1256);
 * replacing a key without an origin drops any stale binding — a key must
 * never keep pointing at an endpoint it was not saved for. */
export function saveStoredApiKey(
  file: string,
  endpoint: string,
  key: string,
  origin?: StoredApiKeyOrigin,
): void {
  updateUserConfigFile(
    file,
    (data) => {
      if (data.auth === undefined || data.auth === null || typeof data.auth !== "object") data.auth = { tokens: {} };
      const auth = data.auth as { tokens?: unknown; apiKeys?: Record<string, string>; apiKeyOrigins?: Record<string, StoredApiKeyOrigin> };
      const origins = { ...(auth.apiKeyOrigins ?? {}) };
      if (origin) origins[endpoint] = origin;
      else delete origins[endpoint];
      data.auth = {
        ...auth,
        apiKeys: { ...(auth.apiKeys ?? {}), [endpoint]: key },
        apiKeyOrigins: origins,
      };
    },
  );
}

/** #1256: binds an already-stored key to the endpoint identity the flow
 * just confirmed (the wizard learns the base URL after storing the key).
 * No-op when no key is stored for the endpoint — binding nothing is
 * meaningless. */
export function bindStoredApiKeyOrigin(
  file: string,
  endpoint: string,
  origin: StoredApiKeyOrigin,
): void {
  updateUserConfigFile(
    file,
    (data) => {
      const auth = data.auth as { apiKeys?: Record<string, string>; apiKeyOrigins?: Record<string, StoredApiKeyOrigin> } | undefined;
      if (auth?.apiKeys?.[endpoint] === undefined) return;
      data.auth = { ...auth, apiKeyOrigins: { ...(auth.apiKeyOrigins ?? {}), [endpoint]: origin } };
    },
  );
}

/** SEC-06: drops one endpoint's stored api key — and its #1256 origin
 * binding — through the guardian. No-op when absent. */
export function clearStoredApiKey(file: string, endpoint: string): void {
  updateUserConfigFile(
    file,
    (data) => {
      if (data.auth === undefined || data.auth === null || typeof data.auth !== "object") return;
      const auth = data.auth as { apiKeys?: Record<string, string>; apiKeyOrigins?: Record<string, StoredApiKeyOrigin> };
      const apiKeys = { ...(auth.apiKeys ?? {}) };
      delete apiKeys[endpoint];
      const origins = { ...(auth.apiKeyOrigins ?? {}) };
      delete origins[endpoint];
      data.auth = { ...(data.auth as Record<string, unknown>), apiKeys, apiKeyOrigins: origins };
    },
  );
}
