/**
 * #499: the quota seam. One exported function — `getQuota(endpoint)` —
 * that probes the endpoint's usage endpoint and returns a narrow
 * `QuotaReport` (source badge + windows) or `null` on any failure:
 * no credentials, unsupported kind, HTTP error, or drifted schema.
 * A broken remote must degrade to a local-only display, never an error.
 *
 * Per-provider details live in isolated sibling modules (anthropic.ts,
 * openai.ts, …) so schema churn is a local fix (ADR-0004 criterion:
 * small stable export; endpoint churn never surfaces).
 */
import type { EndpointProfile } from "../config";
import { envApiKey } from "../route";
import { userConfigFile } from "../user-config";
import { readStoredTokens } from "../auth/store";
import type { AuthToken } from "../auth/types";
import type { QuotaFetch, QuotaOptions, QuotaReport } from "./types";
import { probeAnthropic } from "./anthropic";
import { probeOpenai } from "./openai";
import { probeCopilot } from "./copilot";
import { probeOpenrouter } from "./openrouter";
import { probeXai } from "./xai";
import { probeKimi } from "./kimi";
import { probeZai } from "./zai";

export type { QuotaFetch, QuotaOptions, QuotaReport, QuotaSource, QuotaWindow } from "./types";
export { aggregateLocalUsage, type LocalUsageRow } from "./local";

const defaultFetch: QuotaFetch = async (url, headers) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  return { status: res.status, text: await res.text().catch(() => "") };
};

/** Credential lookup: inline key > env var > stored subscription token. */
function credentialFor(
  endpoint: EndpointProfile,
  opts: QuotaOptions,
): { apiKey?: string; token?: AuthToken } {
  const env = opts.env ?? process.env;
  const file = opts.configFile ?? userConfigFile();
  const apiKey = endpoint.apiKey?.trim() || envApiKey(endpoint.name, env);
  if (apiKey) return { apiKey };
  if (endpoint.auth?.kind === "subscription") {
    const token = readStoredTokens(file)[endpoint.name];
    if (token) return { token };
  }
  return {};
}

/**
 * Probes one endpoint's usage quota. Returns `null` when the endpoint
 * has no known quota source or the probe fails (short timeout, best
 * effort — the caller renders the local-measured section regardless).
 */
export async function getQuota(endpoint: EndpointProfile, opts: QuotaOptions = {}): Promise<QuotaReport | null> {
  try {
    const fetchImpl = opts.fetchImpl ?? defaultFetch;
    const { apiKey, token } = credentialFor(endpoint, opts);
    const baseUrl = endpoint.baseUrl?.replace(/\/+$/, "");
    switch (endpoint.type) {
      case "anthropic":
        if (token) return await probeAnthropic(token.accessToken, fetchImpl);
        // API-key accounts: documented per-minute rate-limit headers are
        // only attached to message responses, not probeable standalone —
        // report nothing rather than guess.
        return null;
      case "openai":
        return await probeOpenai({ token, apiKey, baseUrl }, fetchImpl);
      case "github-copilot":
        if (!token) return null;
        return await probeCopilot(token.accessToken, fetchImpl);
      case "openrouter":
        return await probeOpenrouter({ apiKey, token }, fetchImpl);
      case "xai":
        if (token) return await probeXai(token.accessToken, fetchImpl);
        return null;
      case "kimi-coding":
        if (token) return await probeKimi(token.accessToken, fetchImpl);
        return null;
      case "openai-compat":
        // z.ai / Zhipu is the only compat host with a known quota endpoint
        // (unstable schema); every other compat host reports nothing.
        if (baseUrl && new URL(baseUrl).hostname === "api.z.ai") {
          return await probeZai({ apiKey, token }, fetchImpl);
        }
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
