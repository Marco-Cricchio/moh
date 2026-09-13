/**
 * MPM user controls and per-project override (ADR-0026).
 *
 * Two configuration sources: the **user** owns the global default
 * (`mpm` in `~/.moh/config`, default **disabled** — MPM is opt-in);
 * the **project** (moh.json `mpm`) is an explicit per-project override
 * in either direction: an explicit project `enabled` wins over the user
 * default (ADR-0026 reversed #618's restrict-only rule). Quotas take
 * the strictest field; exclusions union. No source content is ever
 * named here: only patterns, budgets, and an on/off decision.
 */
import { z } from "zod";
import { MPM_DEFAULT_MAX_FILES, MPM_DEFAULT_MAX_TOTAL_BYTES, type MpmQuota } from "./service";
import { readUserConfigFile, userConfigFile } from "../user-config";

/**
 * Extra workspace exclusions, gitignore-style patterns matched from the
 * root (MPM never accepts negations — the hard denylist is not rescuable).
 */
export const mpmQuotaSchema = z
  .object({
    maxFiles: z.number().int().min(0).optional(),
    maxTotalBytes: z.number().int().min(0).optional(),
  })
  .optional();

/**
 * Project-side moh.json `mpm` section: an explicit per-project override.
 * `enabled: true` opts this project in (over a global default off);
 * `enabled: false` opts it out (over a global opt-in). Absent = inherit
 * the user default (ADR-0026).
 */
export const mpmProjectConfigSchema = z.object({
  enabled: z.boolean().optional(),
  quota: mpmQuotaSchema,
  exclude: z.array(z.string().min(1)).optional(),
});

export type MpmProjectConfig = z.infer<typeof mpmProjectConfigSchema>;

/** User-side `mpm` section of `~/.moh/config`. */
export interface MpmUserConfig {
  enabled?: boolean;
  quota?: MpmQuota;
  exclude?: string[];
}

/** The effective configuration one project runs under. */
export interface MpmEffectiveConfig {
  enabled: boolean;
  quota: MpmQuota;
  exclude: string[];
  /** Why MPM is off, when it is. Diagnostics only; never prompt content. */
  disabledReason: null | "user" | "project";
}

/**
 * Resolve the effective MPM config for one project (ADR-0026). An explicit
 * project `enabled` (either value) overrides the user default; absent
 * project section = inherit. The global default is disabled — MPM is
 * opt-in. Quotas are the strictest (minimum) per field; exclusions union.
 * Malformed user values degrade to the defaults — the user config is
 * chrome and never hard-fails a session; a malformed project section is
 * caught earlier by moh.json's strict parse.
 */
export function resolveMpmConfig(user: MpmUserConfig, project?: MpmProjectConfig): MpmEffectiveConfig {
  // Explicit project override wins in both directions (ADR-0026).
  if (project?.enabled === true) {
    return {
      enabled: true,
      quota: {
        maxFiles: strictest(user.quota?.maxFiles, project?.quota?.maxFiles),
        maxTotalBytes: strictest(user.quota?.maxTotalBytes, project?.quota?.maxTotalBytes),
      },
      exclude: [...new Set([...(user.exclude ?? []), ...(project?.exclude ?? [])])],
      disabledReason: null,
    };
  }
  if (project?.enabled === false) {
    return { enabled: false, quota: {}, exclude: [], disabledReason: "project" };
  }
  // Inherit: the user default (disabled when absent — MPM is opt-in).
  if (user.enabled !== true) {
    return { enabled: false, quota: {}, exclude: [], disabledReason: "user" };
  }
  return {
    enabled: true,
    quota: {
      maxFiles: strictest(user.quota?.maxFiles, project?.quota?.maxFiles),
      maxTotalBytes: strictest(user.quota?.maxTotalBytes, project?.quota?.maxTotalBytes),
    },
    exclude: [...new Set([...(user.exclude ?? []), ...(project?.exclude ?? [])])],
    disabledReason: null,
  };
}

/** The smaller positive value wins; absent (undefined) loses to any value. */
function strictest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * Read the user-side `mpm` section from `~/.moh/config` (tolerant: missing,
 * corrupt, or malformed values all read as the permissive default and are
 * repaired on the next guardian write).
 */
export function readMpmUserConfig(file = userConfigFile()): MpmUserConfig {
  const data = readUserConfigFile(file);
  const raw = data.mpm;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const section = raw as Record<string, unknown>;
  const config: MpmUserConfig = {};
  if (typeof section.enabled === "boolean") config.enabled = section.enabled;
  if (typeof section.quota === "object" && section.quota !== null && !Array.isArray(section.quota)) {
    const quota = section.quota as Record<string, unknown>;
    const parsed: MpmQuota = {};
    if (typeof quota.maxFiles === "number" && Number.isInteger(quota.maxFiles) && quota.maxFiles >= 0) {
      parsed.maxFiles = quota.maxFiles;
    }
    if (typeof quota.maxTotalBytes === "number" && Number.isInteger(quota.maxTotalBytes) && quota.maxTotalBytes >= 0) {
      parsed.maxTotalBytes = quota.maxTotalBytes;
    }
    if (parsed.maxFiles !== undefined || parsed.maxTotalBytes !== undefined) config.quota = parsed;
  }
  if (Array.isArray(section.exclude)) {
    const exclude = section.exclude.filter((p): p is string => typeof p === "string" && p.length > 0);
    if (exclude.length > 0) config.exclude = exclude;
  }
  return config;
}

/** The defaults the projection runs under when no config narrows them. */
export function mpmDefaultQuota(): Required<MpmQuota> {
  return { maxFiles: MPM_DEFAULT_MAX_FILES, maxTotalBytes: MPM_DEFAULT_MAX_TOTAL_BYTES };
}
