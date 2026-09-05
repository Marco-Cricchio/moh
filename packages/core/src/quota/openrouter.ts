/**
 * #499: OpenRouter quota probe — the one fully documented source:
 * `openrouter.ai/api/v1/key` returns limit/usage; `/credits` returns the
 * credit balance. Auth accepts a stored OAuth token or the API key.
 */
import type { QuotaFetch, QuotaReport } from "./types";

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

export async function probeOpenrouter(
  cred: { apiKey?: string; token?: { accessToken: string } },
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const bearer = cred.apiKey ?? cred.token?.accessToken;
  if (!bearer) return null;
  const headers = { authorization: `Bearer ${bearer}` };

  const windows: QuotaReport["windows"] = [];
  const keyRes = await fetchImpl(OPENROUTER_KEY_URL, headers);
  if (keyRes.status === 200) {
    const key = dataOf(keyRes.text);
    if (key) {
      const limit = numberAt(key, "limit");
      const usage = numberAt(key, "usage");
      if (typeof limit === "number" && typeof usage === "number") {
        windows.push({ label: "limit", used: usage, limit });
      }
      const rateLimit = key.rate_limit;
      if (rateLimit && typeof rateLimit === "object") {
        const rl = rateLimit as Record<string, unknown>;
        const requests = typeof rl.requests === "number" ? rl.requests : undefined;
        const interval = typeof rl.interval === "string" ? rl.interval : undefined;
        if (requests !== undefined) {
          windows.push({ label: `rate limit (${interval ?? "?"})`, used: undefined, limit: requests });
        }
      }
    }
  }

  const creditsRes = await fetchImpl(OPENROUTER_CREDITS_URL, headers);
  if (creditsRes.status === 200) {
    const credits = dataOf(creditsRes.text);
    const total = credits ? numberAt(credits, "total_credits") : undefined;
    const used = credits ? numberAt(credits, "total_usage") : undefined;
    if (typeof total === "number" && typeof used === "number") {
      windows.push({ label: "credits", used, limit: total });
    }
  }

  return windows.length > 0 ? { source: "official", windows } : null;
}

function dataOf(text: string): Record<string, unknown> | undefined {
  try {
    const json = JSON.parse(text) as { data?: unknown };
    return json.data && typeof json.data === "object" ? (json.data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function numberAt(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
