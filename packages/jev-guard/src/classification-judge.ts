/**
 * The classification judge (#788): one judgment per user turn that yields
 * the task type, its confidence, and the codebase-oriented probability the
 * MPM gate reads.
 *
 * Shared request (ratified): when the routing judge (#787) makes its own
 * call for the same turn, the classification rides it — the routing judge
 * composes the classification's questions into its request and hands the
 * answers to the rider registered here, so exactly one HTTP round trip
 * serves both consumers. When routing is inert (off, paused, override,
 * fewer than two tiers), the judge makes its own single-question call.
 *
 * Fail-open throughout: a failed or absent answer degrades only this use
 * case — no hint, no gate opinion (`undefined`), no event — and never
 * touches the turn.
 */
import type { JevAnswer, JevClient, JevJudgmentMeta, JevQuestion } from "./client";
import {
  CLASSIFICATION_MESSAGE_MAX_BYTES,
  CLASSIFICATION_QUESTIONS,
  classificationSignals,
  hintFor,
  mpmGate,
  type ClassificationSignals,
} from "./classification";
import { truncateToBytes } from "./routing";

export interface ClassificationJudgeDeps {
  client: Pick<JevClient, "judge">;
  /**
   * The one log seam: the extension turns this into `ctx.appendEvent`
   * (`jev_judgment`). Required — no sampling.
   */
  append: (payload: Record<string, unknown>) => void;
}

/** What one judged turn produced. */
export interface ClassificationVerdict {
  readonly signals: ClassificationSignals;
  /** The hint for this turn, when the confidence cleared the threshold. */
  readonly hint?: string;
  /**
   * The MPM gate's opinion for this turn: `false` suppresses the per-turn
   * orientation plan, `true`/`undefined` leave it to the seed pipeline.
   */
  readonly mpmAllowed?: boolean;
  /** The exact judged state (already truncated), for the record. */
  readonly message: string;
}

/** The questions the routing judge must compose into its own request. */
export function classificationQuestions(): Record<string, JevQuestion> {
  return CLASSIFICATION_QUESTIONS;
}

/** Builds the per-turn classification judge. */
export function createClassificationJudge(deps: ClassificationJudgeDeps) {
  /** The verdict of this turn's judgment, once it landed. */
  let current: ClassificationVerdict | null = null;

  const record = (
    answers: Record<string, JevAnswer>,
    meta: JevJudgmentMeta,
    message: string,
    shared: boolean,
  ): ClassificationVerdict => {
    const signals = classificationSignals(answers);
    const hint = hintFor(signals);
    const gate = mpmGate(signals);
    const verdict: ClassificationVerdict = {
      signals,
      ...(hint !== undefined ? { hint } : {}),
      ...(gate !== undefined ? { mpmAllowed: gate } : {}),
      message,
    };
    deps.append({
      useCase: "classification",
      taskType: signals.taskType ?? null,
      confidence: signals.confidence,
      codebaseOriented: signals.codebaseOriented,
      hintApplied: hint !== undefined,
      ...(hint !== undefined ? { hint } : {}),
      mpmGated: gate === false,
      sharedRequest: shared,
      answers,
      model: meta.model,
      latencyMs: meta.latencyMs,
      usage: meta.usage,
    });
    return verdict;
  };

  return {
    /**
     * Judges one turn on its own request (routing inert or absent).
     * `null` = no judgment (the call failed): no hint, no gate opinion.
     */
    async judge(text: string): Promise<ClassificationVerdict | null> {
      const message = truncateToBytes(text, CLASSIFICATION_MESSAGE_MAX_BYTES);
      let verdict: ClassificationVerdict | undefined;
      const outcome = await deps.client.judge({
        state: message,
        questions: CLASSIFICATION_QUESTIONS,
        record: (answers, meta) => {
          // The classification owns its records (like the injection judge):
          // the client appends nothing, the judge does — the payload needs
          // the `shared` flag this call site knows.
          verdict = record(answers, meta, message, false);
          return null;
        },
      });
      if (!outcome.ok || !verdict) return null;
      current = verdict;
      return verdict;
    },

    /**
     * The shared-request path: the routing judge hands over the answers it
     * already read for this turn (same state, composed question set). One
     * round trip, two judgments, two records.
     */
    judgeShared(answers: Record<string, JevAnswer>, meta: JevJudgmentMeta, text: string): ClassificationVerdict | null {
      const message = truncateToBytes(text, CLASSIFICATION_MESSAGE_MAX_BYTES);
      const verdict = record(answers, meta, message, true);
      current = verdict;
      return verdict;
    },

    /**
     * The hint to contribute through `setPromptNote` this turn.
     */
    hint(): string | undefined {
      return current?.hint;
    },

    /** The MPM gate's opinion for the current turn. */
    mpmAllowed(): boolean | undefined {
      return current?.mpmAllowed;
    },
  };
}

export type ClassificationJudge = ReturnType<typeof createClassificationJudge>;
