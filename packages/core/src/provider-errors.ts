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
      describe(err),
    );
  }

  // Transport-level failures (fetch failed, DNS, sockets).
  if (err instanceof TypeError || /fetch|network|socket|ECONN|ENOTFOUND|ETIMEDOUT|timeout/i.test(String((err as Error)?.message ?? err))) {
    return new ProviderError("network", describe(err));
  }

  return new ProviderError("invalid_request", describe(err));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Status-code classification, with 429 body disambiguation. */
export function classifyStatus(status: number, body: string, message: string): ProviderErrorKind {
  if (status === 429) return disambiguate429(body);
  if (status === 401) return "auth";
  if (status === 403) {
    if (/content polic|safety|moderation/i.test(body + " " + message)) return "content_filtered";
    return "auth";
  }
  if (status === 402) return "quota_exhausted";
  if (status === 404) return "invalid_request";
  if (status === 408 || status === 504) return "network";
  if (status === 413) return "context_length";
  if (status === 422 || status === 400) {
    if (/context (length|window)|too many tokens|maximum.*tokens/i.test(body + " " + message)) {
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
