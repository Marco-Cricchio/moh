/**
 * MPM user controls and project restrictions (#618, spec #613).
 *
 * Two configuration sources, one precedence rule: the **user** owns the
 * default (`mpm` in `~/.moh/config`); the **project** (moh.json `mpm`)
 * may only restrict or disable — it can never force MPM on against a
 * user disablement. Quotas and exclusions intersect (the stricter value
 * wins; exclusions union). No source content is ever named here: only
 * patterns, budgets, and an on/off decision.
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

/** Project-side moh.json `mpm` section: restrict or disable, nothing else. */
export const mpmProjectConfigSchema = z.object({
  /** Only an explicit disablement is expressible — never a force-on. */
  enabled: z.literal(false).optional(),
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
 * Resolve the effective MPM config for one project. User disablement wins
 * over everything (the project cannot force MPM on); when the user allows,
 * the project may still disable or tighten. Quotas are the strictest
 * (minimum) per field; exclusions union. Malformed user values degrade to
 * the defaults — the user config is chrome and never hard-fails a session;
 * a malformed project section is caught earlier by moh.json's strict parse.
 */
export function resolveMpmConfig(user: MpmUserConfig, project?: MpmProjectConfig): MpmEffectiveConfig {
  if (user.enabled === false) {
    return { enabled: false, quota: {}, exclude: [], disabledReason: "user" };
  }
  if (project?.enabled === false) {
    return { enabled: false, quota: {}, exclude: [], disabledReason: "project" };
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
