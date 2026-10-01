/**
 * Jev model-error retry (#1110) — the recovery half of routing.
 *
 * Pure logic, no I/O: when a model the router chose fails at runtime with
 * a non-Route error, the extension answers the core's `onModelError` seam
 * with the next candidate from the failed model's own tier — same tier,
 * same preference order — up to 4 attempts within the turn. The state is
 * per session (the owner and each borrowed child keep their own).
 *
 * The exclusion policy is by error kind:
 * - endpoint-level kinds (`auth`, `quota_exhausted`, `content_filtered` —
 *   auth, quota and privacy/provider settings are properties of the
 *   endpoint, not the model) exclude every model of that endpoint;
 * - everything else (invalid ref, context fit, malformed request) excludes
 *   only the failed model.
 *
 * Every exclusion carries an exponential backoff that *expires* — a
 * model-level failure cools briefly, an endpoint-level one longer — so
 * the next turn starts from the known-good model and can re-select a
 * previously failed model once the window passes: never a permanent ban.
 */

import { tierOfModel, type TierAssignment } from "./routing";

/** Maximum retry candidates one turn gets (#1110). */
export const MAX_MODEL_RETRY_ATTEMPTS = 4;

/** The error kinds that indict the whole endpoint, not just the model. */
export const ENDPOINT_ERROR_KINDS: ReadonlySet<string> = new Set([
  "auth",
  "quota_exhausted",
  "content_filtered",
]);

/** Base backoff for a model-level exclusion; doubles per repeat. */
const MODEL_BACKOFF_BASE_MS = 30_000;
/** Base backoff for an endpoint-level exclusion; doubles per repeat. */
const ENDPOINT_BACKOFF_BASE_MS = 300_000;
/** Any exclusion's backoff is capped: never a permanent ban. */
const BACKOFF_CAP_MS = 30 * 60_000;

/** The exclusion key for a ref: endpoint-level kinds blame the endpoint. */
export function exclusionKeyFor(ref: string, errorKind: string): string {
  const slash = ref.indexOf("/");
  const endpoint = slash > 0 ? ref.slice(0, slash) : ref;
  return ENDPOINT_ERROR_KINDS.has(errorKind) ? `endpoint:${endpoint}` : `model:${ref}`;
}

/** How long an exclusion of this kind stays hot, given its strike count. */
export function backoffFor(errorKind: string, strikes: number): number {
  const base = ENDPOINT_ERROR_KINDS.has(errorKind) ? ENDPOINT_BACKOFF_BASE_MS : MODEL_BACKOFF_BASE_MS;
  return Math.min(base * 2 ** (strikes - 1), BACKOFF_CAP_MS);
}

/** One session's retry state: the turn's spent attempts and the exclusions. */
export interface ModelRetryState {
  /** Retry proposals made this turn (the budget). */
  attempts: number;
  /** The step-back record for this turn was published (never twice). */
  exhausted: boolean;
  /** Exclusion key → until when (epoch ms) and how many strikes. */
  readonly exclusions: Map<string, { until: number; strikes: number }>;
}

export function newRetryState(): ModelRetryState {
  return { attempts: 0, exhausted: false, exclusions: new Map() };
}

/** Starts a fresh turn: the budget resets, the exclusions do not. */
export function startTurn(state: ModelRetryState): void {
  state.attempts = 0;
  state.exhausted = false;
}

/**
 * True while the ref (or its whole endpoint) is inside an unexpired
 * exclusion. A live exclusion is the early-stop: the candidate selection
 * skips what this names.
 */
export function isExcluded(state: ModelRetryState, ref: string, now: number): boolean {
  const slash = ref.indexOf("/");
  const endpoint = slash > 0 ? ref.slice(0, slash) : ref;
  for (const key of [`model:${ref}`, `endpoint:${endpoint}`]) {
    const hit = state.exclusions.get(key);
    if (hit && hit.until > now) return true;
  }
  return false;
}

/**
 * Records a failure: the exclusion (by kind — endpoint-wide or model-only)
 * is extended exponentially per repeat strike. Expired entries are pruned
 * first, so an exclusion that expired then re-fails starts a fresh strike.
 */
export function noteFailure(state: ModelRetryState, ref: string, errorKind: string, now: number): void {
  for (const [key, hit] of state.exclusions) {
    if (hit.until <= now) state.exclusions.delete(key);
  }
  const key = exclusionKeyFor(ref, errorKind);
  const previous = state.exclusions.get(key);
  const strikes = previous !== undefined ? previous.strikes + 1 : 1;
  state.exclusions.set(key, { until: now + backoffFor(errorKind, strikes), strikes });
}

/**
 * Records a switch the core refused (context fit, unresolvable ref): the
 * proposed target cannot serve now, so it is excluded like a failure —
 * model-level (short backoff), never endpoint-wide: a fit refusal of one
 * model says nothing about its endpoint's other models.
 */
export function noteRefused(state: ModelRetryState, ref: string, now: number): void {
  noteFailure(state, ref, "invalid_request", now);
}

/** The budget check: attempts left within this turn. */
export function canRetry(state: ModelRetryState): boolean {
  return state.attempts < MAX_MODEL_RETRY_ATTEMPTS;
}

/**
 * The next candidate: the failed model's tier members in their own
 * preference order (the assignment's ranking), dropping the failed ref
 * and everything excluded or cooled down. `undefined` = nothing viable —
 * the router steps back. Tier-bounded on purpose: a runtime failure moves
 * sideways within the tier the router chose, never up or down.
 */
export function nextCandidate(
  assignment: TierAssignment,
  failedRef: string,
  state: ModelRetryState,
  now: number,
): string | undefined {
  const tier = tierOfModel(assignment, failedRef);
  if (tier === undefined) return undefined;
  for (const ref of assignment.members[tier]) {
    if (ref === failedRef) continue;
    if (isExcluded(state, ref, now)) continue;
    return ref;
  }
  return undefined;
}
