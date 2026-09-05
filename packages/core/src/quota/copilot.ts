/**
 * #499: GitHub Copilot quota probe. `api.github.com/copilot_internal/user`
 * (internal, high confidence): premium-interactions entitlement vs
 * remaining, with a reset timestamp. Requires the OAuth (copilot) token —
 * not the proxy token — with the standard editor headers.
 */
import { COPILOT_EDITOR_HEADERS } from "../auth/github-copilot";
import type { QuotaFetch, QuotaReport } from "./types";

export const COPILOT_QUOTA_URL = "https://api.github.com/copilot_internal/user";

export async function probeCopilot(
  accessToken: string,
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const res = await fetchImpl(COPILOT_QUOTA_URL, {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.github+json",
    ...COPILOT_EDITOR_HEADERS,
  });
  if (res.status !== 200) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const quota = json.quota_snapshots;
  if (quota === null || typeof quota !== "object") return null;
  const rec = quota as Record<string, unknown>;
  const windows: QuotaReport["windows"] = [];
  const snap = (raw: unknown, label: string) => {
    if (raw === null || typeof raw !== "object") return;
    const r = raw as Record<string, unknown>;
    if (typeof r.entitlement === "number" && typeof r.remaining === "number" && r.entitlement > 0) {
      windows.push({
        label,
        used: r.entitlement - r.remaining,
        limit: r.entitlement,
        ...(typeof r.reset_date === "string" && Number.isFinite(Date.parse(r.reset_date))
          ? { resetAt: Date.parse(r.reset_date) }
          : {}),
      });
    }
  };
  snap(rec.chat, "premium interactions");
  snap(rec.interactions, "interactions");
  return windows.length > 0 ? { source: "undocumented", windows } : null;
}
