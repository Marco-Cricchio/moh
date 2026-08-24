/**
 * Auth data types and schemas (issue #132, spec:
 * docs/spec/oauth-subscription-auth.md).
 *
 * Foundation layer only — no OAuth machinery yet. This module defines:
 * - `AuthMethodKind`: how an endpoint authenticates (api-key vs
 *   subscription/OAuth);
 * - `AuthToken`: stored tokens plus grant metadata;
 * - the zod schema for the `auth` section of `~/.moh/config`.
 *
 * Invariant (spec decision 2): tokens never appear in moh.json — they live
 * only in the user config file's `auth` section, written through the
 * user-config guardian (ADR-0006).
 */
import { z } from "zod";

/** How an endpoint authenticates. Absent `auth` on an EndpointProfile = api-key. */
export const authMethodKindSchema = z.enum(["api-key", "subscription"]);
export type AuthMethodKind = z.infer<typeof authMethodKindSchema>;

/** The `auth` field of an EndpointProfile (config.ts re-exports via schema). */
export const endpointAuthSchema = z.object({ kind: authMethodKindSchema });
export type EndpointAuth = z.infer<typeof endpointAuthSchema>;

/** Account info surfaced by the provider during login, display-only. */
export const authAccountSchema = z.object({
  id: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});
export type AuthAccount = z.infer<typeof authAccountSchema>;

/**
 * One stored token set for an endpoint. Access token is always present;
 * refresh token, expiry, scopes, account and provider-specific grant
 * metadata (e.g. anthropic `inferenceOnly`, openai minted-key reference)
 * are optional.
 */
export const authTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** Access-token expiry, epoch ms. Absent = unknown / no expiry. */
  expiresAt: z.number().int().positive().optional(),
  /** Granted scopes, as returned by the token endpoint. */
  scopes: z.array(z.string().min(1)).optional(),
  account: authAccountSchema.optional(),
  /** Provider-specific grant metadata; shape owned by the provider grant. */
  grant: z.record(z.string(), z.unknown()).optional(),
  /** Last write time, epoch ms (audit/debug display only). */
  updatedAt: z.number().int().positive(),
});
export type AuthToken = z.infer<typeof authTokenSchema>;

/**
 * Per-provider overrides for the `auth.overrides` section of `~/.moh/config`.
 * Hardcoded defaults drift (Anthropic already rotated OAuth hosts twice),
 * so every issuer/client_id value is user-overridable (spec decision 5).
 */
export const anthropicAuthOverridesSchema = z.object({
  authorizeUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
  /** Hosted manual-redirect page shown to headless users. */
  manualRedirectUrl: z.string().url().optional(),
  /** Client-requested `expires_in` (seconds) for long-lived
   * inference-only tokens (spec decision 9). */
  inferenceExpiresIn: z.number().int().positive().optional(),
});
export type AnthropicAuthOverrides = z.infer<typeof anthropicAuthOverridesSchema>;

/** OpenAI overrides: issuer (client_id + all endpoints derive from it). */
export const openaiAuthOverridesSchema = z.object({
  issuer: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
});
export type OpenAiAuthOverrides = z.infer<typeof openaiAuthOverridesSchema>;

export const googleAuthOverridesSchema = z.object({
  authorizeUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
  /** Installed-app secret: not treated as a secret by Google's own guidance. */
  clientSecret: z.string().min(1).optional(),
  /** Out-of-band page that displays the code to paste (headless path). */
  manualRedirectUrl: z.string().url().optional(),
});
export type GoogleAuthOverrides = z.infer<typeof googleAuthOverridesSchema>;

// ADR-0010 (#159): override schemas for the four new OAuth providers —
// drift-prone captured endpoints/hosts, user-overridable like the rest.

/** OpenRouter overrides: authorize + key-exchange endpoints. */
export const openrouterAuthOverridesSchema = z.object({
  authorizeUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
});
export type OpenrouterAuthOverrides = z.infer<typeof openrouterAuthOverridesSchema>;

/** Kimi overrides: the OAuth host both device flow endpoints derive from. */
export const kimiCodingAuthOverridesSchema = z.object({
  oauthHost: z.string().url().optional(),
});
export type KimiCodingAuthOverrides = z.infer<typeof kimiCodingAuthOverridesSchema>;

/** xAI overrides: device-code + token endpoints, client_id. */
export const xaiAuthOverridesSchema = z.object({
  deviceCodeUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
});
export type XaiAuthOverrides = z.infer<typeof xaiAuthOverridesSchema>;

/** GitHub Copilot overrides: GitHub host (enterprise domains). */
export const githubCopilotAuthOverridesSchema = z.object({
  domain: z.string().min(1).optional(),
});
export type GithubCopilotAuthOverrides = z.infer<typeof githubCopilotAuthOverridesSchema>;

export const authOverridesSchema = z.object({
  anthropic: anthropicAuthOverridesSchema.optional(),
  openai: openaiAuthOverridesSchema.optional(),
  google: googleAuthOverridesSchema.optional(),
  openrouter: openrouterAuthOverridesSchema.optional(),
  "kimi-coding": kimiCodingAuthOverridesSchema.optional(),
  xai: xaiAuthOverridesSchema.optional(),
  "github-copilot": githubCopilotAuthOverridesSchema.optional(),
});
export type AuthOverrides = z.infer<typeof authOverridesSchema>;

/**
 * The `auth` section of `~/.moh/config`: tokens keyed by endpoint name,
 * plus provider overrides for client_id / issuer URLs.
 * This section is **never a merge candidate** (issue #129 seam): the
 * provider merge reads only `provider`/`endpoints`.
 */
export const authSectionSchema = z.object({
  tokens: z.record(z.string(), authTokenSchema),
  overrides: authOverridesSchema.optional(),
});
export type AuthSection = z.infer<typeof authSectionSchema>;
