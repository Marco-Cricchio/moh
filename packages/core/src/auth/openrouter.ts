/**
 * OpenRouter subscription grant (issue #161, ADR-0010). Primary source:
 * pi-ai `auth/oauth/openrouter.js` (MIT, 0.84.2).
 *
 * Posture: OAuth PKCE authorize → the exchange yields a **persistent,
 * user-controlled API key** — no refresh tokens, no expiry. Stored as a
 * minted-key grant (OpenAI posture): the key rides the ordinary api-key
 * path; nothing ever refreshes.
 *
 * Flow: authorize `https://openrouter.ai/auth` with `callback_url` =
 * loopback ephemeral port + PKCE S256 challenge, raced against the
 * manual path (paste the final redirect URL or the code) using the
 * generic machinery in auth/oauth.ts.
 */
import type { AuthToken, OpenrouterAuthOverrides } from "./types";
import {
  confirmToSWarningFor,
  generatePkce,
  generateState,
  raceForCode,
  startLoopbackCallback,
  type AuthorizationIo,
} from "./oauth";

export const OPENROUTER_OAUTH_DEFAULTS = {
  authorizeUrl: "https://openrouter.ai/auth",
  tokenUrl: "https://openrouter.ai/api/v1/auth/keys",
} as const;

export interface OpenrouterOAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
}

/** Defaults merged with user overrides (`auth.overrides.openrouter`). */
export function resolveOpenrouterOAuthConfig(overrides?: OpenrouterAuthOverrides): OpenrouterOAuthConfig {
  return { ...OPENROUTER_OAUTH_DEFAULTS, ...overrides };
}

/** The OpenRouter backend (openai wire, #159 defaults). */
export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * HTTP seam for the JSON key-exchange endpoint (OpenRouter is the only
 * grant so far whose token endpoint speaks JSON, not form encoding).
 */
export type OpenrouterEndpointFetch = (
  tokenUrl: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;

export const defaultOpenrouterEndpointFetch: OpenrouterEndpointFetch = async (tokenUrl, body) => {
  // pi pattern: a bounded exchange — 30s, never an infinite hang.
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

/** Thrown by {@link loginOpenRouter} when the user declines the ToS warning. */
export class OpenrouterLoginAborted extends Error {
  constructor() {
    super("subscription auth aborted: terms of service not acknowledged");
    this.name = "OpenrouterLoginAborted";
  }
}

/**
 * Exchanges the authorization code for the persistent API key. The
 * stored AuthToken is a minted-key grant: `accessToken` = the key, no
 * expiry, no refresh token.
 */
export async function exchangeOpenrouterCode(
  config: OpenrouterOAuthConfig,
  opts: { code: string; codeVerifier: string; fetchImpl?: OpenrouterEndpointFetch; now?: number },
): Promise<AuthToken> {
  const fetchImpl = opts.fetchImpl ?? defaultOpenrouterEndpointFetch;
  const now = opts.now ?? Date.now();
  const result = await fetchImpl(config.tokenUrl, {
    code: opts.code,
    code_verifier: opts.codeVerifier,
    code_challenge_method: "S256",
  });
  if (result.status !== 200 || typeof result.json.key !== "string" || result.json.key === "") {
    const rawDetail = result.json.error_description ?? result.json.message ?? result.json.error;
    const detail =
      typeof rawDetail === "object" && rawDetail !== null
        ? (rawDetail as { message?: unknown }).message
        : rawDetail;
    throw new Error(
      `OpenRouter key exchange failed (HTTP ${result.status})${typeof detail === "string" ? `: ${detail}` : ""}`,
    );
  }
  return {
    accessToken: result.json.key,
    grant: { provider: "openrouter", minted: true },
    updatedAt: now,
  };
}

/** Parses a pasted redirect URL / query string / bare code into a code. */
export function parseOpenrouterAuthorizationInput(input: string): string | undefined {
  const value = input.trim();
  if (!value) return undefined;
  try {
    const fromUrl = new URL(value).searchParams.get("code");
    if (fromUrl) return fromUrl;
  } catch {
    // not a URL — fall through
  }
  if (value.includes("code=")) return new URLSearchParams(value).get("code") ?? undefined;
  return value;
}

/**
 * The full interactive OpenRouter login: ToS acknowledgement, PKCE pair,
 * loopback callback raced against the manual paste path (headless boxes
 * paste the final redirect URL), then the code→key exchange.
 */
export async function loginOpenRouter(
  io: AuthorizationIo,
  opts: { overrides?: OpenrouterAuthOverrides; fetchImpl?: OpenrouterEndpointFetch; now?: number; timeoutMs?: number } = {},
): Promise<AuthToken> {
  if (!(await confirmToSWarningFor(io, "openrouter"))) throw new OpenrouterLoginAborted();

  const config = resolveOpenrouterOAuthConfig(opts.overrides);
  const pkce = generatePkce();
  // Random per-attempt state, validated on the loopback callback (CSRF).
  // OpenRouter has no state parameter of its own — we embed ours in the
  // callback_url it redirects to, so the callback carries it back.
  const state = generateState();
  const callback = await startLoopbackCallback({
    state,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });

  // OpenRouter's authorize page takes `callback_url` (+ PKCE), not the
  // standard redirect_uri; the state rides inside the callback URL.
  const callbackUrl = new URL(callback.redirectUri);
  callbackUrl.searchParams.set("state", state);
  const authorizeUrl = new URL(config.authorizeUrl);
  authorizeUrl.searchParams.set("callback_url", callbackUrl.toString());
  authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  // Manual path: same authorize URL; OpenRouter redirects to the loopback
  // callback (which a headless browser cannot reach) — the user copies the
  // final redirect URL from the browser's address bar and pastes it back.
  let pasteDone = false;
  const pasteIo: AuthorizationIo = {
    ask: async (prompt) => {
      // After one real input, answer "" on the follow-up so the paste
      // loop closes instead of consuming a second attempt.
      if (pasteDone) return "";
      const line = await io.ask(prompt);
      if (!line.trim()) return "";
      pasteDone = true;
      return parseOpenrouterAuthorizationInput(line) ?? "";
    },
    info: (line) => io.info(line),
    ...(io.openUrl ? { openUrl: (url: string) => io.openUrl!(url) } : {}),
  };
  const code = await raceForCode(pasteIo, { authorizeUrl: authorizeUrl.toString(), manualUrl: authorizeUrl.toString(), callback });
  if (code === "") {
    throw new Error("OpenRouter login failed: no authorization code received (cancelled or timed out)");
  }
  return exchangeOpenrouterCode(config, {
    code,
    codeVerifier: pkce.verifier,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}
