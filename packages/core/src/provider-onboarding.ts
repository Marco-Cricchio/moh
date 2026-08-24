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
import { userConfigFile } from "./user-config";
import { runSubscriptionLogin, isSubscriptionKind } from "./auth/lifecycle";
import { getStoredToken, readAuthSection, saveTokens } from "./auth/store";
import type { SubscriptionKind } from "./auth/lifecycle";
import { ANTHROPIC_OAUTH_BETA } from "./auth/anthropic";
import { openaiNativeAuthContext } from "./auth/resolve";
import { OAUTH_BUILTIN_BASE_URLS, isOAuthBuiltinKind } from "./wire";
import { subscriptionModelCatalog } from "./model-catalog";
import { CHATGPT_CODEX_BASE_URL, CHATGPT_CODEX_ORIGINATOR } from "./auth/openai";

/** Provider types usable with no custom code. */
export const BUILTIN_PROVIDER_TYPES = [
  "anthropic",
  "openai",
  "google",
  "openai-compat",
  // ADR-0010 (#159): the four new OAuth providers are builtin.
  "github-copilot",
  "openrouter",
  "kimi-coding",
  "xai",
] as const;
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

export interface ProviderAddOptions {
  /** Auth store for the subscription branch. Default: `~/.moh/config`. */
  authFile?: string;
  /** moh.json target (issue #150): when set, the subscription branch
   * persists a stub endpoint profile immediately after a successful login
   * so tokens are never orphaned by a later abort. */
  configFile?: string;
  /** Subscription grant override (tests); default runs the real flows. */
  subscriptionLogin?: (io: OnboardingIo) => Promise<import("./auth/types").AuthToken>;
}

/** The guided flow. Throws OnboardingAborted when the user gives up
 * instead of passing the connection test. Subscription choice (spec
 * decision 3): built-in providers with a grant ask `api-key | subscription`
 * first, then branch — the api-key questions are unchanged; the
 * subscription branch runs the per-provider login (ToS first) and marks
 * the profile `auth: { kind: "subscription" }` (no key prompt). */
export async function runProviderAdd(
  io: OnboardingIo,
  tester: ConnectionTester = minimalConnectionTest,
  options: ProviderAddOptions = {},
): Promise<EndpointProfile> {
  const type = await askOneOf(io, `Provider type (${BUILTIN_PROVIDER_TYPES.join(" | ")})`, [...BUILTIN_PROVIDER_TYPES]);
  const nameDefault = slugify(type);
  let name = slugify(await io.ask(`Endpoint name [${nameDefault}]: `));
  if (name === "") name = nameDefault;
  if (!name) throw new OnboardingAborted("endpoint name cannot be empty");

  let authKind: "api-key" | "subscription" = "api-key";
  if (isSubscriptionKind(type)) {
    // Auth method is asked per capability: only kinds with a grant offer
    // subscription (openai-compat and the not-yet-granted new providers
    // never see the question — the api-key path is unchanged). The new
    // providers join isSubscriptionKind as their grant tickets land.
    const answer = await askOneOf(io, "Auth method (api-key | subscription)", ["api-key", "subscription"]);
    authKind = answer as "api-key" | "subscription";
  }

  let apiKey = "";
  if (authKind === "subscription") {
    const authFile = options.authFile ?? userConfigFile();
    const overrides = readAuthSection(authFile).overrides;
    // openai-compat never reaches here (no question asked) — the cast
    // reflects the `type !== "openai-compat"` guard above.
    const login = options.subscriptionLogin ?? ((io2) => runSubscriptionLogin(type as SubscriptionKind, io2, { overrides }));
    const token = await login(io); // ToS warning first (spec invariant 4)
    saveTokens(authFile, name, token);
    // Issue #150: persist the endpoint stub right after the login so a
    // later abort (model prompt, failed connection test, Ctrl-C) still
    // leaves a usable endpoint + tokens pair in moh.json.
    if (options.configFile) {
      const stub: EndpointProfile = { name, type, auth: { kind: "subscription" } };
      writeMohConfig(options.configFile, upsertEndpoint(loadMohConfig(options.configFile), stub));
      await io.info(`Saved endpoint "${name}" (subscription) to ${options.configFile} — tokens stored.`);
    }
  } else {
    apiKey = (await io.ask(`API key (empty to use MOH_ENDPOINT_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY${type === "openai-compat" ? "; local endpoints need none" : ""}): `)).trim();
  }

  let baseUrl = "";
  let defaultModel: string;
  if (authKind === "subscription") {
    // #156: subscription onboarding never asks for a model id by hand —
    // the vendored catalog is offered as a numbered list right after the
    // successful login, free-text stays the advanced fallback. The grant
    // fixes the base URL (and there is no key), so neither is asked.
    defaultModel = await askSubscriptionModel(io, type);
  } else {
    baseUrl = (await io.ask(type === "openai-compat" ? "Base URL (e.g. http://localhost:11434/v1): " : "Base URL (empty for default): ")).trim();
    if (type === "openai-compat" && baseUrl === "") {
      throw new OnboardingAborted("openai-compat endpoints require a base URL");
    }
    defaultModel = (await io.ask(`Default model${type === "openai-compat" ? " (e.g. qwen3, deepseek-chat)" : ""}: `)).trim();
    if (defaultModel === "") {
      throw new OnboardingAborted("a default model is required");
    }
  }

  let profile: EndpointProfile = { name, type, ...(authKind === "subscription" ? { auth: { kind: "subscription" } } : {}), ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), defaultModel };

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
 * Post-login model choice (#156): print the provider's vendored catalog
 * as a numbered list and accept a number, or any non-empty free-text id
 * as the advanced fallback. Empty input aborts (#150 semantics: the
 * login's tokens and endpoint stub are already persisted, so a later
 * `provider add` run reuses them).
 */
async function askSubscriptionModel(io: OnboardingIo, type: string): Promise<string> {
  const models = subscriptionModelCatalog(type);
  while (true) {
    if (models.length) {
      await io.info(`Models available on ${type} subscriptions:`);
      for (const [i, model] of models.entries()) {
        await io.info(`  ${i + 1}. ${model.name} (${model.id})`);
      }
    }
    const answer = (await io.ask(`Default model${models.length ? " (1-" + models.length + " or a model id)" : ""}: `)).trim();
    if (answer === "") {
      throw new OnboardingAborted("a default model is required");
    }
    if (/^\d+$/.test(answer)) {
      const n = Number(answer);
      if (models.length && n >= 1 && n <= models.length) return models[n - 1]!.id;
      await io.info(models.length ? `enter a number between 1 and ${models.length}, or a model id` : "enter a model id");
      continue;
    }
    return answer; // free-text fallback (advanced)
  }
}

/**
 * Full onboarding against a moh.json file: run the guided flow, persist
 * the profile, set it as the default provider, and verify it resolves.
 */
export async function addProviderToFile(
  io: OnboardingIo,
  file: string,
  options: { tester?: ConnectionTester; registry?: ProviderRegistry } & ProviderAddOptions = {},
): Promise<{ profile: EndpointProfile; config: MohConfig }> {
  const { tester, registry, ...addOptions } = options;
  const profile = await runProviderAdd(io, tester, { configFile: file, ...addOptions });
  const config = upsertEndpoint(loadMohConfig(file), profile);
  const withDefault: MohConfig = { ...config, provider: `${profile.name}/${profile.defaultModel}` };
  // Sanity: the saved config must resolve before we write it.
  resolveProvider(withDefault, registry ?? defaultRegistry);
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
  authFile: string = userConfigFile(),
): Promise<ConnectionTestResult> {
  const modelId = profile.defaultModel;
  if (!modelId) return { ok: false, error: "no default model configured" };
  if (profile.type === "mock") return { ok: true, modelId };
  // Subscription endpoints (issue #138): the token the login just stored
  // is the credential — the test exercises the resolved credential,
  // whatever its kind (spec decision 3). No refresh here: the wizard runs
  // the test right after a fresh login.
  const subscription = profile.auth?.kind === "subscription";
  let apiKey: string | undefined;
  // #157: OpenAI native grants (minted: false) must exercise the same
  // ChatGPT-backend transport the stream path uses (auth/resolve.ts
  // openaiNativeAuthContext): the JWT has no key for api.openai.com, so
  // the old ping came back billing_not_active. Minted keys keep the
  // api.openai.com path below.
  let openaiNative = false;
  let nativeContext: ReturnType<typeof openaiNativeAuthContext> | undefined;
  if (subscription) {
    const token = getStoredToken(authFile, profile.name);
    if (!token) {
      return { ok: false, error: `no subscription credentials for endpoint "${profile.name}"; run \`moh provider login ${profile.name}\`` };
    }
    apiKey = token.accessToken;
    // Reuse the stream path's own transport builder so "test path ==
    // stream path" holds structurally, not by convention.
    openaiNative = profile.type === "openai" && token.grant?.minted === false;
    nativeContext = openaiNative ? openaiNativeAuthContext(token) : undefined;
  } else {
    // Inline key first (an empty/whitespace string counts as absent — the
    // wizard may persist "" when the field is left blank); otherwise the
    // endpoint's env var — same lookup an instantiated Endpoint performs at
    // stream time (route.ts envApiKey).
    apiKey = profile.apiKey?.trim() ? profile.apiKey : envApiKey(profile.name, env);
  }
  if (!apiKey && profile.type !== "openai-compat") {
    // Fail fast rather than send an unauthenticated request (local
    // openai-compat endpoints legitimately need no key).
    return { ok: false, error: `no api key configured: set an inline key or ${endpointEnvVarName(profile.name)}` };
  }
  try {
    if (openaiNative && nativeContext) {
      // ChatGPT backend only speaks the Responses API (codex's wire):
      // transport (URL + originator header) comes straight from the
      // stream path's auth context; tiny max_output_tokens ping. `input`
      // must be a **list of message items** — this backend is stricter
      // than api.openai.com, which also accepts a bare string (a string
      // gets "Input must be a list" HTTP 400 here).
      const res = await fetchImpl(`${nativeContext.baseUrl ?? CHATGPT_CODEX_BASE_URL}/responses`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${nativeContext.credential}`,
          ...(nativeContext.headers ?? { originator: CHATGPT_CODEX_ORIGINATOR }),
        },
        body: JSON.stringify({
          model: modelId,
          // ChatGPT backend invariants (codex client shape): input is a
          // message-item list AND store is pinned to false — it rejects
          // defaults with 400 "Store must be set to false".
          store: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
          max_output_tokens: 16,
        }),
      });
      return verdict(res, modelId);
    }
    const auth: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    if (profile.type === "anthropic") {
      const res = await fetchImpl(`${profile.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          // Subscription: OAuth bearer + beta header (issue #134); the
          // minted OpenAI key rides the normal Bearer/api-key path below.
          ...(subscription ? { authorization: `Bearer ${apiKey}`, ...ANTHROPIC_OAUTH_BETA } : { "x-api-key": apiKey ?? "" }),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      });
      return verdict(res, modelId);
    }
    if (profile.type === "google") {
      const base = profile.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
      const res = await fetchImpl(`${base}/models/${modelId}:generateContent`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey ?? "",
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } }),
      });
      return verdict(res, modelId);
    }
    // #157: subscription or api-key, the stream path (AI SDK google
    // factory) always sends the credential as x-goog-api-key — never a
    // Bearer header.
    if (profile.type === "openai" || profile.type === "openai-compat" || isOAuthBuiltinKind(profile.type)) {
      const base = profile.baseUrl ?? (isOAuthBuiltinKind(profile.type) ? OAUTH_BUILTIN_BASE_URLS[profile.type] : "https://api.openai.com/v1");
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
