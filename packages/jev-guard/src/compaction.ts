/**
 * The compaction cut guide (#792, ADR-0035): the one question Jev answers
 * per section, the threshold it feeds, and the record shape.
 *
 * Golden rule (TypeSafe skill guidance): a use case's questions AND its
 * thresholds live in ONE file, co-written with the owner and revised as
 * configuration — never scattered through the logic.
 *
 * One noul question per section: "does this section contain information
 * that would be hard to reconstruct if it were dropped from the summary
 * input?" The judged state is the section's preview only — never the full
 * body (the ADR's §6: the judgment is about shape, and the body is
 * expendable by definition). No is the cut: a low probability of
 * unrecoverable content means the summarizer does not need it.
 */
import { questions } from "./questions-core";

/** `recoverable` (noul): yes = this section still carries a decision. */
export const COMPACTION_CUT_QUESTION = questions.noul(
  "Does this section of a coding-session transcript contain information that would be hard to reconstruct if it were excluded from a summary — a decision, an instruction, a result the user explicitly asked for, or an unresolved problem?",
  {
    true: "settled exploration: long tool output, failed attempts, intermediate work with no lasting decision",
    false: "it carries a decision, an explicit ask, a still-needed result, or an open problem",
  },
);

/** Map of question id → question, exactly what one judge call sends. */
export const COMPACTION_CUT_QUESTIONS = {
  unrecoverable: COMPACTION_CUT_QUESTION,
} as const;

/** Ratified threshold (code constant in v1, tuned on data, never config). */
export const COMPACTION_CUT_THRESHOLDS = {
  /** Drop only when the probability of unrecoverable content is below this. */
  dropBelow: 0.4,
} as const;

/** What one judged section produced. */
export interface CompactionCutSectionVerdict {
  /** The section id (as the core offered it). */
  readonly id: string;
  /** `drop` when the cut applies, `keep` otherwise. */
  readonly decision: "drop" | "keep";
  /** Probability that the section holds unrecoverable content. */
  readonly unrecoverable: number;
}
