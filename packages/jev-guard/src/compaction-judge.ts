/**
 * The compaction cut judge (#792): turns the runner's section list into
 * one drop set, one Jev call per section (their previews, never whole
 * bodies).
 *
 * Fail-open throughout (ratified degradation model): a call that fails
 * produces no judgment for that section — the section stays, and moh
 * compacts exactly as it would without Jev. The one `∅ jev offline`
 * signal is the only trace. The core's 60% survival floor is applied
 * after this judge, by the core: a judge can never talk itself past it.
 *
 * One `jev_judgment` record per judged section, always — drops and keeps
 * alike (ratified: no sampling).
 */
import { noulProbability, type JevAnswer, type JevClient, type JevJudgmentMeta } from "./client";
import {
  COMPACTION_CUT_QUESTIONS,
  COMPACTION_CUT_THRESHOLDS,
  type CompactionCutSectionVerdict,
} from "./compaction";

/** The section shape the core hands over (`@moh/extension`'s view). */
export interface JudgedSection {
  readonly id: string;
  readonly kind: "assistant" | "tool_result" | "tool_call";
  readonly bytes: number;
  readonly preview: string;
}

export interface CompactionJudgeDeps {
  client: Pick<JevClient, "judge">;
  /**
   * The one log seam: the extension turns this into `ctx.appendEvent`
   * (`jev_judgment`). Required — a judgment nobody recorded is a judgment
   * nobody can audit (ratified: no sampling).
   */
  append: (payload: Record<string, unknown>) => void;
}

/** What one dispatch produced: the ids to drop, and the runner's answer. */
export interface CompactionCutVerdict {
  /** Section ids the judgment says are droppable (the core still floors). */
  readonly drop: string[];
}

/** The `jev_judgment` payload for one judged section. The preview is
 * included (it is what was judged); the body never is. */
function sectionRecord(
  section: JudgedSection,
  verdict: CompactionCutSectionVerdict,
  answers: Record<string, JevAnswer>,
  meta: JevJudgmentMeta,
): Record<string, unknown> {
  return {
    useCase: "compaction-cut",
    section: { id: section.id, kind: section.kind, bytes: section.bytes },
    preview: section.preview,
    decision: verdict.decision,
    unrecoverable: verdict.unrecoverable,
    questions: { unrecoverable: verdict.unrecoverable },
    answers,
    model: meta.model,
    latencyMs: meta.latencyMs,
    usage: meta.usage,
  };
}

/**
 * Builds the per-dispatch judge. Stateless by design: compaction runs at
 * most once per covered span, so there is nothing to cache.
 */
export function createCompactionJudge(deps: CompactionJudgeDeps) {
  return {
    /**
     * Judges the offered sections. Never throws; a failed call leaves its
     * section out of the drop set (fail-open, section by section).
     */
    async judge(sections: readonly JudgedSection[]): Promise<CompactionCutVerdict> {
      const drop: string[] = [];
      for (const section of sections) {
        const state = [
          `section kind: ${section.kind}`,
          `size: ${section.bytes} bytes`,
          `preview: ${section.preview}`,
        ].join("\n");
        let verdict: CompactionCutSectionVerdict | undefined;
        const outcome = await deps.client.judge({
          state,
          questions: COMPACTION_CUT_QUESTIONS,
          record: (answers, meta) => {
            const unrecoverable = noulProbability(answers, "unrecoverable");
            const v: CompactionCutSectionVerdict = {
              id: section.id,
              decision: unrecoverable < COMPACTION_CUT_THRESHOLDS.dropBelow ? "drop" : "keep",
              unrecoverable,
            };
            verdict = v;
            deps.append(sectionRecord(section, v, answers, meta));
            return null;
          },
        });
        if (outcome.ok && verdict?.decision === "drop") drop.push(section.id);
      }
      return { drop };
    },
  };
}

export type CompactionJudge = ReturnType<typeof createCompactionJudge>;
