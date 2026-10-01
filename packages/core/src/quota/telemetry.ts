/**
 * #1100 (P1 quota telemetry): the producers, normalizers and read-only
 * projections for provider-declared quota state and user-owned commercial
 * declarations. Built beside the #499 seam (`getQuota`/`QuotaReport`),
 * never duplicating it: a client that probes quota records the report's
 * windows as `quota_observation` events, the agent-loop records quota
 * errors as observations plus `quota_episode` boundaries, and the user's
 * moh.json `commercial` blocks become `commercial_declaration` events.
 *
 * Everything here is metadata only — no prompt text, no credentials, no
 * endpoint query strings. Absent numbers mean unknown, never zero; a
 * window whose shape the provider never declared stays `kind: "unknown"`.
 */
import type { AgentEvent, EndpointIdentity } from "../types";
import { endpointIdentity } from "../types";
import type { QuotaReport } from "./types";

// ---------------------------------------------------------------------------
// Producers — observations
// ---------------------------------------------------------------------------

/** #1100: the fully-shaped quota observation event payload (no event
 * identity — the log stamps `id`/`parentId`). */
export type QuotaObservationEvent = Extract<AgentEvent, { type: "quota_observation" }>;
export type QuotaEpisodeEvent = Extract<AgentEvent, { type: "quota_episode" }>;
export type CommercialDeclarationEvent = Extract<AgentEvent, { type: "commercial_declaration" }>;

/** The deterministic identity of the capacity an observation describes:
 * the endpoint key for endpoint/model scope, or the pool's name for a
 * shared pool (two endpoints can draw from one pool — that is how the
 * projection keeps them together). Built from the sanitized #1099
 * endpoint identity — nothing secret can enter. */
export function scopeKeyFor(
  endpoint: EndpointIdentity,
  options: { scope?: QuotaObservationEvent["scope"]; model?: string; pool?: string } = {},
): string {
  const base = `${endpoint.kind}${endpoint.baseUrl ? `(${endpoint.baseUrl})` : ""}`;
  // A shared pool keys on the pool's identity alone: two endpoints drawing
  // from one pool must land on the same key for the projection to keep
  // their observations and episodes together.
  if (options.pool) return `pool:${options.pool}`;
  if (options.model) return `${base}#${options.model}`;
  return base;
}


/** Converts one #499 `QuotaReport` into `quota_observation` events — the
 * single extension of the quota seam for recording. The window's shape is
 * `kind: "unknown"` unless a future seam declares it: the #499 windows
 * carry a label (e.g. "5h") and a reset time, never rolling/fixed
 * semantics, and moh does not guess. */
export function observationsFromQuotaReport(
  report: QuotaReport,
  options: {
    endpoint: EndpointIdentity;
    model?: string;
    /** Whose capacity the report describes. Default: `"endpoint"`.
     * A `pool` scope keys on the pool's identity alone — pass `pool`. */
    scope?: QuotaObservationEvent["scope"];
    /** The shared pool's identity, required for `scope: "pool"`. */
    pool?: string;
    /** Unit override for clients that know what the provider counts
     * (the #499 windows do not carry one; default `"provider-defined"`). */
    unit?: QuotaObservationEvent["unit"];
    /** The moh.json endpoint name, when the recorder knows it. */
    endpointName?: string;
    observedAt?: string;
  },
): QuotaObservationEvent[] {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const scope = options.scope ?? "endpoint";
  return report.windows.map((window) => ({
    type: "quota_observation" as const,
    endpoint: options.endpoint,
    ...(options.endpointName ? { endpointName: options.endpointName } : {}),
    ...(options.model ? { model: options.model } : {}),
    scope,
    scopeKey: scopeKeyFor(options.endpoint, { scope, model: options.model, pool: options.pool }),
    unit: options.unit ?? ("provider-defined" as const),
    window: { label: window.label, kind: "unknown" as const },
    ...(window.limit !== undefined ? { limit: window.limit } : {}),
    ...(window.used !== undefined ? { used: window.used } : {}),
    ...(window.percent !== undefined ? { percent: window.percent } : {}),
    ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
    source: "quota-endpoint" as const,
    authority: report.source,
    observedAt,
  }));
}

/** Builds the observation + episode-boundary events the loop records when
 * an attempt failed with a quota-classified provider error. The provider
 * error itself declares nothing about windows, limits or units — the
 * honest observation carries only the error kind, the Retry-After hint
 * (when the provider surfaced one) and the #1099 attempt linkage. */
export function quotaEventsFromProviderError(options: {
  endpoint: EndpointIdentity;
  errorKind: "rate_limited" | "quota_exhausted";
  servingModel?: string;
  retryAfterMs?: number;
  observedAt?: string;
  callId?: string;
  attemptId?: string;
}): [QuotaObservationEvent, QuotaEpisodeEvent] {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const scope: QuotaObservationEvent["scope"] = options.servingModel ? "model" : "endpoint";
  const observation: QuotaObservationEvent = {
    type: "quota_observation",
    endpoint: options.endpoint,
    ...(options.servingModel ? { model: options.servingModel } : {}),
    scope,
    scopeKey: scopeKeyFor(options.endpoint, { scope, model: options.servingModel }),
    source: "provider-error",
    observedAt,
    ...(options.callId ? { callId: options.callId } : {}),
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    errorKind: options.errorKind,
  };
  const episode: QuotaEpisodeEvent = {
    type: "quota_episode",
    phase: options.errorKind === "quota_exhausted" ? ("exhausted" as const) : ("rate_limited" as const),
    scopeKey: observation.scopeKey,
    endpoint: options.endpoint,
    ...(options.servingModel ? { servingModel: options.servingModel } : {}),
    startedAt: observedAt,
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    ...(options.callId ? { callId: options.callId } : {}),
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
  };
  return [observation, episode];
}

/** Builds the `recovered` boundary the loop records when a later attempt
 * of the same logical call succeeded after a quota block. `waitMs` is the
 * wall-clock the loop observed between the blocked attempt's end and the
 * recovering attempt's start (backoff included, nothing synthesized). */
export function quotaRecoveryEvent(options: {
  scopeKey: string;
  endpoint: EndpointIdentity;
  servingModel?: string;
  /** The blocked boundary this recovery closes (its `startedAt`). */
  blockedStartedAt: string;
  blockedEndedAt?: string;
  waitMs?: number;
  usedFallback?: boolean;
  callId?: string;
  endedAt?: string;
}): QuotaEpisodeEvent {
  const endedAt = options.endedAt ?? new Date().toISOString();
  return {
    type: "quota_episode",
    phase: "recovered",
    scopeKey: options.scopeKey,
    endpoint: options.endpoint,
    ...(options.servingModel ? { servingModel: options.servingModel } : {}),
    startedAt: options.blockedStartedAt,
    endedAt,
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
    ...(options.usedFallback !== undefined ? { usedFallback: options.usedFallback } : {}),
    ...(options.callId ? { callId: options.callId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Producers — commercial declarations (user-owned, redacted, time-bounded)
// ---------------------------------------------------------------------------

/** The user-owned commercial declaration as it arrives from configuration
 * or a client call — before normalization. */
export interface CommercialDeclarationInput {
  plan?: string;
  price?: number;
  currency?: string;
  billingPeriod?: "monthly" | "yearly" | "custom";
  promotion?: string;
  overagePolicy?: "blocked" | "metered" | "unknown";
  validFrom?: string;
  validUntil?: string;
}

const MAX_TEXT = 80;
const MAX_CURRENCY = 8;

/** Bounded, trimmed text — the one redaction pass declarations go
 * through. A non-string or empty value is dropped; nothing secret-shaped
 * is ever accepted (declarations name plans, not credentials). */
function redactText(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Normalizes a user declaration into its event form, or a plain error
 * string when the declaration contradicts itself (a blank endpoint name,
 * or a `validUntil` before `validFrom` — refused, never silently
 * reordered). No key or credential field exists on the input type — the
 * redaction is structural, not filtering. */
export function commercialDeclarationEvent(
  endpointName: string,
  declaration: CommercialDeclarationInput,
  now: string = new Date().toISOString(),
): { event: CommercialDeclarationEvent } | { error: string } {
  const name = redactText(endpointName, MAX_TEXT);
  if (!name) return { error: `commercial declaration refused: the endpoint name is blank` };
  const validFrom = declaration.validFrom ?? now;
  if (declaration.validUntil !== undefined && declaration.validUntil <= validFrom) {
    return { error: `commercial declaration for "${name}": validUntil must be after validFrom` };
  }
  const price = typeof declaration.price === "number" && Number.isFinite(declaration.price) && declaration.price >= 0
    ? declaration.price
    : undefined;
  const plan = redactText(declaration.plan, MAX_TEXT);
  const currency = redactText(declaration.currency, MAX_CURRENCY);
  const promotion = redactText(declaration.promotion, MAX_TEXT);
  return {
    event: {
      type: "commercial_declaration",
      endpoint: name,
      ...(plan ? { plan } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(currency ? { currency } : {}),
      ...(declaration.billingPeriod !== undefined ? { billingPeriod: declaration.billingPeriod } : {}),
      ...(promotion ? { promotion } : {}),
      ...(declaration.overagePolicy !== undefined ? { overagePolicy: declaration.overagePolicy } : {}),
      validFrom,
      ...(declaration.validUntil !== undefined ? { validUntil: declaration.validUntil } : {}),
    },
  };
}

/** Whether a declaration is in force at `at` (both bounds inclusive;
 * absent bounds are open-ended). */
export function declarationInForce(event: CommercialDeclarationEvent, at: string = new Date().toISOString()): boolean {
  if (event.validFrom > at) return false;
  if (event.validUntil !== undefined && event.validUntil < at) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Projection — episodes from boundaries
// ---------------------------------------------------------------------------

/** One distinct quota episode: a block boundary paired with the recovery
 * that closed it (or still open — `recoveredAt` absent — when no
 * recovery has been recorded yet). Temporal bounds are real timestamps,
 * never reconstructed from error counts. */
export interface QuotaEpisode {
  kind: "exhausted" | "rate_limited";
  scopeKey: string;
  startedAt: string;
  recoveredAt?: string;
  /** Wall-clock spent waiting/backing off across the episode, when the
   * recovering boundary carried it. */
  waitMs?: number;
  retryAfterMs?: number;
  /** The recovery came from a fallback move (a different serving model). */
  usedFallback?: boolean;
  /** How many blocked boundaries landed inside the episode. */
  blockedCount: number;
}

/** Reconstructs distinct quota episodes from a session's event log, in
 * log order. Boundaries pair by `scopeKey`: a `recovered` closes the
 * most recent still-open block for the same scope that started no later
 * than the recovery. A block with no matching recovery stays open —
 * honest unknown, never an invented end. Blocks arrive from quota-class
 * provider errors (`rate_limited`, `quota_exhausted`); a plain turn
 * error event counts nothing here. */
export function quotaEpisodes(events: readonly AgentEvent[]): QuotaEpisode[] {
  const episodes: QuotaEpisode[] = [];
  const openByScope = new Map<string, QuotaEpisode[]>();
  for (const event of events) {
    if (event.type === "quota_episode" && (event.phase === "exhausted" || event.phase === "rate_limited")) {
      const episode: QuotaEpisode = {
        kind: event.phase,
        scopeKey: event.scopeKey,
        startedAt: event.startedAt,
        ...(event.retryAfterMs !== undefined ? { retryAfterMs: event.retryAfterMs } : {}),
        blockedCount: 1,
      };
      episodes.push(episode);
      const open = openByScope.get(event.scopeKey) ?? [];
      open.push(episode);
      openByScope.set(event.scopeKey, open);
    } else if (event.type === "quota_episode" && event.phase === "recovered") {
      const open = openByScope.get(event.scopeKey);
      const target = open?.[open.length - 1];
      if (!target) continue; // a recovery without a recorded block pairs with nothing — never invents one
      target.recoveredAt = event.endedAt ?? event.startedAt;
      if (event.waitMs !== undefined) target.waitMs = event.waitMs;
      if (event.usedFallback !== undefined) target.usedFallback = event.usedFallback;
      open!.pop();
    }
  }
  return episodes;
}

// ---------------------------------------------------------------------------
// Projection — contradictions between observations
// ---------------------------------------------------------------------------

/** Two observations of the same capacity + window whose declared limits
 * (or remaining amounts) disagree while both could be in force. The
 * projection reports them — it never resolves which one is right. */
export interface QuotaContradiction {
  scopeKey: string;
  window: string;
  field: "limit" | "remaining";
  first: { value: number; observedAt: string; source: string };
  second: { value: number; observedAt: string; source: string };
}

/** Finds contradictions between `quota_observation` events: same
 * `scopeKey` + window label, both carrying the compared field, both
 * temporally overlapping (the earlier one's `validUntil` — absent =
 * open-ended — still covers the later's `observedAt`), different values.
 * Observations are grouped by scope+window first — linear in the log. */
export function quotaContradictions(events: readonly AgentEvent[]): QuotaContradiction[] {
  const out: QuotaContradiction[] = [];
  const groups = new Map<string, QuotaObservationEvent[]>();
  for (const event of events) {
    if (event.type !== "quota_observation") continue;
    const label = event.window?.label;
    if (label === undefined) continue;
    const key = `${event.scopeKey}\u0000${label}`;
    const group = groups.get(key);
    if (group) group.push(event as QuotaObservationEvent);
    else groups.set(key, [event as QuotaObservationEvent]);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.validUntil !== undefined && a.validUntil < b.observedAt) continue;
        if (b.validUntil !== undefined && b.validUntil < a.observedAt) continue;
        for (const field of ["limit", "remaining"] as const) {
          const va = a[field];
          const vb = b[field];
          if (va === undefined || vb === undefined || va === vb) continue;
          // One direction per unordered pair: keep the earlier observation first.
          out.push({
            scopeKey: a.scopeKey,
            window: a.window!.label,
            field,
            first: { value: va, observedAt: a.observedAt, source: a.source },
            second: { value: vb, observedAt: b.observedAt, source: b.source },
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rollup + pressure query (the follow-up output)
// ---------------------------------------------------------------------------

/** #1100: quota rollup across one or more sessions — episode counts and
 * wait totals, never raw error-event counts. */
export interface QuotaSummary {
  /** Distinct exhaustion episodes (open ones included). */
  exhausted: number;
  /** Distinct rate-limit episodes (open ones included). */
  rateLimited: number;
  /** Episodes still open — no recovery recorded. Honest unknown. */
  open: number;
  /** Recoveries seen. */
  recovered: number;
  /** Recoveries that came from a fallback move. */
  fallbackRecoveries: number;
  /** Sum of the episodes' recorded wait/backoff time. */
  waitMs: number;
  /** Observations recorded. */
  observations: number;
  /** Contradictions found between observations. */
  contradictions: number;
}

export function summarizeQuota(episodes: readonly QuotaEpisode[], contradictions: readonly QuotaContradiction[], observations: number): QuotaSummary {
  const summary: QuotaSummary = {
    exhausted: 0, rateLimited: 0, open: 0, recovered: 0,
    fallbackRecoveries: 0, waitMs: 0, observations, contradictions: contradictions.length,
  };
  for (const episode of episodes) {
    if (episode.kind === "exhausted") summary.exhausted += 1;
    else summary.rateLimited += 1;
    if (episode.recoveredAt === undefined) summary.open += 1;
    else {
      summary.recovered += 1;
      if (episode.usedFallback) summary.fallbackRecoveries += 1;
    }
    summary.waitMs += episode.waitMs ?? 0;
  }
  return summary;
}

/** One scope's quota pressure over a period — the follow-up output of
 * #1100: pressure, first observed block, wait, recovery, overage spend
 * and allowance utilization, derived only from recorded facts and
 * explicitly-labeled local estimates. */
export interface QuotaPressureRow {
  scopeKey: string;
  /** The model ref, when the scope is model-level. */
  model?: string;
  /** Latest in-period observation's utilization — `percent` when the
   * provider reported one, else used/limit. Absent = never reported. */
  quotaPressure?: number;
  /** First episode boundary in the period. */
  firstObservedBlock?: string;
  /** The episode's recovery time, when recovered in-period. */
  recoveryTime?: string;
  /** Recorded wait/backoff across the period's episodes. */
  waitMs?: number;
  /** Local estimate, labeled as such in docs: overage units beyond a
   * `usd`-unit allowance × the declared price. Undefined unless the
   * user declared a price AND an in-force usd-unit observation shows
   * `used > limit`. Never derived from endpoint identity. */
  overageSpendUsd?: number;
  /** Latest in-period used/limit, percent. Absent = not reported. */
  allowanceUtilization?: number;
}

function utilization(observation: QuotaObservationEvent): number | undefined {
  if (observation.percent !== undefined) return observation.percent;
  if (observation.used !== undefined && observation.limit !== undefined && observation.limit > 0) {
    return (observation.used / observation.limit) * 100;
  }
  return undefined;
}

/** The period query: reconstructs per-scope pressure over `events` between
 * `fromMs`/`untilMs` (epoch ms; defaults: unbounded). Observations filter
 * by their own `observedAt`; the overage estimate additionally requires an
 * in-force `commercial_declaration` with a price. */
export function quotaPressure(
  events: readonly AgentEvent[],
  options: { fromMs?: number; untilMs?: number } = {},
): QuotaPressureRow[] {
  const from = options.fromMs ?? Number.NEGATIVE_INFINITY;
  const until = options.untilMs ?? Number.POSITIVE_INFINITY;
  const ms = (iso: string) => Date.parse(iso);
  const rows = new Map<string, QuotaPressureRow>();
  const latestByScope = new Map<string, QuotaObservationEvent>();

  const commercial = events.flatMap((e) =>
    e.type === "commercial_declaration" && declarationInForce(e as CommercialDeclarationEvent) && ms(e.validFrom) <= until && (e.validUntil === undefined || ms(e.validUntil) >= from)
      ? [e as CommercialDeclarationEvent]
      : [],
  );

  for (const event of events) {
    if (event.type === "quota_observation") {
      const observed = ms(event.observedAt);
      if (observed < from || observed > until) continue;
      const row = rows.get(event.scopeKey) ?? { scopeKey: event.scopeKey, ...(event.model ? { model: event.model } : {}) };
      latestByScope.set(event.scopeKey, event as QuotaObservationEvent);
      rows.set(event.scopeKey, row);
    } else if (event.type === "quota_episode" && (event.phase === "exhausted" || event.phase === "rate_limited")) {
      const started = ms(event.startedAt);
      if (started < from || started > until) continue;
      const row = rows.get(event.scopeKey) ?? { scopeKey: event.scopeKey, ...(event.servingModel ? { model: event.servingModel } : {}) };
      row.firstObservedBlock = row.firstObservedBlock === undefined || event.startedAt < row.firstObservedBlock
        ? event.startedAt
        : row.firstObservedBlock;
      rows.set(event.scopeKey, row);
    }
  }

  for (const episode of quotaEpisodes(events)) {
    const started = ms(episode.startedAt);
    if (started < from || started > until) continue;
    const row = rows.get(episode.scopeKey);
    if (!row) continue;
    row.waitMs = (row.waitMs ?? 0) + (episode.waitMs ?? 0);
    if (episode.recoveredAt !== undefined) {
      const recovered = ms(episode.recoveredAt);
      if (recovered >= from && recovered <= until) row.recoveryTime = row.recoveryTime === undefined || episode.recoveredAt < row.recoveryTime ? episode.recoveredAt : row.recoveryTime;
    }
  }

  for (const [scopeKey, row] of rows) {
    const observation = latestByScope.get(scopeKey);
    if (observation) {
      const utilizationPct = utilization(observation);
      if (utilizationPct !== undefined) {
        row.quotaPressure = utilizationPct;
        row.allowanceUtilization = utilizationPct;
      }
      // The one overage path: a usd-unit allowance the user priced, for
      // this very endpoint. A labeled local estimate — never a charge.
      const declaration = observation.endpointName
        ? commercial.find((c) => c.price !== undefined && c.endpoint === observation.endpointName)
        : undefined;
      if (
        declaration?.price !== undefined &&
        observation.unit === "usd" &&
        observation.used !== undefined &&
        observation.limit !== undefined &&
        observation.used > observation.limit
      ) {
        row.overageSpendUsd = (observation.used - observation.limit) * declaration.price;
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
}
