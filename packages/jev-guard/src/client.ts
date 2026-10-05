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

import type { HostFetchOptions, HostFetchResult } from "@moh/extension";

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

/**
 * One yes/no answer as a probability. The one reader of the `noul` shape:
 * every use case that asks a yes/no question (the guardrail's destructive
 * question, the injection and sensitive checks) reads it the same way, and
 * a malformed or absent answer is 0 — never a guess, never a throw.
 */
export function noulProbability(answers: Record<string, JevAnswer>, id: string): number {
  const answer = answers[id];
  return answer?.type === "noul" && typeof answer.noul === "number" ? answer.noul : 0;
}

/** Why a call did not produce a judgment. */
/**
 * Why a call did not produce a judgment. `refused` (#1162) is a host-seam
 * policy answer — scope, unknown credential, deny: deterministic, never
 * retried, and not an outage (no offline status). */
export type JevFailureKind = "timeout" | "auth" | "rate_limited" | "network" | "invalid" | "unknown" | "refused";

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
  /**
   * #1162: the request seam. The client speaks one POST of JSON against the
   * fixed endpoint through whatever the caller built — in production the
   * `ctx.host.fetch` adapter (`hostTransport`, credential injected
   * host-side), in tests a scripted fake. The client never touches a raw
   * `fetch` and never holds the API key: the bearer value exists only
   * behind the host's credential resolution (ADR-0069).
   */
  transport: JevTransport;
  /** Per-call timeout in ms. Default `JEV_TIMEOUT_MS_DEFAULT`. */
  timeoutMs?: number;
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

/** The status text a rejected key publishes (#1207, ratified copy): the
 * call reached the service and the service refused it — a user-actionable
 * fact, distinct from an outage. */
export const JEV_AUTH_STATUS = "∅ jev key rejected";

/**
 * #1162: the transport seam — one JSON POST whose outcome is either a
 * status with the fully buffered body or a typed transport failure. A
 * `refused` kind is the host seam's policy answer (scope, credential,
 * deny): deterministic, so the client never retries it.
 */
export type JevTransportResult =
  | { ok: true; status: number; bytes: Uint8Array }
  | { ok: false; kind: "network" | "timeout" | "refused"; message?: string };

export type JevTransport = (request: { body: string; signal?: AbortSignal }) => Promise<JevTransportResult>;

/**
 * #1162: the production transport — `ctx.host.fetch` under the extension's
 * `host:` + `credential:` scopes. The bearer value never crosses this
 * boundary: the host resolves `credential:<ref>` and injects it itself
 * (ADR-0069). A policy refusal maps to `refused`; a transport throw maps
 * to `network` — the caller's abort signal decides `timeout`.
 */
export function hostTransport(
  hostFetch: (url: string, options?: HostFetchOptions) => Promise<HostFetchResult>,
  credentialRef: string,
): JevTransport {
  return async ({ body, signal }) => {
    let result: HostFetchResult;
    try {
      result = await hostFetch(JEV_ENDPOINT, { method: "POST", body, ...(signal !== undefined ? { signal } : {}), credential: credentialRef });
    } catch (err) {
      return { ok: false, kind: "network", message: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) return { ok: true, status: result.status, bytes: result.bytes };
    if (result.reason === "failed") return { ok: false, kind: "network", ...(result.message !== undefined ? { message: result.message } : {}) };
    return { ok: false, kind: "refused", ...(result.message !== undefined ? { message: result.message } : {}) };
  };
}

/**
 * A Response-speaking adapter for tests and the Settings entry's pre-mint
 * key check: it carries the key itself (there the value is still not a
 * stored credential — the caller validates what the user just typed). The
 * extension never uses this; only `validateJevKey` callers without a host
 * seam do.
 */
export function transportFromFetch(
  impl: (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>,
  headers: Record<string, string> = {},
): JevTransport {
  return async ({ body, signal }) => {
    try {
      const response = await impl(JEV_ENDPOINT, { method: "POST", headers, body, ...(signal !== undefined ? { signal } : {}) });
      return { ok: true, status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
    } catch (err) {
      return { ok: false, kind: "network", message: err instanceof Error ? err.message : String(err) };
    }
  };
}

function failure(kind: JevFailureKind, message: string): { ok: false; kind: JevFailureKind; message: string } {
  return { ok: false, kind, message };
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
 * one. The caller's transport carries the key being validated (Settings:
 * a plain bearer transport over the typed value — not yet a credential).
 */
export type JevKeyValidation =
  | { status: "active"; latencyMs: number }
  | { status: "invalid"; message: string }
  | { status: "unreachable"; kind: JevFailureKind; message: string };

/** The cheapest possible question: one noul over a two-word state. */
export async function validateJevKey(
  options: { transport: JevTransport; timeoutMs?: number; now?: () => number },
): Promise<JevKeyValidation> {
  const client = createJevClient({
    transport: options.transport,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
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
  const transport = options.transport;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /**
   * Connectivity status as the client last published it. Three states:
   * `null` (healthy), the outage text, the auth text (#1207). The two
   * failure texts never flow through one boolean — an auth transition
   * must be able to replace the outage text and vice versa.
   */
  let status: string | null = null;

  const publish = (next: string | null): void => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
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
    let result: JevTransportResult;
    try {
      result = await transport({
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
    if (signal.aborted && !input.signal?.aborted) {
      return { outcome: failure("timeout", `no answer within ${timeoutMs}ms`) };
    }
    if (!result.ok) {
      if (result.kind === "refused") {
        // A host-seam policy refusal is deterministic and is not an outage:
        // the typed kind says so, and the offline signal stays untouched.
        return { outcome: failure("refused", result.message ?? "request refused by the host seam") };
      }
      if (result.kind === "timeout") return { outcome: failure("timeout", result.message ?? `no answer within ${timeoutMs}ms`) };
      const message = result.message ?? "transport failure";
      if (allowRetry) return { retryAfterMs: JEV_RETRY_DELAY_MS };
      return { outcome: failure("network", message) };
    }
    if (result.status < 200 || result.status >= 300) {
      const kind = errorKind(result.status);
      const retryable = result.status === 429 || result.status === 529 || result.status >= 500;
      if (retryable && allowRetry) {
        // The transport does not expose headers; a status-only retry uses
        // the fixed short delay (no `retry-after` is readable through the
        // buffered-bytes seam).
        return { retryAfterMs: JEV_RETRY_DELAY_MS };
      }
      return { outcome: failure(kind, `HTTP ${result.status}`) };
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(result.bytes));
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
        // how (or whether) to show it. Two kinds are not connectivity
        // facts: a host-seam refusal stays silent (#1162), and an auth
        // failure is the service's verdict on the key, not an outage —
        // it gets its own text (#1207). Both are just as sticky as the
        // outage until a call proves otherwise.
        if (outcome.kind === "refused") return outcome;
        publish(outcome.kind === "auth" ? JEV_AUTH_STATUS : JEV_OFFLINE_STATUS);
        return outcome;
      }
      publish(null);
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
