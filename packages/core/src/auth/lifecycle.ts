/**
 * Subscription-auth lifecycle commands (issue #138, spec decisions 7/11):
 * `moh provider login` (re-auth), `moh provider logout` (the only token
 * deleter besides successful re-login), and `moh provider status`
 * (per-endpoint auth kind, token expiry, subscription plan-usage where
 * the provider exposes it — Anthropic `/api/oauth/usage`; OpenAI/Google
 * best-effort).
 *
 * Login dispatches to the per-provider grants (auth/anthropic.ts, ...) —
 * each shows the ToS warning first (spec invariant 4). Status output is
 * redacted: no token or key material ever leaves this module.
 */
import type { EndpointProfile } from "../config";
import { envApiKey } from "../route";
import { userConfigFile } from "../user-config";
import { loginAnthropic, ANTHROPIC_OAUTH_BETA } from "./anthropic";
import { loginGoogle } from "./google";
import { loginOpenAI } from "./openai";
import { loginOpenRouter } from "./openrouter";
import { loginXai } from "./xai";
import { loginKimiCoding } from "./kimi-coding";
import { loginGitHubCopilot } from "./github-copilot";
import type { AuthorizationIo } from "./oauth";
import { clearTokens, readAuthSection, saveTokens } from "./store";
import type { AuthOverrides, AuthToken } from "./types";
/** Provider kinds with a subscription grant (openai-compat has none). */
export const SUBSCRIPTION_KINDS = ["anthropic", "openai", "google", "openrouter", "xai", "kimi-coding", "github-copilot"] as const;
export type SubscriptionKind = (typeof SUBSCRIPTION_KINDS)[number];

export function isSubscriptionKind(kind: string): kind is SubscriptionKind {
  return (SUBSCRIPTION_KINDS as readonly string[]).includes(kind);
}

/** Injected grant seam (tests script it; production runs the real flow). */
export type SubscriptionLogin = (
  io: AuthorizationIo,
  kind: SubscriptionKind,
  overrides: AuthOverrides | undefined,
  opts: { now?: number; fetchImpl?: AuthEndpointFetch },
) => Promise<AuthToken>;

/** HTTP seam for the token endpoints (structural shape shared by all
 * three grants — same as resolve.ts TokenFetch). */
export type AuthEndpointFetch = (
  url: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;

/** Runs the per-provider subscription grant (ToS first), **without**
 * storing anything — the wizard and providerLogin persist the result. */
export async function runSubscriptionLogin(
  kind: SubscriptionKind,
  io: AuthorizationIo,
  opts: { overrides?: AuthOverrides; now?: number; fetchImpl?: AuthEndpointFetch } = {},
): Promise<AuthToken> {
  const rest = {
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl as never } : {}),
  };
  switch (kind) {
    case "anthropic":
      return loginAnthropic(io, { overrides: opts.overrides?.anthropic, ...rest });
    case "openai":
      return loginOpenAI(io, { overrides: opts.overrides?.openai, ...rest });
    case "google":
      return loginGoogle(io, { overrides: opts.overrides?.google, ...rest });
    case "openrouter":
      return loginOpenRouter(io, { overrides: opts.overrides?.openrouter, ...rest });
    case "xai":
      return loginXai(io, { overrides: opts.overrides?.xai, ...rest });
    case "kimi-coding":
      return loginKimiCoding(io, { overrides: opts.overrides?.["kimi-coding"], ...rest });
    case "github-copilot":
      return loginGitHubCopilot(io, { overrides: opts.overrides?.["github-copilot"], ...rest });
  }
}

export interface LoginOptions {
  /** Auth store location. Default: `~/.moh/config` via the guardian. */
  authFile?: string;
  /** Grant override (tests). Default: the per-provider login flows. */
  loginImpl?: SubscriptionLogin;
  now?: number;
  fetchImpl?: AuthEndpointFetch;
}

/**
 * Re-auth for one endpoint: runs the provider's subscription grant
 * (ToS first — the grants handle that) and stores the fresh token set,
 * replacing any previous one. Throws for kinds without a grant.
 */
export async function providerLogin(
  endpoint: Pick<EndpointProfile, "name" | "type">,
  io: AuthorizationIo,
  opts: LoginOptions = {},
): Promise<AuthToken> {
  if (!isSubscriptionKind(endpoint.type)) {
    throw new Error(`provider "${endpoint.name}" (kind "${endpoint.type}") has no subscription auth; only ${SUBSCRIPTION_KINDS.join(", ")} do`);
  }
  const file = opts.authFile ?? userConfigFile();
  const overrides = readAuthSection(file).overrides;
  const login = opts.loginImpl ?? ((io2, kind2, ov) => runSubscriptionLogin(kind2, io2, { overrides: ov }));
  const token = await login(io, endpoint.type, overrides, opts);
  saveTokens(file, endpoint.name, token);
  return token;
}

export interface LogoutOptions {
  authFile?: string;
}

/**
 * Drops one endpoint's tokens through the guardian (spec decision 7:
 * logout and successful re-login are the only token deleters).
 * Returns whether tokens were actually stored.
 */
export function providerLogout(endpoint: string, opts: LogoutOptions = {}): boolean {
  const file = opts.authFile ?? userConfigFile();
  const had = readAuthSection(file).tokens[endpoint] !== undefined;
  if (had) clearTokens(file, endpoint);
  return had;
}

/** Usage-endpoint seam (GET with headers); tests script it. */
export type UsageFetch = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ status: number; text: string }>;

/** Anthropic's OAuth usage metering endpoint (research §1; drift-prone). */
export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface SubscriptionStatus {
  loggedIn: boolean;
  /** Display-only account identity (email or name). Never a secret. */
  account?: string;
  /** Access-token expiry, epoch ms (absent = unknown). */
  expiresAt?: number;
  /** Plan from grant metadata where the provider reports one (OpenAI). */
  plan?: string;
  /** Best-effort usage summary (Anthropic usage endpoint; OpenAI/Google none yet). */
  usage?: string;
}

export interface EndpointAuthStatus {
  name: string;
  type: string;
  authKind: "api-key" | "subscription";
  /** Where an api-key endpoint's key comes from. */
  apiKeySource?: "inline" | "env" | "none";
  subscription?: SubscriptionStatus;
}

export interface StatusOptions {
  authFile?: string;
  env?: Record<string, string | undefined>;
  usageFetch?: UsageFetch;
}

/**
 * Per-endpoint auth status over merged endpoint profiles. Subscription
 * rows read the auth store (no refresh — status is read-only, best-effort);
 * the Anthropic usage endpoint is consulted when a token exists. Output
 * contains no token or key material (spec invariant 2).
 */
export async function providerStatus(
  endpoints: readonly EndpointProfile[],
  opts: StatusOptions = {},
): Promise<EndpointAuthStatus[]> {
  const file = opts.authFile ?? userConfigFile();
  const section = readAuthSection(file);
  const usageFetch = opts.usageFetch ?? defaultUsageFetch;
  return Promise.all(
    endpoints.map(async (endpoint): Promise<EndpointAuthStatus> => {
      if (endpoint.auth?.kind !== "subscription") {
        const source = endpoint.apiKey?.trim()
          ? "inline"
          : envApiKey(endpoint.name, opts.env ?? process.env) !== undefined
            ? "env"
            : "none";
        return { name: endpoint.name, type: endpoint.type, authKind: "api-key", apiKeySource: source };
      }
      const token = section.tokens[endpoint.name];
      if (!token) {
        return { name: endpoint.name, type: endpoint.type, authKind: "subscription", subscription: { loggedIn: false } };
      }
      const status: SubscriptionStatus = { loggedIn: true };
      const account = token.account?.email ?? token.account?.name;
      if (account) status.account = account;
      if (token.expiresAt !== undefined) status.expiresAt = token.expiresAt;
      if (typeof token.grant?.plan === "string") status.plan = token.grant.plan;
      if (endpoint.type === "anthropic") {
        status.usage = await anthropicUsage(token.accessToken, usageFetch);
      }
      return { name: endpoint.name, type: endpoint.type, authKind: "subscription", subscription: status };
    }),
  );
}

async function defaultUsageFetch(url: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { headers });
  return { status: res.status, text: await res.text().catch(() => "") };
}

/** Best-effort usage line; never throws, never leaks the token. */
async function anthropicUsage(accessToken: string, usageFetch: UsageFetch): Promise<string> {
  try {
    const res = await usageFetch(ANTHROPIC_USAGE_URL, {
      authorization: `Bearer ${accessToken}`,
      ...ANTHROPIC_OAUTH_BETA,
    });
    if (res.status !== 200) return `usage unavailable (HTTP ${res.status})`;
    return `usage: ${summarizeUsage(res.text)}`;
  } catch {
    return "usage unavailable";
  }
}

/** Compact `k: v` rendering of a JSON usage payload. Unparseable bodies
 * are never echoed raw — a drifted endpoint must not leak whatever it
 * decides to return (redaction by construction, spec invariant 2). */
function summarizeUsage(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object") return "unavailable (unparseable response)";
    const parts = Object.entries(parsed as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`,
    );
    const joined = parts.join("; ");
    return joined.length > 160 ? `${joined.slice(0, 157)}...` : joined;
  } catch {
    return "unavailable (unparseable response)";
  }
}
