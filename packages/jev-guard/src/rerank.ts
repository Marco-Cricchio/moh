/**
 * The Jev MPM seed rerank use case (#790): when the orientation plan's
 * seed set resolves to too many mapped paths (more than the ambiguity
 * threshold of 5, #616 / #759), the extension asks Jev to rank the
 * candidates and keeps the best few instead of dropping the plan entirely.
 *
 * Per-candidate questions, never an aggregated Score — the calibration
 * lesson from note 35: a Score over a candidate list collapses to one
 * number and gives no ranking. One noul question per candidate, same
 * instructions, same state — the fan-out pattern from TypeSafe's
 * cookbook, used here because the candidates differ and the task is one.
 *
 * The cap at 30 keeps one request bounded (TypeSafe's documentation
 * warns when a single state grows large); the remaining candidates are
 * dropped from consideration, and the judgment event records how many.
 *
 * Golden rule (TypeSafe skill guidance): a use case's questions AND its
 * thresholds live in ONE file, co-written with the owner and revised as
 * configuration — never scattered through the logic. This module is
 * that single home for the rerank check.
 */
import type { JevQuestion } from "./client";
import { questions } from "./questions-core";

/**
 * Ratified thresholds (code constants in v1, tuned on data, never config).
 * RERANK_MIN: the per-candidate probability floor — below this the file is
 *   not kept. RERANK_KEEP: the maximum number of files the rerank can
 *   rescue. RERANK_CANDIDATES_MAX: the cap on a single fan-out request;
 *   beyond it the rest are dropped from consideration.
 */
export const RERANK_THRESHOLDS = {
  min: 0.5,
  keep: 5,
  candidatesMax: 30,
} as const;

export const RERANK_MIN = RERANK_THRESHOLDS.min;
export const RERANK_KEEP = RERANK_THRESHOLDS.keep;
export const RERANK_CANDIDATES_MAX = RERANK_THRESHOLDS.candidatesMax;

/** One candidate in the rerank call. The core owns the cap and the
 *  ordering; the extension only ever sees up to RERANK_CANDIDATES_MAX. */
export interface RerankCandidate {
  /** Stable id used as the question key in the request. Convention:
   *  `cand:<path>` — same prefix as the question id builders. */
  readonly id: string;
  /** Workspace-root-relative path (the canonical MPM path form). */
  readonly path: string;
  /** Symbols the candidate contributed (advisory metadata, never the
   *  full symbol index — the prompt would balloon otherwise). */
  readonly symbols: readonly string[];
  /** Why this candidate was in the set: the original seed's reason text
   *  (e.g. "matches symbol `alpha`"), already rendered for the orientation
   *  plan. The judge forwards it; it is not a re-extraction. */
  readonly provenance: string;
}

/** The request shape: the task plus the candidates under judgment. */
export interface RerankRequest {
  readonly task: string;
  readonly candidates: readonly RerankCandidate[];
}

const RERANK_INSTRUCTIONS =
  "Judge whether this file is genuinely relevant to the task above, considering its path, declared symbols, and provenance. Answer only from the candidate itself.";

/**
 * Builds the question map: one noul per candidate, ids `cand:<id>`,
 * same instructions for every question — the candidates differ; the task
 * is the state. Returns a frozen-shape object (one question per candidate)
 * the client forwards verbatim.
 *
 * Per-candidate shape is the whole point of the call: a single aggregated
 * score over the candidate list would collapse to one number and give no
 * ranking (the calibration lesson).
 */
export function rerankQuestionsFor(candidates: readonly RerankCandidate[]): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  for (const candidate of candidates) {
    out[`cand:${candidate.id}`] = questions.noul(RERANK_INSTRUCTIONS);
  }
  return out;
}

/**
 * Builds the request state the client forwards. Stable shape — the
 * caller can assert it on a fake client without depending on a particular
 * candidate layout.
 */
export function rerankStateFor(request: RerankRequest): { task: string; candidates: readonly RerankCandidate[] } {
  return { task: request.task, candidates: request.candidates };
}

/**
 * Reads the answers map into the rerank signals: per-candidate probability
 * (0 for a malformed or absent answer — never a guess). The question
 * key convention is `cand:<id>`; the caller passes the original candidate
 * list so the result is the same `RerankCandidate` shape the core passed
 * in, in probability order.
 */
export function rerankSignals(
  candidates: readonly RerankCandidate[],
  answers: Record<string, import("./client").JevAnswer>,
): { candidate: RerankCandidate; probability: number }[] {
  const out: { candidate: RerankCandidate; probability: number }[] = [];
  for (const candidate of candidates) {
    const id = `cand:${candidate.id}`;
    const answer = answers[id];
    const probability = answer?.type === "noul" && typeof answer.noul === "number" ? answer.noul : 0;
    out.push({ candidate, probability });
  }
  return out;
}

/**
 * Picks the kept candidates: probability ≥ RERANK_MIN, ranked by
 * probability, capped at RERANK_KEEP. Returns the original candidate
 * objects (never a reshaped one — the orientation module wants the
 * canonical `path` and the original provenance).
 *
 * The empty result is meaningful: an over-threshold seed set that does
 * not clear the floor on enough files yields **no plan**, exactly as
 * today's discard branch did (the orientation module reports it the
 * same way).
 */
export function keepFromAnswers(
  candidates: readonly RerankCandidate[],
  answers: Record<string, import("./client").JevAnswer>,
): RerankCandidate[] {
  const signals = rerankSignals(candidates, answers);
  return signals
    .filter(({ probability }) => probability >= RERANK_MIN)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, RERANK_KEEP)
    .map(({ candidate }) => candidate);
}

/** How many candidates were dropped because they exceeded the cap. */
export function candidatesDroppedByCap(candidates: readonly RerankCandidate[]): number {
  return Math.max(0, candidates.length - RERANK_CANDIDATES_MAX);
}

/** Returns the candidates the model actually saw, capped at RERANK_CANDIDATES_MAX. */
export function candidatesForRerank(candidates: readonly RerankCandidate[]): RerankCandidate[] {
  return candidates.slice(0, RERANK_CANDIDATES_MAX);
}
