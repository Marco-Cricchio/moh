/**
 * The compaction cut judge (#792, spec §5): turns the runner's section
 * list into one drop set — one Jev call per section, their previews never
 * whole bodies — plus the ONE aggregate record per compaction
 * (`jev_judgment`, `useCase: "compact-cut"`, with the offered sections,
 * the dropped ids, the byte sizes before/after and `keptByFloor`).
 *
 * Fail-open throughout (ratified degradation model): a call that fails
 * produces no judgment for that section — the section stays, and moh
 * compacts exactly as it would without Jev. The one `∅ jev offline`
 * signal is the only trace. The core's 60% survival floor is applied
 * after this judge, by the core, and reported back through
 * `reportFloor` so the aggregate record can carry it.
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
  /** The aggregate record, built when the last section settled. */
  readonly summary: Record<string, unknown>;
}

/** The per-section `jev_judgment` record. The preview is included (it is
 * what was judged); the body never is. */
function sectionRecord(
  section: JudgedSection,
  verdict: CompactionCutSectionVerdict,
  answers: Record<string, JevAnswer>,
  meta: JevJudgmentMeta,
): Record<string, unknown> {
  return {
    useCase: "compact-cut",
    section: { id: section.id, kind: section.kind, bytes: section.bytes },
    preview: section.preview,
    decision: verdict.decision,
    droppable: verdict.droppable,
    questions: { droppable: verdict.droppable },
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
     * section out of the drop set (fail-open, section by section). The
     * returned `summary` is the caller's to enrich (via `reportFloor`)
     * and append after the runner has spoken.
     */
    async judge(sections: readonly JudgedSection[]): Promise<CompactionCutVerdict> {
      const drop: string[] = [];
      const bytesBefore = sections.reduce((sum, s) => sum + s.bytes, 0);
      let bytesDropped = 0;
      for (const section of sections) {
        const state = [
          `section kind: ${section.kind}`,
          `size: ${section.bytes} bytes`,
          `preview: ${section.preview}`,
        ].join("\n");
        const outcome = await deps.client.judge({
          state,
          questions: COMPACTION_CUT_QUESTIONS,
          record: (answers, meta) => {
            const droppable = noulProbability(answers, "droppable");
            const verdict: CompactionCutSectionVerdict = {
              id: section.id,
              decision: droppable > COMPACTION_CUT_THRESHOLDS.DROP_MIN ? "drop" : "keep",
              droppable,
            };
            if (verdict.decision === "drop") {
              drop.push(section.id);
              bytesDropped += section.bytes;
            }
            // This judge owns its records (`record` returns null, see the
            // client contract): the per-section entry is appended exactly
            // once, here. The aggregate one goes out through the hook's
            // `onApplied` callback, after the core has applied the floor.
            deps.append(sectionRecord(section, verdict, answers, meta));
            return null;
          },
        });
        void outcome; // a failed call simply contributes no verdict
      }
      const summary: Record<string, unknown> = {
        useCase: "compact-cut",
        kind: "compaction",
        offeredSections: sections.map((s) => ({ id: s.id, kind: s.kind, bytes: s.bytes })),
        dropped: drop,
        bytesBefore,
        bytesAfter: bytesBefore - bytesDropped,
      };
      return { drop, summary };
    },
  };
}

export type CompactionJudge = ReturnType<typeof createCompactionJudge>;
