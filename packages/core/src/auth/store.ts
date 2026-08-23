/**
 * Token persistence for the `auth` section of `~/.moh/config` (issue
 * #132, ADR-0006). All writes go through the user-config guardian
 * (read-modify-write, temp-file + rename, 0600/0700, unrelated keys
 * survive). The `auth` section is never a merge candidate: the #129
 * provider merge reads only `provider`/`endpoints` and must never see it.
 */
import { readFileSync } from "node:fs";
import { authSectionSchema, type AuthSection, type AuthToken } from "./types";
import { readUserConfigFile, updateUserConfigFile, type UserConfigIo } from "../user-config";

/**
 * Reads the `auth` section's tokens. Tolerant like the guardian: a file
 * without the section (or a corrupt file) reads as `{}`. An invalid
 * present section throws — token state must not fail silently.
 */
export function readStoredTokens(
  file: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): Record<string, AuthToken> {
  return readAuthSection(file, read).tokens;
}

/**
 * The whole parsed `auth` section: tokens plus provider overrides.
 * Same tolerance/strictness rules as {@link readStoredTokens}.
 */
export function readAuthSection(
  file: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): AuthSection {
  const data = readUserConfigFile(file, read);
  if (data.auth === undefined) return { tokens: {} };
  const parsed = authSectionSchema.safeParse(data.auth);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid ${file} auth section: ${issues}`);
  }
  return parsed.data;
}

/** Tokens for one endpoint, or undefined when none are stored. */
export function getStoredToken(
  file: string,
  endpoint: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): AuthToken | undefined {
  return readStoredTokens(file, read)[endpoint];
}

/** Saves/replaces one endpoint's tokens through the guardian. */
export function saveTokens(
  file: string,
  endpoint: string,
  token: AuthToken,
  io: UserConfigIo = {},
): void {
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
    io,
  );
}

/** Drops one endpoint's tokens through the guardian. No-op when absent. */
export function clearTokens(file: string, endpoint: string, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      if (data.auth === undefined || typeof data.auth !== "object") return;
      const existing = data.auth as { tokens?: Record<string, AuthToken> };
      const tokens = { ...(existing.tokens ?? {}) };
      delete tokens[endpoint];
      data.auth = { ...(data.auth as Record<string, unknown>), tokens };
    },
    io,
  );
}
