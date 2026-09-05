/**
 * #499: z.ai / Zhipu coding-plan quota probe. Undocumented and the least
 * stable schema of the set (`api.z.ai/api/monitor/usage/quota/limit`):
 * percent per 5h/weekly window. Any parse failure degrades to `null`.
 */
import type { QuotaFetch, QuotaReport } from "./types";

export const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

export async function probeZai(
  cred: { apiKey?: string; token?: { accessToken: string } },
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const bearer = cred.apiKey ?? cred.token?.accessToken;
  if (!bearer) return null;
  const res = await fetchImpl(ZAI_QUOTA_URL, { authorization: `Bearer ${bearer}` });
  if (res.status !== 200) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Both `{ data: {...} }` and flat shapes are seen in the wild.
  const root =
    json.data && typeof json.data === "object" ? (json.data as Record<string, unknown>) : json;
  const windows: QuotaReport["windows"] = [];
  const windowFrom = (raw: unknown, label: string) => {
    if (raw === null || typeof raw !== "object") return;
    const rec = raw as Record<string, unknown>;
    const percent = firstNumber(rec, ["percent_used", "usage_percent", "percent"]);
    const resetAt = firstNumber(rec, ["reset_time", "reset_at"]);
    if (percent !== undefined) {
      windows.push({
        label,
        percent: Math.max(0, Math.min(100, percent)),
        ...(resetAt !== undefined ? { resetAt: resetAt > 1e12 ? resetAt : resetAt * 1000 } : {}),
      });
    }
  };
  windowFrom(root.five_hour ?? root.fiveHour, "5h window");
  windowFrom(root.weekly ?? root.week, "weekly window");
  return windows.length > 0 ? { source: "undocumented", windows } : null;
}

function firstNumber(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}
