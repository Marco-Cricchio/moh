/**
 * Public quota types (issue #499, vision note 30). The seam is narrow:
 * `getQuota(endpoint)` returns windows with a source badge, or `null`
 * when the endpoint exposes no quota or the probe fails. Every unstable
 * / undocumented remote schema stays internal to its per-provider
 * module — churn there is a local fix and never surfaces here.
 */

/** How authoritative the numbers are: `official` = documented API,
 * `undocumented` = provider-reported (internal/unstable endpoint). */
export type QuotaSource = "official" | "undocumented";

/** One usage window (5h / weekly / monthly / per-minute …). A window
 * carries a percent, or a used/limit pair, plus an optional reset time. */
export interface QuotaWindow {
  label: string;
  /** 0–100. Present when the provider reports utilization only. */
  percent?: number;
  /** Used/limit pair when the provider reports absolute numbers. */
  used?: number;
  limit?: number;
  /** Reset time, epoch ms (absent = unknown). */
  resetAt?: number;
}

export interface QuotaReport {
  source: QuotaSource;
  windows: QuotaWindow[];
}

/** HTTP seam (GET with headers); tests script it. Never throws past the
 * caller: `getQuota` degrades any failure to `null`. */
export type QuotaFetch = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ status: number; text: string }>;

export interface QuotaOptions {
  /** HTTP seam. Default: global `fetch`. */
  fetchImpl?: QuotaFetch;
  /** Auth store location. Default: `~/.moh/config` via the guardian. */
  configFile?: string;
  /** Env for api-key fallback (`MOH_ENDPOINT_<NAME>_API_KEY`). */
  env?: Record<string, string | undefined>;
}
