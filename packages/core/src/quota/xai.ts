/**
 * #499: xAI SuperGrok OAuth quota probe. Undocumented endpoint:
 * `cli-chat-proxy.grok.com/v1/billing?format=credits` — percent for the
 * current period. Drifted shapes degrade to `null`.
 */
import type { QuotaFetch, QuotaReport } from "./types";

export const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export async function probeXai(
  accessToken: string,
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const res = await fetchImpl(XAI_BILLING_URL, { authorization: `Bearer ${accessToken}` });
  if (res.status !== 200) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const windows: QuotaReport["windows"] = [];
  for (const key of ["credits", "current_period", "period"]) {
    const raw = json[key];
    if (raw && typeof raw === "object") {
      const rec = raw as Record<string, unknown>;
      const percent = percentOf(rec);
      if (percent !== undefined) {
        windows.push({
          label: "current period",
          percent,
          ...(resetAtOf(rec) !== undefined ? { resetAt: resetAtOf(rec)! } : {}),
        });
        break;
      }
    }
  }
  if (windows.length === 0) {
    // Flat shape: top-level remaining/total.
    const percent = percentOf(json);
    if (percent !== undefined) windows.push({ label: "current period", percent });
  }
  return windows.length > 0 ? { source: "undocumented", windows } : null;
}

function percentOf(rec: Record<string, unknown>): number | undefined {
  const rem = rec.remaining_credits ?? rec.remaining;
  const total = rec.total_credits ?? rec.total;
  if (typeof rem === "number" && typeof total === "number" && total > 0) {
    return Math.max(0, Math.min(100, ((total - rem) / total) * 100));
  }
  if (typeof rec.percent_used === "number") return Math.max(0, Math.min(100, rec.percent_used));
  return undefined;
}

function resetAtOf(rec: Record<string, unknown>): number | undefined {
  const v = rec.reset_at ?? rec.resets_at ?? rec.period_end;
  return typeof v === "number" ? v * (v > 1e12 ? 1 : 1000) : undefined;
}
