/**
 * #499: OpenAI quota probe. Two shapes: ChatGPT OAuth grants ride the
 * undocumented `chatgpt.com/backend-api/wham/usage` (percent windows,
 * plan); API-key endpoints have no probeable standalone quota without an
 * admin key — they report `null` and the modal shows local measurement.
 */
import type { QuotaFetch, QuotaReport } from "./types";

export const OPENAI_WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export interface OpenaiProbeInput {
  token?: { accessToken: string; grant?: Record<string, unknown> };
  apiKey?: string;
  baseUrl?: string;
}

export async function probeOpenai(
  input: OpenaiProbeInput,
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const token = input.token;
  // Only native (un-minted) ChatGPT grants have plan usage. A minted API
  // key (grant.minted !== false) has no probeable quota endpoint.
  if (!token || token.grant?.minted !== false) return null;
  const res = await fetchImpl(OPENAI_WHAM_USAGE_URL, {
    authorization: `Bearer ${token.accessToken}`,
  });
  if (res.status !== 200) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const windows: QuotaReport["windows"] = [];
  const push = (raw: unknown, label: string) => {
    const w = percentWindow(raw, label);
    if (w) windows.push(w);
  };
  push(json.five_hour, "5h window");
  push(json.weekly, "weekly window");
  push(json.monthly, "monthly window");
  return windows.length > 0 ? { source: "undocumented", windows } : null;
}

/** `{ percent_left }` / `{ utilization }` shapes collapse to one read. */
function percentWindow(raw: unknown, label: string): QuotaReport["windows"][number] | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  let percent: number | undefined;
  if (typeof rec.percent_left === "number") percent = clamp(100 - rec.percent_left);
  else if (typeof rec.utilization === "number") percent = clamp(rec.utilization <= 1 ? rec.utilization * 100 : rec.utilization);
  const resetAt = typeof rec.reset_at === "number" ? rec.reset_at : undefined;
  if (percent === undefined && resetAt === undefined) return undefined;
  return { label, percent, resetAt };
}

function clamp(v: number): number | undefined {
  if (!Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(100, v));
}
