/**
 * #1429: all quota probes in one module. Each `probe*` function owns one
 * provider's request and schema parsing (schema churn stays a local fix);
 * the shared GET+parse and finite-number helpers live here once.
 * `getQuota` (./index) keeps the provider `switch`.
 */
import { ANTHROPIC_OAUTH_BETA } from "../auth/anthropic";
import { ANTHROPIC_USAGE_URL } from "../auth/lifecycle";
import { COPILOT_EDITOR_HEADERS } from "../auth/github-copilot";
import { KIMI_CODE_API_BASE_URL } from "../auth/kimi-coding";
import type { QuotaFetch, QuotaReport } from "./types";

/**
 * GET + JSON parse. `null` on a non-200 status or a parse failure; the
 * parsed value is otherwise returned unchecked. A throwing `fetchImpl`
 * propagates (`getQuota` degrades it to `null`).
 */
async function fetchJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: QuotaFetch,
): Promise<Record<string, unknown> | null> {
  const res = await fetchImpl(url, headers);
  if (res.status !== 200) return null;
  try {
    return JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const OPENAI_WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const COPILOT_QUOTA_URL = "https://api.github.com/copilot_internal/user";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const KIMI_USAGES_URL = `${KIMI_CODE_API_BASE_URL}/v1/usages`;
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

export async function probeAnthropic(
  accessToken: string,
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const json = await fetchJson(
    ANTHROPIC_USAGE_URL,
    {
      authorization: `Bearer ${accessToken}`,
      ...ANTHROPIC_OAUTH_BETA,
    },
    fetchImpl,
  );
  if (json === null) return null;
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

interface OpenaiProbeInput {
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
  const json = await fetchJson(
    OPENAI_WHAM_USAGE_URL,
    { authorization: `Bearer ${token.accessToken}` },
    fetchImpl,
  );
  if (json === null) return null;
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

export async function probeCopilot(
  accessToken: string,
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const json = await fetchJson(
    COPILOT_QUOTA_URL,
    {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      ...COPILOT_EDITOR_HEADERS,
    },
    fetchImpl,
  );
  if (json === null) return null;
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

export async function probeOpenrouter(
  cred: { apiKey?: string; token?: { accessToken: string } },
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const bearer = cred.apiKey ?? cred.token?.accessToken;
  if (!bearer) return null;
  const headers = { authorization: `Bearer ${bearer}` };

  const windows: QuotaReport["windows"] = [];
  const key = dataOf(await fetchJson(OPENROUTER_KEY_URL, headers, fetchImpl));
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

  const credits = dataOf(await fetchJson(OPENROUTER_CREDITS_URL, headers, fetchImpl));
  const total = credits ? numberAt(credits, "total_credits") : undefined;
  const used = credits ? numberAt(credits, "total_usage") : undefined;
  if (typeof total === "number" && typeof used === "number") {
    windows.push({ label: "credits", used, limit: total });
  }

  return windows.length > 0 ? { source: "official", windows } : null;
}

function dataOf(json: { data?: unknown } | null): Record<string, unknown> | undefined {
  if (json === null) return undefined;
  return json.data && typeof json.data === "object" ? (json.data as Record<string, unknown>) : undefined;
}

function numberAt(rec: Record<string, unknown>, key: string): number | undefined {
  return finiteNumber(rec[key]);
}

export async function probeXai(
  accessToken: string,
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const json = await fetchJson(XAI_BILLING_URL, { authorization: `Bearer ${accessToken}` }, fetchImpl);
  if (json === null) return null;
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

export async function probeKimi(
  accessToken: string,
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const json = await fetchJson(KIMI_USAGES_URL, { authorization: `Bearer ${accessToken}` }, fetchImpl);
  if (json === null) return null;
  const windows: QuotaReport["windows"] = [];
  const windowFrom = (raw: unknown, label: string) => {
    if (raw === null || typeof raw !== "object") return;
    const rec = raw as Record<string, unknown>;
    const used = finiteNumber(rec.used ?? rec.current_usage);
    const limit = finiteNumber(rec.limit ?? rec.total_usage);
    if (used !== undefined && limit !== undefined && limit > 0) {
      windows.push({
        label,
        used,
        limit,
        ...(finiteNumber(rec.reset_time) !== undefined ? { resetAt: finiteNumber(rec.reset_time)! * 1000 } : {}),
      });
    }
  };
  windowFrom(json.five_hour ?? json.fiveHour, "5h window");
  windowFrom(json.weekly ?? json.week, "weekly window");
  return windows.length > 0 ? { source: "undocumented", windows } : null;
}


export async function probeZai(
  cred: { apiKey?: string; token?: { accessToken: string } },
  fetchImpl: QuotaFetch,
): Promise<QuotaReport | null> {
  const bearer = cred.apiKey ?? cred.token?.accessToken;
  if (!bearer) return null;
  const json = await fetchJson(ZAI_QUOTA_URL, { authorization: `Bearer ${bearer}` }, fetchImpl);
  if (json === null) return null;
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
    const v = finiteNumber(rec[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}
