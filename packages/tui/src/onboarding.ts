/**
 * Hybrid provider onboarding logic (issue #33): env-var auto-detect +
 * one-step confirm, full wizard fallback. Pure seam — the Ink overlay
 * (Onboarding.tsx) renders these results and calls these savers.
 */
import {
  loadMohConfig,
  upsertEndpoint,
  writeMohConfig,
  type EndpointProfile,
  type MohConfig,
} from "@moh/core";

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
