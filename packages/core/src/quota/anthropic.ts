/**
 * #499: Anthropic OAuth usage probe. Endpoint is undocumented but stable
 * (beta `oauth-2025-04-20`): five-hour and weekly windows, percent plus
 * reset times. Drifted shapes degrade to `null` inside the parser.
 */
import { ANTHROPIC_OAUTH_BETA } from "../auth/anthropic";
import type { QuotaFetch, QuotaReport } from "./types";

export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export async function probeAnthropic(
  accessToken: string,
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const res = await fetchImpl(ANTHROPIC_USAGE_URL, {
    authorization: `Bearer ${accessToken}`,
    ...ANTHROPIC_OAUTH_BETA,
  });
  if (res.status !== 200) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const windows: QuotaReport["windows"] = [];
  const fiveHour = windowFrom(json.five_hour, "5h window");
  if (fiveHour) windows.push(fiveHour);
  const sevenDay = windowFrom(json.seven_day, "weekly window");
  if (sevenDay) windows.push(sevenDay);
  return windows.length > 0 ? { source: "undocumented", windows } : null;
}

/** Extracts one window from Anthropic's `utilization`/`resets_at` shape. */
function windowFrom(raw: unknown, label: string): QuotaReport["windows"][number] | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const util = rec.utilization;
  const percent =
    typeof util === "number" && Number.isFinite(util)
      ? util <= 1
        ? util * 100
        : util
      : undefined;
  const resetAt = typeof rec.resets_at === "number" ? rec.resets_at * 1000 : undefined;
  if (percent === undefined && resetAt === undefined) return undefined;
  return { label, percent, resetAt };
}
