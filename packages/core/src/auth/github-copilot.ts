/**
 * GitHub Copilot subscription grant (issue #160, ADR-0010). Primary
 * source: pi-ai `auth/oauth/github-copilot.js` (MIT, 0.84.2).
 *
 * Two-hop token:
 * 1. GitHub OAuth **device flow** (github.com/login/device/code →
 *    /login/oauth/access_token, client_id = the VS Code Copilot GitHub
 *    App, scope read:user) yields a long-lived GitHub token;
 * 2. GET api.github.com/copilot_internal/v2/token with that GitHub
 *    token yields the short-lived **copilot token** (+ its proxy
 *    endpoint). "Refresh" = re-run the exchange with the stored GitHub
 *    token; the stored AuthToken keeps the GitHub token as
 *    refreshToken and the copilot token as accessToken with its expiry.
 *
 * The backend base URL comes from the token itself (`proxy-ep` →
 * `https://api.<host>`); enterprise domains override everything.
 * Required editor headers per request ride the catalog (#164) via
 * RouteTarget.headers (#159 seam).
 */
import type { AuthToken, GithubCopilotAuthOverrides } from "./types";
import type { EndpointAuthContext } from "./resolve";
import { confirmToSWarningFor, type AuthorizationIo } from "./oauth";
import { pollDeviceCodeFlow, type DeviceFlowClock, type DevicePollOptions, type DevicePollResult } from "./device-code";

/** pi stores this base64-obfuscated; moh keeps the literal. */
export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const COPILOT_DEVICE_SCOPE = "read:user";

export const COPILOT_OAUTH_DEFAULTS = {
  domain: "github.com",
} as const;

/** The copilot token exchange endpoint (api.<domain> pattern). */
export function copilotTokenUrl(domain: string): string {
  return `https://api.${domain}/copilot_internal/v2/token`;
}

/** Required editor headers on every backend request (pi's COPILOT_HEADERS). */
export const COPILOT_EDITOR_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

/** Fallback backend (used when the token carries no parseable proxy-ep). */
export const COPILOT_DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";

/** Token responses skew 5 minutes early (pi's expires_at - 5min). */
export const COPILOT_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Normalizes a user-entered domain/URL to a hostname (pi's normalizeDomain). */
export function normalizeGithubDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

/** github/<ghe> URL trio for a domain. */
function urlsFor(domain: string) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: copilotTokenUrl(domain),
  };
}

/** Parses the copilot token's `proxy-ep` into the API base URL. */
export function copilotBaseUrlFromToken(copilotToken: string): string | undefined {
  const match = copilotToken.match(/proxy-ep=([^;]+)/);
  if (!match) return undefined;
  return `https://${match[1]!.replace(/^proxy\./, "api.")}`;
}

/** Enterprise domain recorded in a stored grant, if any. */
function copilotDomain(token: AuthToken): string | undefined {
  return typeof token.grant?.domain === "string" ? token.grant.domain : undefined;
}

/** The base URL for a copilot credential: token first, enterprise/domain fallback. */
export function copilotBaseUrl(copilotToken: string | undefined, domain: string | undefined): string {
  return (
    (copilotToken ? copilotBaseUrlFromToken(copilotToken) : undefined) ??
    (domain && domain !== "github.com" ? `https://copilot-api.${domain}` : undefined) ??
    COPILOT_DEFAULT_BASE_URL
  );
}

/** Form-encoded POST with GitHub's Accept header (test seam shape). */
export type CopilotEndpointFetch = (
  url: string,
  init: { method?: string; body?: Record<string, string>; headers?: Record<string, string> },
) => Promise<{ status: number; json: Record<string, unknown> }>;

export const defaultCopilotEndpointFetch: CopilotEndpointFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method ?? "POST",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      // Editor UA floor: caller headers may override (the exchange sends
      // the full editor set, which repeats it).
      "User-Agent": COPILOT_EDITOR_HEADERS["User-Agent"],
      ...init.headers,
    },
    ...(init.body ? { body: new URLSearchParams(init.body).toString() } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds: number;
}

async function startDeviceFlow(domain: string, fetchImpl: CopilotEndpointFetch): Promise<DeviceCode> {
  const urls = urlsFor(domain);
  const result = await fetchImpl(urls.deviceCodeUrl, {
    body: { client_id: COPILOT_CLIENT_ID, scope: COPILOT_DEVICE_SCOPE },
  });
  const json = result.json;
  const deviceCode = json.device_code;
  const userCode = json.user_code;
  const verificationUri = json.verification_uri;
  const interval = json.interval;
  const expiresIn = json.expires_in;
  if (result.status !== 200 || typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string" || typeof expiresIn !== "number") {
    throw new Error(`GitHub device code request failed (HTTP ${result.status}): ${JSON.stringify(json)}`);
  }
  // Force the URI to a real http(s) URL before it reaches a browser.
  let parsed: URL;
  try {
    parsed = new URL(verificationUri);
  } catch {
    throw new Error("Untrusted verification_uri in GitHub device code response");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Untrusted verification_uri in GitHub device code response");
  }
  return {
    deviceCode,
    userCode,
    verificationUri: parsed.href,
    intervalSeconds: typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : undefined,
    expiresInSeconds: expiresIn,
  };
}

/** Exchange result: the GitHub access token. */
async function pollForGitHubToken(domain: string, device: DeviceCode, fetchImpl: CopilotEndpointFetch, clock?: DeviceFlowClock): Promise<string> {
  const urls = urlsFor(domain);
  const options: DevicePollOptions<string> = {
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
    waitBeforeFirstPoll: true,
    clock,
    poll: async (): Promise<DevicePollResult<string>> => {
      const result = await fetchImpl(urls.accessTokenUrl, {
        body: {
          client_id: COPILOT_CLIENT_ID,
          device_code: device.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      });
      const json = result.json;
      if (typeof json.access_token === "string") return { status: "complete", value: json.access_token };
      const error = json.error;
      if (error === "authorization_pending") return { status: "pending" };
      if (error === "slow_down") {
        const interval = json.interval;
        return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
      }
      const description = typeof json.error_description === "string" ? `: ${json.error_description}` : "";
      return { status: "failed", message: `GitHub device flow failed: ${error}${description}` };
    },
  };
  return pollDeviceCodeFlow(options);
}

/** The stored AuthToken: copilot token as access, GitHub token as refresh. */
function toAuthToken(githubToken: string, copilot: { token: string; expiresAtEpochSeconds: number }, domain: string | undefined, now: number): AuthToken {
  return {
    accessToken: copilot.token,
    refreshToken: githubToken,
    expiresAt: copilot.expiresAtEpochSeconds * 1000 - COPILOT_REFRESH_SKEW_MS,
    grant: { provider: "github-copilot", ...(domain && domain !== "github.com" ? { domain } : {}) },
    updatedAt: now,
  };
}

/** GET the copilot token with the GitHub token (the exchange + the "refresh"). */
export async function exchangeCopilotToken(
  githubToken: string,
  domain: string | undefined,
  fetchImpl: CopilotEndpointFetch,
  now: number,
): Promise<AuthToken> {
  const result = await fetchImpl(copilotTokenUrl(domain ?? COPILOT_OAUTH_DEFAULTS.domain), {
    method: "GET",
    headers: { authorization: `Bearer ${githubToken}`, ...COPILOT_EDITOR_HEADERS },
  });
  const token = result.json.token;
  const expiresAt = result.json.expires_at;
  if (result.status !== 200 || typeof token !== "string" || typeof expiresAt !== "number") {
    throw new Error(`Copilot token exchange failed (HTTP ${result.status}): ${JSON.stringify(result.json)}`);
  }
  return toAuthToken(githubToken, { token, expiresAtEpochSeconds: expiresAt }, domain, now);
}

/**
 * The stream-time transport for a copilot grant (#137/#159): the copilot
 * token is the credential, the backend base URL is derived from the
 * token itself (proxy-ep), and every request carries the editor headers
 * (catalog entries repeat them per model — #164 — this is the floor).
 */
export function copilotAuthContext(token: AuthToken): EndpointAuthContext {
  const domain = copilotDomain(token);
  return {
    credential: token.accessToken,
    baseUrl: copilotBaseUrl(token.accessToken, domain),
    headers: { ...COPILOT_EDITOR_HEADERS },
  };
}

/** Thrown by {@link loginGitHubCopilot} when the user declines the ToS warning. */
export class CopilotLoginAborted extends Error {
  constructor() {
    super("subscription auth aborted: terms of service not acknowledged");
    this.name = "CopilotLoginAborted";
  }
}

/**
 * The full interactive Copilot login: ToS acknowledgement, optional
 * GitHub Enterprise domain, device flow for the GitHub token, then the
 * copilot token exchange.
 */
export async function loginGitHubCopilot(
  io: AuthorizationIo,
  opts: { overrides?: GithubCopilotAuthOverrides; fetchImpl?: CopilotEndpointFetch; now?: number; clock?: DeviceFlowClock } = {},
): Promise<AuthToken> {
  if (!(await confirmToSWarningFor(io, "github-copilot"))) throw new CopilotLoginAborted();

  const fetchImpl = opts.fetchImpl ?? defaultCopilotEndpointFetch;
  const input = (await io.ask("GitHub Enterprise URL/domain (blank for github.com): ")).trim();
  const domain = input ? normalizeGithubDomain(input) : null;
  if (input && !domain) throw new Error("Invalid GitHub Enterprise URL/domain");
  const host = domain ?? opts.overrides?.domain ?? COPILOT_OAUTH_DEFAULTS.domain;

  const device = await startDeviceFlow(host, fetchImpl);
  await io.info(
    `Open ${device.verificationUri} in a browser and enter code ${device.userCode} ` +
      `(expires in ${Math.floor(device.expiresInSeconds / 60)} minutes).`,
  );
  const githubToken = await pollForGitHubToken(host, device, fetchImpl, opts.clock);
  return exchangeCopilotToken(githubToken, domain ?? undefined, fetchImpl, opts.now ?? Date.now());
}

/**
 * "Refresh" (#137 wiring): re-run the copilot token exchange with the
 * stored GitHub token. The GitHub token itself does not expire on this
 * path (pi's posture); a failed exchange surfaces as an auth error with
 * the re-login hint.
 */
export async function refreshCopilotToken(
  token: AuthToken,
  opts: { fetchImpl?: CopilotEndpointFetch; now?: number } = {},
): Promise<AuthToken> {
  if (!token.refreshToken) {
    throw new Error("Copilot grant has no stored GitHub token; run `moh provider login`");
  }
  const fetchImpl = opts.fetchImpl ?? defaultCopilotEndpointFetch;
  const fresh = await exchangeCopilotToken(token.refreshToken, copilotDomain(token), fetchImpl, opts.now ?? Date.now());
  return { ...fresh, account: fresh.account ?? token.account };
}
