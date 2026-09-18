/**
 * Use-case question constants (#784 placeholder).
 *
 * Golden rule of the vendor's own agent skill: a use case's questions and
 * its thresholds live in ONE file, co-written with the owner and revised as
 * configuration — never scattered through the logic.
 *
 * This module is that single home. It ships empty because the v1 infra
 * layer has no use case yet: the guardrail's four questions (#786), the
 * routing classifier's tier question (#787) and the ★★ pack's questions
 * (#788–#793) each land here with their own issue, with their own
 * owner-approved text. Only the *shape* is fixed here, so none of them has
 * to invent a type.
 */
import type { JevChoiceQuestion, JevNoulQuestion, JevScoreQuestion } from "./client";

/** Question ids are code-side keys: never sent to the model, never inferred. */
export type JevQuestionId = string;

/** The three question formats the API accepts, one builder each (docs.typesafe.ai/primitives). */
export const questions = {
  /** Yes/no judgment; the probability itself is the signal. */
  noul(instructions: string, criteria?: { true?: string; false?: string }): JevNoulQuestion {
    return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
  },
  /** Pick one of a closed set of options (rubric-per-option). */
  choice(instructions: string, criteria: Record<string, string | null>): JevChoiceQuestion {
    return { type: "choice", instructions, criteria };
  },
  /** Position on an ordered, described spectrum (at least two levels). */
  score(instructions: string, criteria: string[]): JevScoreQuestion {
    return { type: "score", instructions, criteria };
  },
} as const;
