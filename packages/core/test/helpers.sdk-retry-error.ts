/**
 * #1318: the AI SDK retry wrapper as the SDK itself builds it — the real
 * failure in `errors`, `lastError` as their last entry, the wrapper's own
 * message a retelling of it, and no `cause`
 * (ai/src/util/retry-error.ts,
 * provider-utils/src/retry-with-exponential-backoff.ts:103,138).
 * Shared by the cases that assert a wrapped failure behaves like a direct
 * one, so all of them speak the same shape.
 */
import { APICallError, RetryError } from "ai";

/** A provider refusal as a stream error carries it: the provider's own
 * message, the HTTP status, the raw response body, the response headers. */
export function apiCallError(statusCode: number, body: string, headers?: Record<string, string>): APICallError {
  return new APICallError({
    message: (JSON.parse(body) as { error: { message: string } }).error.message,
    url: "https://api.example.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody: body,
    responseHeaders: headers,
    isRetryable: true,
  });
}

/** The wrapper the SDK throws when its retry budget runs out, and — with
 * `nonRetryable: true` — the variant for a failure it did not retry
 * (both shapes, same payload). */
export function sdkRetryWrapper(error: Error, opts: { nonRetryable?: boolean } = {}): RetryError {
  return new RetryError({
    message: opts.nonRetryable
      ? `Failed after 3 attempts with non-retryable error: '${error.toString()}'`
      : `Failed after 3 attempts. Last error: ${error.toString()}`,
    reason: opts.nonRetryable ? "errorNotRetryable" : "maxRetriesExceeded",
    errors: [error, error, error],
  });
}

export const RATE_LIMIT_BODY = JSON.stringify({
  type: "error",
  error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" },
});
