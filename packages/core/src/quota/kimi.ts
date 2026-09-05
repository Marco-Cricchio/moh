/**
 * #499: Kimi (Moonshot coding plan) quota probe. Undocumented but
 * best-structured: `api.kimi.com/coding/v1/usages` returns used/limit
 * per 5h and weekly window.
 */
import { KIMI_CODE_API_BASE_URL } from "../auth/kimi-coding";
import type { QuotaFetch, QuotaReport } from "./types";

export const KIMI_USAGES_URL = `${KIMI_CODE_API_BASE_URL}/v1/usages`;

export async function probeKimi(
  accessToken: string,
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const res = await fetchImpl(KIMI_USAGES_URL, { authorization: `Bearer ${accessToken}` });
  if (res.status !== 200) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const windows: QuotaReport["windows"] = [];
  const windowFrom = (raw: unknown, label: string) => {
    if (raw === null || typeof raw !== "object") return;
    const rec = raw as Record<string, unknown>;
    const used = num(rec.used ?? rec.current_usage);
    const limit = num(rec.limit ?? rec.total_usage);
    if (used !== undefined && limit !== undefined && limit > 0) {
      windows.push({
        label,
        used,
        limit,
        ...(num(rec.reset_time) !== undefined ? { resetAt: num(rec.reset_time)! * 1000 } : {}),
      });
    }
  };
  windowFrom(json.five_hour ?? json.fiveHour, "5h window");
  windowFrom(json.weekly ?? json.week, "weekly window");
  return windows.length > 0 ? { source: "undocumented", windows } : null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
