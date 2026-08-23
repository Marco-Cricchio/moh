/**
 * Guided provider onboarding: the flow behind `moh provider add` (and
 * first-run). Collects type, name, key, baseUrl, default model, then runs
 * a mandatory minimal connection test — the profile is only returned once
 * the test passes. I/O and the test are injected seams: the CLI/TUI wires
 * the prompts (#31, #33); tests drive them directly.
 */
import { loadMohConfig, upsertEndpoint, writeMohConfig, type EndpointProfile, type MohConfig } from "./config";
import { defaultRegistry, resolveProvider, type ProviderRegistry } from "./provider-registry";
import { envApiKey, endpointEnvVarName } from "./route";

/** Provider types usable with no custom code. */
export const BUILTIN_PROVIDER_TYPES = ["anthropic", "openai", "google", "openai-compat"] as const;
export type BuiltinProviderType = (typeof BUILTIN_PROVIDER_TYPES)[number];

/**
 * Question/answer seam. `ask` returns the trimmed user answer.
 * `openUrl` (issue #133) is best-effort browser opening for OAuth flows —
 * it may be absent or fail on headless boxes; subscription flows always
 * show the manual URL as well and race the two (auth/oauth.ts).
 */
export interface OnboardingIo {
  ask(prompt: string): Promise<string>;
  info(line: string): Promise<void>;
  openUrl?(url: string): Promise<boolean>;
}

export type ConnectionTestResult = { ok: true; modelId: string } | { ok: false; error: string };
export type ConnectionTester = (profile: EndpointProfile) => Promise<ConnectionTestResult>;

export class OnboardingAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingAborted";
  }
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The guided flow. Throws OnboardingAborted when the user gives up
 * instead of passing the connection test.
 */
export async function runProviderAdd(io: OnboardingIo, tester: ConnectionTester = minimalConnectionTest): Promise<EndpointProfile> {
  const type = await askOneOf(io, `Provider type (${BUILTIN_PROVIDER_TYPES.join(" | ")})`, [...BUILTIN_PROVIDER_TYPES]);
  const nameDefault = slugify(type);
  let name = slugify(await io.ask(`Endpoint name [${nameDefault}]: `));
  if (name === "") name = nameDefault;
  if (!name) throw new OnboardingAborted("endpoint name cannot be empty");

  const apiKey = (await io.ask(`API key (empty to use MOH_ENDPOINT_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY${type === "openai-compat" ? "; local endpoints need none" : ""}): `)).trim();

  let baseUrl = (await io.ask(type === "openai-compat" ? "Base URL (e.g. http://localhost:11434/v1): " : "Base URL (empty for default): ")).trim();
  if (type === "openai-compat" && baseUrl === "") {
    throw new OnboardingAborted("openai-compat endpoints require a base URL");
  }

  let defaultModel = (await io.ask(`Default model${type === "openai-compat" ? " (e.g. qwen3, deepseek-chat)" : ""}: `)).trim();
  if (defaultModel === "") {
    throw new OnboardingAborted("a default model is required");
  }

  let profile: EndpointProfile = { name, type, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), defaultModel };

  // Mandatory connection test: the flow only completes on success.
  while (true) {
    await io.info(`Testing connection to ${name} (${defaultModel})...`);
    const result = await tester(profile);
    if (result.ok) {
      await io.info(`✓ Connected (${result.modelId} responded)`);
      return profile;
    }
    await io.info(`✗ Connection test failed: ${result.error}`);
    const retry = (await io.ask("Edit and retry? (y/n) [y]: ")).trim().toLowerCase();
    if (retry === "n") throw new OnboardingAborted(`connection test failed: ${result.error}`);
    const nextBaseUrl = (await io.ask(`Base URL [${baseUrl || "default"}]: `)).trim();
    if (nextBaseUrl) baseUrl = nextBaseUrl;
    const nextModel = (await io.ask(`Default model [${defaultModel}]: `)).trim();
    if (nextModel) defaultModel = nextModel;
    profile = { ...profile, ...(baseUrl ? { baseUrl } : {}), defaultModel };
  }
}

async function askOneOf(io: OnboardingIo, prompt: string, options: readonly string[]): Promise<string> {
  while (true) {
    const answer = (await io.ask(`${prompt}: `)).trim().toLowerCase();
    if ((options as readonly string[]).includes(answer)) return answer;
    await io.info(`Please choose one of: ${options.join(", ")}`);
  }
}

/**
 * Full onboarding against a moh.json file: run the guided flow, persist
 * the profile, set it as the default provider, and verify it resolves.
 */
export async function addProviderToFile(
  io: OnboardingIo,
  file: string,
  options: { tester?: ConnectionTester; registry?: ProviderRegistry } = {},
): Promise<{ profile: EndpointProfile; config: MohConfig }> {
  const profile = await runProviderAdd(io, options.tester);
  const config = upsertEndpoint(loadMohConfig(file), profile);
  const withDefault: MohConfig = { ...config, provider: `${profile.name}/${profile.defaultModel}` };
  // Sanity: the saved config must resolve before we write it.
  resolveProvider(withDefault, options.registry ?? defaultRegistry);
  writeMohConfig(file, withDefault);
  await io.info(`Saved ${profile.name} to ${file} and set provider to ${withDefault.provider}`);
  return { profile, config: withDefault };
}

/**
 * Minimal real connection test: one tiny non-streaming request against
 * the provider's chat endpoint. Any 2xx response passes.
 */
export async function minimalConnectionTest(
  profile: EndpointProfile,
  fetchImpl: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(20_000),
  env: Record<string, string | undefined> = process.env,
): Promise<ConnectionTestResult> {
  const modelId = profile.defaultModel;
  if (!modelId) return { ok: false, error: "no default model configured" };
  if (profile.type === "mock") return { ok: true, modelId };
  // Inline key first (an empty/whitespace string counts as absent — the
  // wizard may persist "" when the field is left blank); otherwise the
  // endpoint's env var — same lookup an instantiated Endpoint performs at
  // stream time (route.ts envApiKey).
  const apiKey = profile.apiKey?.trim() ? profile.apiKey : envApiKey(profile.name, env);
  if (!apiKey && profile.type !== "openai-compat") {
    // Fail fast rather than send an unauthenticated request (local
    // openai-compat endpoints legitimately need no key).
    return { ok: false, error: `no api key configured: set an inline key or ${endpointEnvVarName(profile.name)}` };
  }
  try {
    const auth: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    if (profile.type === "anthropic") {
      const res = await fetchImpl(`${profile.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      });
      return verdict(res, modelId);
    }
    if (profile.type === "google") {
      const base = profile.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
      const res = await fetchImpl(`${base}/models/${modelId}:generateContent`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey ?? "" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } }),
      });
      return verdict(res, modelId);
    }
    if (profile.type === "openai" || profile.type === "openai-compat") {
      const base = profile.baseUrl ?? "https://api.openai.com/v1";
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      });
      return verdict(res, modelId);
    }
    return { ok: false, error: `no built-in connection test for custom provider type "${profile.type}"` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function verdict(res: Response, modelId: string): Promise<ConnectionTestResult> {
  if (res.ok) return { ok: true, modelId };
  const body = await res.text().catch(() => "");
  const snippet = body.slice(0, 200);
  return { ok: false, error: `HTTP ${res.status} ${res.statusText}${snippet ? `: ${snippet}` : ""}` };
}
