/**
 * The Jev (TypeSafe System One) HTTP client (#784).
 *
 * No dependencies, no SDK: one `fetch` to the fixed endpoint. Shaped for a
 * mechanical extraction to a shared `@moh/jev` package when the second
 * consumer lands (#787 routing) — nothing here imports `@moh/core`.
 *
 * Wire contract (docs.typesafe.ai/api):
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   { "state": <string|object|array>, "model": "jev-latest",
 *     "questions": { "<id>": { "type": "noul"|"choice"|"score",
 *                              "instructions": ..., "criteria"?: ... } } }
 *
 *   { "model": "...", "answers": { "<id>": <typed answer> },
 *     "usage": { "input_tokens": N, "output_tokens": N } }
 *
 * Failure model: the client NEVER throws to its caller and NEVER synthesizes
 * a judgment (no silent fallback — ADR-0005 spirit). Every failure is a
 * typed `{ ok: false, kind }`, and the caller fails open.
 */

/** The fixed evaluation endpoint (ratified: no override — a fixed endpoint
 * is also an exfiltration guard). */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** The fixed model alias (ratified: no override). */
export const JEV_MODEL = "jev-latest";

/** Default hook timeout for one call, ms (config: `typesafe.timeoutMs`). */
export const JEV_TIMEOUT_MS_DEFAULT = 2500;

/** The one retry waits this long when the response carries no `retry-after`. */
export const JEV_RETRY_DELAY_MS = 300;

/** A `retry-after` above this is not waited on: fail open instead. */
export const JEV_RETRY_AFTER_MAX_MS = 1000;

/** Instructions may be a plain string or structured JSON (docs: "advanced"). */
export type JevInstructions = string | Record<string, unknown> | unknown[];

/** A yes/no question; the answer is the probability that the answer is yes. */
export interface JevNoulQuestion {
  type: "noul";
  instructions: JevInstructions;
  criteria?: { true?: string; false?: string };
}

/** Pick one option from a set; the answer carries the full distribution. */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: JevInstructions;
  /** Option → rubric description (`null` when the option needs none). */
  criteria: Record<string, string | null>;
}

/** Rate the state along ordered levels (at least two). */
export interface JevScoreQuestion {
  type: "score";
  instructions: JevInstructions;
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

/** One answer, keyed as the question was (the typed shapes of the API). */
export interface JevNoulAnswer {
  type: "noul";
  /** 0 (no) to 1 (yes). */
  noul: number;
}
export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  /** Derived from the distribution; 0–1. */
  confidence: number;
}
export interface JevScoreAnswer {
  type: "score";
  /** Probability-weighted position across the levels; may land between them. */
  score: number;
  /** Level index (as a string key) → level description. */
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

/** Why a call did not produce a judgment. */
export type JevFailureKind = "timeout" | "auth" | "rate_limited" | "network" | "invalid" | "unknown";

export type JevOutcome =
  | {
      ok: true;
      /** Answers keyed as the questions were. */
      answers: Record<string, JevAnswer>;
      /** The model that performed the evaluation (echoed by the service). */
      model: string;
      /** Wall-clock latency of the call that produced this outcome, ms. */
      latencyMs: number;
      usage: { inputTokens: number; outputTokens: number };
    }
  | { ok: false; kind: JevFailureKind; message: string };

/** The metadata the client hands to `JevJudgeInput.record`. */
export interface JevJudgmentMeta {
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

/** One request to judge. */
export interface JevJudgeInput {
  /** The content under evaluation (a string, or structured state). */
  state: unknown;
  /** The typed questions, keyed as the answers should come back. */
  questions: Record<string, JevQuestion>;
  /**
   * Builds the payload appended to the session log for this judgment
   * (including a pass). Required: the client records every judgment through
   * this hook, so no caller can sample them away (ratified: no sampling).
   *
   * Returning `null` hands the record to the caller instead: the client
   * appends nothing, and the caller owns the entry (used by a check whose
   * outcome — the user's answer to a confirmation — is not known yet, and
   * which must still be recorded exactly once).
   */
  record: (answers: Record<string, JevAnswer>, meta: JevJudgmentMeta) => Record<string, unknown> | null;
  /** The turn's abort signal, composed with the timeout. */
  signal?: AbortSignal;
}

export interface JevClientOptions {
  /** TypeSafe API key. Never logged, never echoed. */
  apiKey: string;
  /** Per-call timeout in ms. Default `JEV_TIMEOUT_MS_DEFAULT`. */
  timeoutMs?: number;
  /** Test seam: the fetch implementation. Default: global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam: clock. Default `Date.now`. */
  now?: () => number;
  /** Test seam: sleep, used by the single retry. Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called once per completed judgment with the payload built by
   * `JevJudgeInput.record` (the extension turns it into `ctx.appendEvent`).
   * A throw here is swallowed: observability never breaks the caller.
   */
  onJudgment?: (record: Record<string, unknown>) => void;
  /**
   * Called with this client's connectivity status: `text` when it goes
   * down, `null` when it recovers. Announced once per transition — never
   * per call (the caller maps it to `ctx.setStatus`).
   */
  onStatus?: (text: string | null) => void;
}

export interface JevClient {
  /** One judgment call; never throws. */
  judge(input: JevJudgeInput): Promise<JevOutcome>;
}

/** The status text an outage publishes (ratified copy). */
export const JEV_OFFLINE_STATUS = "∅ jev offline";

function failure(kind: JevFailureKind, message: string): { ok: false; kind: JevFailureKind; message: string } {
  return { ok: false, kind, message };
}

/** `retry-after` supports both the seconds and the HTTP-date forms. */
function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

function errorKind(status: number): JevFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 422) return "invalid";
  return "unknown";
}

/** Parses a successful body; null when the shape is not the documented one. */
function parseSuccess(body: unknown, model: string, latencyMs: number): JevOutcome {
  if (body === null || typeof body !== "object") return failure("invalid", "response body was not an object");
  const b = body as { answers?: unknown; model?: unknown; usage?: unknown };
  if (b.answers === null || typeof b.answers !== "object") {
    return failure("invalid", "response carried no answers map");
  }
  const usage = (b.usage ?? {}) as { input_tokens?: unknown; output_tokens?: unknown };
  return {
    ok: true,
    answers: b.answers as Record<string, JevAnswer>,
    model: typeof b.model === "string" ? b.model : model,
    latencyMs,
    usage: {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    },
  };
}

/**
 * Validates a key with one real, minimal call (~500 input tokens, the
 * ratified key-save behaviour of the Settings entry). The three outcomes
 * are deliberately distinct: an invalid key must NOT be persisted, an
 * unreachable service must be (fail-open, and the user typed what they
 * meant) — conflating the two would either lose a good key or store a bad
 * one.
 */
export type JevKeyValidation =
  | { status: "active"; latencyMs: number }
  | { status: "invalid"; message: string }
  | { status: "unreachable"; kind: JevFailureKind; message: string };

/** The cheapest possible question: one noul over a two-word state. */
export async function validateJevKey(
  apiKey: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<JevKeyValidation> {
  const client = createJevClient({
    apiKey,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const outcome = await client.judge({
    state: "ok",
    questions: {
      is_ok: { type: "noul", instructions: "Is this state the single word ok?" },
    },
    record: () => ({}),
  });
  if (outcome.ok) return { status: "active", latencyMs: outcome.latencyMs };
  if (outcome.kind === "auth" || outcome.kind === "invalid") {
    return { status: "invalid", message: outcome.message };
  }
  return { status: "unreachable", kind: outcome.kind, message: outcome.message };
}

/**
 * Builds a client over the fixed endpoint. Stateless by design: caching is
 * the caller's concern (the guardrail's session cache, #786).
 */
export function createJevClient(options: JevClientOptions): JevClient {
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS_DEFAULT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** Connectivity status as the client last published it. */
  let offline = false;

  const setOffline = (value: boolean): void => {
    if (offline === value) return;
    offline = value;
    options.onStatus?.(value ? JEV_OFFLINE_STATUS : null);
  };

  /**
   * One HTTP attempt. `{ retryAfterMs }` means "the caller may wait this
   * long and try once more". Retries are only offered for the failures a
   * retry can actually fix — rate limiting, overload, server errors and
   * transport failures. An auth or validation failure is deterministic:
   * retrying it would only add latency (ratified: at most one retry).
   */
  const attempt = async (
    input: JevJudgeInput,
    allowRetry: boolean,
  ): Promise<{ outcome: JevOutcome } | { retryAfterMs: number }> => {
    const started = now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ state: input.state, model: JEV_MODEL, questions: input.questions }),
        signal,
      });
    } catch (err) {
      // The turn's own abort is not an outage: the caller cancelled the turn.
      if (input.signal?.aborted) return { outcome: failure("unknown", "aborted with the turn") };
      const message = err instanceof Error ? err.message : String(err);
      if (allowRetry) return { retryAfterMs: JEV_RETRY_DELAY_MS };
      return { outcome: failure(timeout.aborted ? "timeout" : "network", message) };
    }
    if (!response.ok) {
      const kind = errorKind(response.status);
      const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
      if (retryable && allowRetry) {
        const after = retryAfterMs(response.headers.get("retry-after"), now());
        // A long `retry-after` is not waited on: fail open instead.
        if (after === undefined) return { retryAfterMs: JEV_RETRY_DELAY_MS };
        if (after <= JEV_RETRY_AFTER_MAX_MS) return { retryAfterMs: after };
      }
      return { outcome: failure(kind, `HTTP ${response.status}`) };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      return { outcome: failure("invalid", `unreadable response body (${err instanceof Error ? err.message : String(err)})`) };
    }
    return { outcome: parseSuccess(body, JEV_MODEL, now() - started) };
  };

  return {
    async judge(input: JevJudgeInput): Promise<JevOutcome> {
      let result = await attempt(input, true);
      if ("retryAfterMs" in result) {
        await sleep(result.retryAfterMs);
        result = await attempt(input, false);
      }
      const outcome = "outcome" in result ? result.outcome : failure("unknown", "no response");
      if (!outcome.ok) {
        // One status per transition, no per-call spam; the caller decides
        // how (or whether) to show it.
        setOffline(true);
        return outcome;
      }
      setOffline(false);
      try {
        const payload = input.record(outcome.answers, {
          model: outcome.model,
          latencyMs: outcome.latencyMs,
          usage: outcome.usage,
        });
        // `null` = the caller records this judgment itself (see the
        // contract): the client never appends an empty entry.
        if (payload !== null) options.onJudgment?.(payload);
      } catch {
        // Observability must never break the judgment it describes.
      }
      return outcome;
    },
  };
}
