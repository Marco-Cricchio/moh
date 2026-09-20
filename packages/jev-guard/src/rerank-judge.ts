/**
 * The rerank judge (#790): one fan-out request per over-threshold MPM
 * seed set. The request holds one noul question per candidate (never an
 * aggregated Score — a calibration lesson paid for in note 35); the
 * kept candidates are returned to the caller so the orientation module
 * can assemble a rescued plan from them.
 *
 * Fail-open throughout: a client failure degrades to `null` (no plan),
 * never a broken turn. The judgment event is recorded regardless
 * (no sampling — ratified) so a successful rerank and a failed one leave
 * the same observability trail.
 */
import type { JevAnswer, JevClient, JevJudgmentMeta } from "./client";
import {
  RERANK_CANDIDATES_MAX,
  RERANK_MIN,
  candidatesDroppedByCap,
  candidatesForRerank,
  keepFromAnswers,
  rerankQuestionsFor,
  rerankStateFor,
  type RerankCandidate,
  type RerankRequest,
} from "./rerank";

export interface RerankJudgeDeps {
  client: Pick<JevClient, "judge">;
  /**
   * The one log seam: the extension turns this into `ctx.appendEvent`
   * (`jev_judgment`, `useCase: "rerank"`). Required — no sampling.
   */
  append: (payload: Record<string, unknown>) => void;
}

/** What one rerank call produced. */
export interface RerankVerdict {
  /** The kept candidates (≤ RERANK_KEEP, probability ≥ RERANK_MIN),
   *  ranked strongest-first. May hold fewer than two — the **caller**
   *  (the core's orientation module) decides the no-plan floor; this
   *  ranker only reports what cleared RERANK_MIN. */
  readonly kept: readonly RerankCandidate[];
  /** The number of candidates considered for the request (≤ RERANK_CANDIDATES_MAX). */
  readonly considered: number;
  /** How many candidates were dropped from consideration because they
   *  exceeded the cap on this request. */
  readonly droppedByCap: number;
}

/** Builds the rerank judge. Stateless: the caller owns the per-send
 *  context (task text, the candidate list) and reads the kept set back. */
export function createRerankJudge(deps: RerankJudgeDeps) {
  return {
    /**
     * Judges the candidate set with one fan-out request.
     * `null` = the call failed (fail-open): the orientation module
     * degrades to today's "no plan" behavior. A successful call that
     * yielded fewer than two candidates above the floor returns an
     * empty `kept` list (also a no-plan for the orientation module).
     */
    async rerank(request: RerankRequest): Promise<RerankVerdict | null> {
      const candidates = request.candidates;
      const droppedByCap = candidatesDroppedByCap(candidates);
      const considered = candidatesForRerank(candidates);
      /** The kept set (filled when the call lands) — null until then. */
      let kept: RerankCandidate[] = [];
      const outcome = await deps.client.judge({
        state: rerankStateFor(request),
        questions: rerankQuestionsFor(considered),
        // The rerank judge owns its record (like the classification judge):
        // the client appends nothing, the judge does — the payload needs
        // fields only this call site knows (`considered`, `droppedByCap`).
        record: (answers: Record<string, JevAnswer>, metaResult: JevJudgmentMeta) => {
          kept = keepFromAnswers(considered, answers);
          deps.append({
            useCase: "rerank",
            candidates: candidates.length,
            considered: considered.length,
            dropped: candidates.length - kept.length,
            droppedByCap,
            kept: kept.map((c) => c.path),
            floor: RERANK_MIN,
            answers,
            model: metaResult.model,
            latencyMs: metaResult.latencyMs,
            usage: metaResult.usage,
          });
          // The client never appends: the payload above is the whole record.
          return null;
        },
      });
      if (!outcome.ok) {
        // A failed judgment is still recorded — the audit trail must be
        // honest, never sampled (ratified). The `record` callback did not
        // run for a failure, so emit one here with `kept: []`; no model
        // or usage fields — nothing was measured, and fabricated zeros
        // would look like data.
        deps.append({
          useCase: "rerank",
          candidates: candidates.length,
          considered: considered.length,
          dropped: candidates.length,
          droppedByCap,
          kept: [],
          floor: RERANK_MIN,
          ok: false,
          kind: outcome.kind,
        });
        return null;
      }
      return { kept, considered: considered.length, droppedByCap };
    },
  };
}

export type RerankJudge = ReturnType<typeof createRerankJudge>;
