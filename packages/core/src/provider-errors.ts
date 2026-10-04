import { ProviderError, type ProviderErrorKind } from "./types";
import { recognizeDeclaredWindow } from "./declared-window";

/**
 * The 9th taxonomy kind: `aborted`. Not an error in the failure sense —
 * it reports that the AbortSignal fired. Callers treat it as cancellation.
 */
export type AbortKind = "aborted";

type ErrorRecord = Record<string, unknown>;
const DETAIL_KEYS = ["message", "detail", "error_description", "responseBody", "error", "data", "cause"] as const;
/** ADR-0049: total characters scanned for a declared window per failure.
 * Recognition must see the untruncated text, and a provider payload is
 * bounded by the transport long before this; the cap only stops a
 * pathological object from costing more than a constant. */
const RECOGNITION_TEXT_CAP = 64_000;

/**
 * Normalizes any thrown value into a ProviderError of the 9-kind taxonomy.
 * Unknown failures map to `network` when they look like transport errors,
 * otherwise `invalid_request`-adjacent failures keep their message and map
 * to `invalid_request`; nothing escapes this function un-normalized.
 *
 * ADR-0049 (door one, #986): the *kind* classification stays exactly as it
 * was, and so does the bounded `message`. In addition, a window the
 * provider declares in a formula moh knows (`recognizeDeclaredWindow`) is
 * extracted here — before the 300-character cap the classifier and the log
 * live under — and rides the ProviderError as `declaredWindow`. Whether it
 * is adopted is the session's decision (only a real `context_length`
 * refusal teaches), never this function's.
 */
export function normalizeProviderError(err: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.aborted) return new ProviderError("aborted", "request aborted by signal");
  if (err instanceof ProviderError) return err;

  if (err instanceof Error && err.name === "AbortError") {
    return new ProviderError("aborted", "request aborted by signal");
  }

  const rawText = untruncatedText(err);
  const declaredWindow = recognizeDeclaredWindow(rawText);

  const status = findStatusCode(err);
  const message = describe(err);
  const body = describeKnownField(err, "responseBody", true)
    ?? describeKnownField(err, "data", true)
    ?? "";
  // #1099: sanitized transport facts — the status number and, when the
  // provider surfaced one, the Retry-After hint in ms. Read from known
  // fields only (never arbitrary headers/serialization); both are optional.
  const retryAfterMs = retryAfterMsOf(err);
  const transport =
    status !== undefined || retryAfterMs !== undefined
      ? { ...(status !== undefined ? { httpStatus: status } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
      : undefined;
  const fail = (kind: ProviderErrorKind, message: string) =>
    new ProviderError(kind, message, declaredWindow, transport);
  if (status !== undefined) {
    // #1199: the 400/422 refusal branch reads the untruncated text too —
    // a verbose refusal whose formula sits past the 300-character cap
    // must still classify `context_length`, or the kind-gated learning
    // would silently drop it while its window rides unrecognized.
    return fail(classifyStatus(status, body, message, rawText), message);
  }

  // Transport-level failures (fetch failed, DNS, sockets).
  if (err instanceof TypeError || /fetch|network|socket|ECONN|ENOTFOUND|ETIMEDOUT|timeout/i.test(message)) {
    return fail("network", message);
  }

    // SDK retry wrappers lose statusCode but keep the cause message; sniff it.
  const sniffed = classifyStatus(0, body, message);
  if (sniffed !== "invalid_request") return fail(sniffed, message);

  return fail("invalid_request", message);
}

/**
 * #1099: the Retry-After hint a provider surfaced with a failure, in ms —
 * read from known diagnostic fields only (`responseHeaders`/`headers`
 * carrying a `retry-after` key; never an arbitrary serialization). Accepts
 * seconds as number or decimal string, or an HTTP-date. Undefined when
 * nothing usable is there.
 */
function retryAfterMsOf(err: unknown): number | undefined {
  const headers = findField(err, "responseHeaders", new Set<object>(), 0)
    ?? findField(err, "headers", new Set<object>(), 0);
  if (headers === null || typeof headers !== "object") return undefined;
  const record = headers as ErrorRecord;
  const raw = record["retry-after"] ?? record["Retry-After"];
  if (typeof raw === "number" && raw >= 0) return raw * 1000;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 40) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * ADR-0049: every string the failure carries, unbounded — the raw material
 * recognition reads. `describe()`/`boundedDescription()` cap at 300
 * characters for the classifier, the log and the clients, which is exactly
 * why a verbose refusal can lose its window before anything reads it; this
 * pass walks the same known diagnostic fields (never an arbitrary
 * serialization: credentials and headers must not be scanned or logged)
 * and stops at a total budget.
 */
function untruncatedText(err: unknown): string {
  const parts: string[] = [];
  collectRawText(err, parts, new Set<object>(), 0, { left: RECOGNITION_TEXT_CAP });
  return parts.join("\n");
}

function collectRawText(value: unknown, out: string[], seen: Set<object>, depth: number, budget: { left: number }): void {
  if (budget.left <= 0 || depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (!value || value === "[object Object]") return;
    out.push(value.slice(0, budget.left));
    budget.left -= value.length;
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) collectRawText(item, out, seen, depth + 1, budget);
    return;
  }
  const record = value as ErrorRecord;
  // A JSON-encoded body keeps its message inside the string — parse it the
  // same way the bounded path does, so the window is reachable either way.
  for (const key of DETAIL_KEYS) {
    const field = record[key];
    if (typeof field === "string" && (field.trim().startsWith("{") || field.trim().startsWith("["))) {
      try {
        collectRawText(JSON.parse(field), out, seen, depth + 1, budget);
        continue;
      } catch {
        // Not JSON after all: fall through to the raw string.
      }
    }
    collectRawText(field, out, seen, depth + 1, budget);
  }
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

/** Status-code classification, with body hints and 429 disambiguation.
 * `recognitionText` (#1199) is the untruncated failure text when the
 * caller has it: the shipped declared-window formulas are refusal
 * evidence, and a verbose refusal can lose its formula to the
 * 300-character cap that bounds `body`/`message`. */
export function classifyStatus(status: number, body: string, message: string, recognitionText?: string): ProviderErrorKind {
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
    // #1199: the shipped declared-window formulas are themselves refusal
    // evidence — a provider that states its window is refusing the
    // request, whatever the classifier's keyword net catches. This is what
    // keeps a real Anthropic/Moonshot/llama.cpp overflow (whose wording
    // the keyword regex misses) `context_length`, so it still reaches the
    // session's learning hook now that the hook is gated on the kind.
    // Read on the untruncated text when the caller has it (ADR-0049:
    // recognition happens where the number still exists).
    if (recognizeDeclaredWindow(recognitionText ?? `${body} ${message}`) !== undefined) return "context_length";
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

/** Errors that justify trying the next endpoint in a fallback chain.
 * #853: `empty_completion` (the route's classification of a finished-but
 * contentless call) is fallback-worthy — the serving endpoint demonstrably
 * cannot serve, so the chain must fire. */
export function isFallbackWorthy(err: unknown): boolean {
  return err instanceof ProviderError &&
    (err.kind === "quota_exhausted" || err.kind === "rate_limited" || err.kind === "overloaded" || err.kind === "network" || err.kind === "empty_completion");
}

/** Errors worth one same-endpoint retry (with backoff) before falling back. */
export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderError && (err.kind === "rate_limited" || err.kind === "network" || err.kind === "overloaded");
}
