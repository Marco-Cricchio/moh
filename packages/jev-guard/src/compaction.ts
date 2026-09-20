/**
 * The compaction cut guide (#792, ADR-0035, spec §5): the one question
 * Jev answers per section, the threshold it feeds, and the record shape.
 *
 * Golden rule (TypeSafe skill guidance): a use case's questions AND its
 * thresholds live in ONE file, co-written with the owner and revised as
 * configuration — never scattered through the logic.
 *
 * One noul question per section, the spec's own polarity: "can this
 * section be safely dropped from the conversation summary without losing
 * information the conversation will still need?" The judged state is the
 * section's preview only — never the full body (the ADR's §6: the
 * judgment is about shape, and the body is expendable by definition).
 * Above the threshold is the cut.
 */
import { questions } from "./questions-core";

/** `droppable` (noul): yes = the summarizer does not need this section. */
export const COMPACTION_CUT_QUESTION = questions.noul(
  "Can this section be safely dropped from the conversation summary without losing information the conversation will still need?",
  {
    true: "settled exploration: long tool output, failed attempts, intermediate work with no lasting decision",
    false: "it carries a decision, an explicit ask, a still-needed result, or an open problem",
  },
);

/** Map of question id → question, exactly what one judge call sends. */
export const COMPACTION_CUT_QUESTIONS = {
  droppable: COMPACTION_CUT_QUESTION,
} as const;

/** Ratified thresholds (code constants in v1, tuned on data, never config). */
export const COMPACTION_CUT_THRESHOLDS = {
  /** Drop when the probability the section is safely droppable is above this. */
  DROP_MIN: 0.7,
} as const;

/** What one judged section produced. */
export interface CompactionCutSectionVerdict {
  /** The section id (as the core offered it). */
  readonly id: string;
  /** `drop` when the cut applies, `keep` otherwise. */
  readonly decision: "drop" | "keep";
  /** Probability that the section can be safely dropped. */
  readonly droppable: number;
}
