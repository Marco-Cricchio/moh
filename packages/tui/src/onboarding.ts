/**
 * Hybrid provider onboarding logic (issue #33): env-var auto-detect +
 * one-step confirm, full wizard fallback. Pure seam — the Ink overlay
 * (Onboarding.tsx) renders these results and calls these savers.
 */
import {
  loadMohConfig,
  upsertEndpoint,
  writeMohConfig,
  readUserProviderConfig,
  saveUserProviderRef,
  upsertUserEndpoint,
  userConfigFile,
  type EndpointProfile,
  type MohConfig,
} from "@moh/core";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type DetectableProviderType = "anthropic" | "openai" | "google";

/** Well-known env vars per provider, in preference order. */
const ENV_VARS: ReadonlyArray<{ type: DetectableProviderType; envVar: string }> = [
  { type: "anthropic", envVar: "ANTHROPIC_API_KEY" },
  { type: "openai", envVar: "OPENAI_API_KEY" },
  { type: "google", envVar: "GEMINI_API_KEY" },
  { type: "google", envVar: "GOOGLE_API_KEY" },
];

/** Suggested default model per detected provider. */
export const DEFAULT_MODELS: Record<DetectableProviderType, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5",
  google: "gemini-2.5-flash",
};

export interface EnvCandidate {
  type: DetectableProviderType;
  envVar: string;
  defaultModel: string;
}

/**
 * Finds configured credentials in the environment. One candidate per
 * provider type (first env var wins); the key itself is never read out —
 * only its presence matters.
 */
export function detectEnvProviders(env: Record<string, string | undefined> = process.env): EnvCandidate[] {
  const seen = new Set<DetectableProviderType>();
  const out: EnvCandidate[] = [];
  for (const { type, envVar } of ENV_VARS) {
    if (seen.has(type)) continue;
    if (env[envVar] && env[envVar]!.trim() !== "") {
      seen.add(type);
      out.push({ type, envVar, defaultModel: DEFAULT_MODELS[type]! });
    }
  }
  return out;
}

/**
 * Persists a detected provider as a moh.json endpoint + default provider
 * reference. No inline `apiKey`: the endpoint keeps reading the env var.
 */
export function saveDetectedProvider(
  configFile: string,
  candidate: EnvCandidate,
  modelId: string = candidate.defaultModel,
  read: (file: string) => MohConfig = loadMohConfig,
  write: (file: string, config: MohConfig) => void = writeMohConfig,
): MohConfig {
  const profile: EndpointProfile = {
    name: candidate.type,
    type: candidate.type,
    defaultModel: modelId,
  };
  const config = upsertEndpoint(read(configFile), profile);
  const withDefault: MohConfig = { ...config, provider: `${profile.name}/${modelId}` };
  write(configFile, withDefault);
  return withDefault;
}

/**
 * Persists a wizard-collected profile (may carry an inline key and base
 * URL, e.g. openai-compat) and sets it as the default provider.
 */
export function saveWizardProvider(
  configFile: string,
  profile: EndpointProfile,
  write: (file: string, config: MohConfig) => void = writeMohConfig,
  read: (file: string) => MohConfig = loadMohConfig,
): MohConfig {
  const config = upsertEndpoint(read(configFile), profile);
  const withDefault: MohConfig = { ...config, provider: `${profile.name}/${profile.defaultModel}` };
  write(configFile, withDefault);
  return withDefault;
}

// --- User-level layering (#129): wizard save semantics (decision 7) ---

/**
 * What the wizard should do with a freshly collected profile, given the
 * user-level endpoints already configured (decision 7):
 * - same name + same config → silent reuse;
 * - same name + different config → warn (key conflict / human-error guard);
 * - different name but content match (type + baseUrl + defaultModel, key
 *   excluded) → duplicate warning;
 * - otherwise brand-new → ask user vs project scope (default: user on
 *   absolute first run, project when a moh.json exists).
 */
export type WizardPlan =
  | { kind: "new"; defaultScope: "user" | "project" }
  | { kind: "reuse"; existing: EndpointProfile }
  | { kind: "key-conflict"; existing: EndpointProfile }
  | { kind: "duplicate"; existing: EndpointProfile };

function canonical(profile: EndpointProfile): string {
  return JSON.stringify(profile, Object.keys(profile).sort());
}

/** Same endpoint config, field-order-insensitive. */
function sameProfile(a: EndpointProfile, b: EndpointProfile): boolean {
  return canonical(a) === canonical(b);
}

function sameContent(a: EndpointProfile, b: EndpointProfile): boolean {
  return a.type === b.type && a.baseUrl === b.baseUrl && a.defaultModel === b.defaultModel;
}

/** Field names that differ between two same-named profiles (for the warning text). */
export function profileDiff(a: EndpointProfile, b: EndpointProfile): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const key of keys) {
    const ka = (a as Record<string, unknown>)[key];
    const kb = (b as Record<string, unknown>)[key];
    if (JSON.stringify(ka) !== JSON.stringify(kb)) out.push(key);
  }
  return out.filter((k) => k !== "name");
}

export function wizardSavePlan(
  profile: EndpointProfile,
  userEndpoints: EndpointProfile[],
  projectConfigExists: boolean,
): WizardPlan {
  const sameName = userEndpoints.find((e) => e.name === profile.name);
  if (sameName) {
    if (sameProfile(sameName, profile)) return { kind: "reuse", existing: sameName };
    return { kind: "key-conflict", existing: sameName };
  }
  const duplicate = userEndpoints.find((e) => sameContent(e, profile));
  if (duplicate) return { kind: "duplicate", existing: duplicate };
  return { kind: "new", defaultScope: projectConfigExists ? "project" : "user" };
}

/** User-level endpoints of `~/.moh/config` (strict read: throws on a broken section). */
export function readUserWizardEndpoints(home?: string): EndpointProfile[] {
  return readUserProviderConfig(userConfigFile(home)).endpoints ?? [];
}

export function projectConfigExists(cwd: string): boolean {
  return existsSync(join(cwd, "moh.json"));
}

/**
 * Persists a wizard profile user-level (endpoint + default provider ref)
 * through the config guardian. Returns the effective provider ref.
 */
export function saveWizardProviderUser(file: string, profile: EndpointProfile): string {
  upsertUserEndpoint(file, profile);
  const ref = `${profile.name}/${profile.defaultModel}`;
  saveUserProviderRef(file, ref);
  return ref;
}

/** Sets only the default provider reference in the project moh.json. */
export function saveProviderRefProject(configFile: string, ref: string): MohConfig {
  const config = loadMohConfig(configFile);
  const withDefault: MohConfig = { ...config, provider: ref };
  writeMohConfig(configFile, withDefault);
  return withDefault;
}
