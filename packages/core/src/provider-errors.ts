import { ProviderError, type ProviderErrorKind } from "./types";

/**
 * The 9th taxonomy kind: `aborted`. Not an error in the failure sense —
 * it reports that the AbortSignal fired. Callers treat it as cancellation.
 */
export type AbortKind = "aborted";

type ErrorRecord = Record<string, unknown>;
const DETAIL_KEYS = ["message", "detail", "error_description", "responseBody", "error", "data", "cause"] as const;

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

  const status = findStatusCode(err);
  const message = describe(err);
  const body = describeKnownField(err, "responseBody", true)
    ?? describeKnownField(err, "data", true)
    ?? "";
  if (status !== undefined) {
    return new ProviderError(classifyStatus(status, body, message), message);
  }

  // Transport-level failures (fetch failed, DNS, sockets).
  if (err instanceof TypeError || /fetch|network|socket|ECONN|ENOTFOUND|ETIMEDOUT|timeout/i.test(message)) {
    return new ProviderError("network", message);
  }

  // SDK retry wrappers lose statusCode but keep the cause message; sniff it.
  const sniffed = classifyStatus(0, body, message);
  if (sniffed !== "invalid_request") return new ProviderError(sniffed, message);

  return new ProviderError("invalid_request", message);
}

/** #404: read only known diagnostic fields from SDK/provider error wrappers.
 * Traversal is bounded and cycle-safe; arbitrary object serialization could
 * expose headers or credentials and still produce unreadable output. */
function describe(err: unknown): string {
  const found = findDescription(err, new Set<object>(), 0);
  return found ?? "Unknown provider error";
}

function findDescription(value: unknown, seen: Set<object>, depth: number): string | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    if (!value || value === "[object Object]") return undefined;
    return parseBodyDescription(value, seen, depth) ?? boundedDescription(value);
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (value instanceof Error) {
    if (typeof value.message === "string" && value.message && value.message !== "[object Object]") {
      return boundedDescription(value.message);
    }
    // SDK errors may assign structured data to message or attach the useful
    // provider payload directly as responseBody/data/error properties.
    return findDescription((value as unknown as ErrorRecord).message, seen, depth + 1)
      ?? findRecordDescription(value as unknown as ErrorRecord, seen, depth + 1)
      ?? findDescription(value.cause, seen, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) {
      const found = findDescription(item, seen, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  return findRecordDescription(value as ErrorRecord, seen, depth);
}

function findRecordDescription(record: ErrorRecord, seen: Set<object>, depth: number): string | undefined {
  for (const key of DETAIL_KEYS) {
    const found = findDescription(record[key], seen, depth + 1);
    if (found) {
      const param = findStringField(record, "param", new Set<object>(), 0);
      return param && !found.includes(param) ? `${found} (param: ${param})` : found;
    }
  }
  return undefined;
}

function boundedDescription(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}…` : value;
}

function parseBodyDescription(value: string, seen: Set<object>, depth: number): string | undefined {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return findDescription(JSON.parse(trimmed), seen, depth + 1);
  } catch {
    return undefined;
  }
}

function findStatusCode(value: unknown, seen = new Set<object>(), depth = 0): number | undefined {
  if (depth > 6 || value === null || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (!Array.isArray(value)) {
    const record = value as ErrorRecord;
    if (typeof record.statusCode === "number") return record.statusCode;
    if (typeof record.status === "number") return record.status;
    for (const key of ["error", "cause", "data", "response"] as const) {
      const found = findStatusCode(record[key], seen, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function describeKnownField(value: unknown, field: string, boundedRaw = false): string | undefined {
  const found = findField(value, field, new Set<object>(), 0);
  if (typeof found === "string") {
    const structured = parseBodyDescription(found, new Set<object>(), 0);
    if (structured) return structured;
    return boundedRaw && found.length > 300 ? `${found.slice(0, 300)}…` : found;
  }
  return findDescription(found, new Set<object>(), 0);
}

function findStringField(value: unknown, field: string, seen: Set<object>, depth: number): string | undefined {
  const found = findField(value, field, seen, depth);
  return typeof found === "string" && found.length > 0 ? found : undefined;
}

function findField(value: unknown, field: string, seen: Set<object>, depth: number): unknown {
  if (depth > 6 || value === null || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) {
      const found = findField(item, field, seen, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as ErrorRecord;
  if (record[field] !== undefined) return record[field];
  for (const key of ["error", "cause", "data", "response"] as const) {
    const found = findField(record[key], field, seen, depth + 1);
    if (found !== undefined) return found;
  }
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
    if (/context (length|window)|too many tokens|maximum.*tokens/i.test(all)) return "context_length";
    return "invalid_request";
  }
  if (status === 529 || status === 503 || status === 502 || status === 500) return "overloaded";
  if (status >= 500) return "overloaded";
  return "invalid_request";
}

const QUOTA_HINTS = [
  "quota", "billing", "credit", "insufficient_quota", "monthly limit", "spending limit", "balance",
  "payment required", "insufficient balance", "usage limit", "recharge", "resource package",
];
const RATE_HINTS = [
  "rate limit", "rate_limit", "ratelimit", "too many requests", "requests per", "rpm", "tps",
  "concurrent", "throughput", "retry after", "overload",
];

/** 429 disambiguation: quota hints win, then rate hints; ambiguous or
 * hintless bodies default to `rate_limited` (per ADR/spec). */
export function disambiguate429(body: string): ProviderErrorKind {
  const text = body.toLowerCase();
  if (RATE_HINTS.some((h) => text.includes(h))) return "rate_limited";
  if (QUOTA_HINTS.some((h) => text.includes(h))) return "quota_exhausted";
  return "rate_limited";
}

/** Errors that justify trying the next endpoint in a fallback chain. */
export function isFallbackWorthy(err: unknown): boolean {
  return err instanceof ProviderError &&
    (err.kind === "quota_exhausted" || err.kind === "rate_limited" || err.kind === "overloaded" || err.kind === "network");
}

/** Errors worth one same-endpoint retry (with backoff) before falling back. */
export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderError && (err.kind === "rate_limited" || err.kind === "network" || err.kind === "overloaded");
}
