import { ProviderError, type ProviderErrorKind } from "./types";

/**
 * The 9th taxonomy kind: `aborted`. Not an error in the failure sense —
 * it reports that the AbortSignal fired. Callers treat it as cancellation.
 */
export type AbortKind = "aborted";

/**
 * Normalizes any thrown value into a ProviderError of the 9-kind taxonomy.
 * Unknown failures map to `network` when they look like transport errors,
 * otherwise `invalid_request`-adjacent failures keep their message and map
 * to `invalid_request`; nothing escapes this function un-normalized.
 */
export function normalizeProviderError(err: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.aborted) return new ProviderError("aborted", "request aborted by signal");
  if (err instanceof ProviderError) return err;

  if (err instanceof Error && err.name === "AbortError") {
    return new ProviderError("aborted", "request aborted by signal");
  }

  // Vercel AI SDK APICallError: carries statusCode and responseBody.
  const anyErr = err as { statusCode?: number; responseBody?: string; message?: string } | null;
  if (typeof anyErr?.statusCode === "number") {
    return new ProviderError(
      classifyStatus(anyErr.statusCode, anyErr.responseBody ?? "", anyErr.message ?? ""),
      // #404: the AI SDK stream may surface the error as a plain object
      // without a string message — fall back to the responseBody hint.
      describe(err) === describeFallback(anyErr) ? extractBodyHint(anyErr.responseBody) ?? describe(err) : describe(err),
    );
  }

  // Transport-level failures (fetch failed, DNS, sockets).
  if (err instanceof TypeError || /fetch|network|socket|ECONN|ENOTFOUND|ETIMEDOUT|timeout/i.test(String((err as Error)?.message ?? err))) {
    return new ProviderError("network", describe(err));
  }

  // SDK retry wrappers lose statusCode but keep the cause message; sniff it.
  const msg = describe(err);
  const sniffed = classifyStatus(0, "", msg);
  if (sniffed !== "invalid_request") return new ProviderError(sniffed, msg);

  return new ProviderError("invalid_request", msg);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  // #404: the AI SDK stream may surface the error as a plain object
  // without a string message — String() would render it "[object Object]".
  const msg = (err as { message?: unknown } | null)?.message;
  if (typeof msg === "string" && msg.length > 0) return msg;
  return String(err);
}

/** #404: the description a plain object without a message would produce. */
function describeFallback(anyErr: { message?: string }): string {
  const msg = anyErr?.message;
  if (typeof msg === "string" && msg.length > 0) return msg;
  return "[object Object]";
}

/** #404: pull a human-readable message out of a provider error body. */
function extractBodyHint(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; param?: unknown } | Array<{ message?: unknown; param?: unknown }>;
      message?: unknown;
      detail?: unknown;
    };
    const inner = Array.isArray(parsed.error) ? parsed.error[0] : parsed.error;
    const candidate = inner?.message ?? parsed.message ?? parsed.detail;
    if (typeof candidate === "string" && candidate.length > 0) {
      const param = typeof inner?.param === "string" ? inner.param : undefined;
      return param && !candidate.includes(param) ? `${candidate} (param: ${param})` : candidate;
    }
  } catch {
    // Not JSON: use a truncated body as the hint.
  }
  if (body.length > 0) return body.length > 300 ? `${body.slice(0, 300)}…` : body;
  return undefined;
}

/** Status-code classification, with body hints and 429 disambiguation. */
export function classifyStatus(status: number, body: string, message: string): ProviderErrorKind {
  const all = `${body} ${message}`.toLowerCase();
  // Body hints beat status codes: providers report billing failures with
  // varying statuses (z.ai: 400 + code 1113 "Insufficient balance").
  if (QUOTA_HINTS.some((h) => all.includes(h))) return "quota_exhausted";
  if (status === 429) return "rate_limited";
  if (status === 401) return "auth";
  if (status === 403) {
    if (/content polic|safety|moderation/i.test(all)) return "content_filtered";
    return "auth";
  }
  if (status === 402) return "quota_exhausted";
  if (status === 404) return "invalid_request";
  if (status === 408 || status === 504) return "network";
  if (status === 413) return "context_length";
  if (status === 422 || status === 400) {
    if (/context (length|window)|too many tokens|maximum.*tokens/i.test(all)) {
      return "context_length";
    }
    return "invalid_request";
  }
  if (status === 529 || status === 503 || status === 502 || status === 500) return "overloaded";
  if (status >= 500) return "overloaded";
  return "invalid_request";
}

const QUOTA_HINTS = [
  "quota",
  "billing",
  "credit",
  "insufficient_quota",
  "monthly limit",
  "spending limit",
  "balance",
  "payment required",
  "insufficient balance",
  "usage limit",
  "recharge",
  "resource package",
];
const RATE_HINTS = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "too many requests",
  "requests per",
  "rpm",
  "tps",
  "concurrent",
  "throughput",
  "retry after",
  "overload",
];

/**
 * 429 disambiguation: quota hints win, then rate hints; ambiguous or
 * hintless bodies default to `rate_limited` (per ADR/spec).
 */
export function disambiguate429(body: string): ProviderErrorKind {
  const text = body.toLowerCase();
  if (RATE_HINTS.some((h) => text.includes(h))) return "rate_limited";
  if (QUOTA_HINTS.some((h) => text.includes(h))) return "quota_exhausted";
  return "rate_limited";
}

/** Errors that justify trying the next endpoint in a fallback chain. */
export function isFallbackWorthy(err: unknown): boolean {
  return (
    err instanceof ProviderError &&
    (err.kind === "quota_exhausted" || err.kind === "rate_limited" || err.kind === "overloaded" || err.kind === "network")
  );
}

/** Errors worth one same-endpoint retry (with backoff) before falling back. */
export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderError && (err.kind === "rate_limited" || err.kind === "network" || err.kind === "overloaded");
}
