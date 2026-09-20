/**
 * The anti-injection judge (#791): turns one judged state — the user's
 * turn input, or the text a `fetch`/`browser` call returned — into a band
 * and, when needed, a confirmation request or a withhold.
 *
 * Fail-open throughout (ratified degradation model): a call that fails
 * produces no judgment at all — no band, no event, no ask — and moh
 * behaves exactly as it does without Jev, with the client's single
 * `∅ jev offline` signal as the only trace.
 *
 * One record per judgment, always: `silent` and `warn` are recorded as
 * soon as the answers land; the `confirm` band is recorded when the user's
 * decision is known (through the `resolve` callback the hook hands to
 * `onResolved`), because "was this sent?" is part of what happened.
 */
import type { TurnConfirmOutcome } from "@moh/extension";
import { noulProbability, type JevAnswer, type JevClient, type JevJudgmentMeta } from "./client";
import {
  INJECTION_INPUT_MAX_BYTES,
  INJECTION_QUESTIONS,
  INJECTION_THRESHOLDS,
  INJECTION_TOOL_MAX_BYTES,
  SENSITIVE_ADVICE,
  injectionBand,
  injectionConfirmReason,
  injectionWithholdReason,
  sliceForJudgment,
  type InjectionBand,
  type InjectionDecision,
  type InjectionSignals,
  type InjectionSource,
} from "./injection";

export interface InjectionJudgeDeps {
  client: Pick<JevClient, "judge">;
  /**
   * The one log seam: the extension turns this into `ctx.appendEvent`
   * (`jev_judgment`). Required, not optional — a judgment nobody recorded
   * is a judgment nobody can audit (ratified: no sampling).
   */
  append: (payload: Record<string, unknown>) => void;
}

/** What one input check produced. */
export interface InjectionInputVerdict {
  readonly band: InjectionBand;
  readonly signals: InjectionSignals;
  /**
   * The confirmation's copy, present on the `confirm` band only. The hook
   * returns it as `{ confirm: { reason, onResolved } }`.
   */
  readonly reason?: string;
  /**
   * Records the confirmation's outcome — the one call the core makes once
   * the user (or the headless policy) answered. Present on `confirm` only;
   * the other bands are already recorded.
   */
  readonly resolve?: (outcome: TurnConfirmOutcome) => void;
}

/** What one tool-result check produced. */
export interface InjectionToolVerdict {
  /** The refusal reason, when the result must be withheld. */
  readonly withhold?: string;
  readonly band: InjectionBand;
  readonly signals: InjectionSignals;
}

/** The two signals, read off one answers map (both halves ask both). */
function signalsOf(answers: Record<string, JevAnswer>): InjectionSignals {
  return {
    injection: noulProbability(answers, "injection"),
    sensitive: noulProbability(answers, "sensitive"),
  };
}

/** The outcome vocabulary the record carries, per band. */
function decisionOf(band: InjectionBand, source: InjectionSource): InjectionDecision {
  if (source === "input") return band === "silent" ? "silent" : band === "warn" ? "warn" : "confirmed";
  return band === "confirm" ? "withheld" : band === "warn" ? "warn" : "pass";
}

/** One check's outcome, as the record needs it. */
interface Judgment {
  readonly source: InjectionSource;
  readonly signals: InjectionSignals;
  readonly band: InjectionBand;
  readonly decision: InjectionDecision;
  readonly answers: Record<string, JevAnswer>;
  readonly meta: JevJudgmentMeta;
}

/**
 * The `jev_judgment` payload for one check. The judged text is **never**
 * copied here — neither the message (it is the `user_message` when the
 * turn runs, and a cancelled turn must leave no trace of it) nor the tool
 * result (ADR-0034 §2: the inspected content is not retained). What the
 * record keeps is the judgment: the two probabilities, the band and what
 * was done about it.
 */
function judgmentRecord(judgment: Judgment): Record<string, unknown> {
  const { signals, band } = judgment;
  // A warning raised by the sensitive signal carries the one action it
  // implies; the client renders whatever the record says instead of
  // re-deriving it (one home for the copy, and the log says why it warned).
  const sensitiveDrove =
    band === "warn" &&
    signals.sensitive >= INJECTION_THRESHOLDS.warnMin &&
    signals.injection < INJECTION_THRESHOLDS.warnMin;
  return {
    useCase: "injection",
    source: judgment.source,
    band,
    decision: judgment.decision,
    injection: signals.injection,
    sensitive: signals.sensitive,
    ...(sensitiveDrove ? { advice: SENSITIVE_ADVICE } : {}),
    questions: { injection: signals.injection, sensitive: signals.sensitive },
    answers: judgment.answers,
    model: judgment.meta.model,
    latencyMs: judgment.meta.latencyMs,
    usage: judgment.meta.usage,
  };
}

/**
 * Builds the per-session judge. No session state: unlike the guardrail's
 * verdict cache (identical commands are identical), a message and a page
 * are judged once and never repeat verbatim; caching them would only
 * grow.
 */
export function createInjectionJudge(deps: InjectionJudgeDeps) {
  return {
    /**
     * Judges the user's turn input. `null` means "no judgment" (the Jev
     * call failed): the turn proceeds untouched, exactly as without Jev.
     */
    async judgeInput(text: string): Promise<InjectionInputVerdict | null> {
      const message = sliceForJudgment(text, INJECTION_INPUT_MAX_BYTES);
      // The band is decided inside `record` so the payload and the hook's
      // behaviour come from one computation. This judge owns its records,
      // hence the `null` returns (see `JevJudgeInput.record`): a `confirm`
      // judgment is recorded once, with the answer it produced.
      let verdict: InjectionInputVerdict | undefined;
      const outcome = await deps.client.judge({
        state: message,
        questions: INJECTION_QUESTIONS,
        record: (answers, meta) => {
          const signals = signalsOf(answers);
          const band = injectionBand(signals);
          const payload = judgmentRecord({
            source: "input",
            signals,
            band,
            decision: decisionOf(band, "input"),
            answers,
            meta,
          });
          if (band !== "confirm") {
            deps.append(payload);
            verdict = { band, signals };
            return null;
          }
          verdict = {
            band,
            signals,
            reason: injectionConfirmReason(signals),
            // Deferred, not skipped: the answer is part of what happened,
            // and for a cancelled turn this record is the only trace left.
            resolve: (resolution: TurnConfirmOutcome) => {
              deps.append({
                ...payload,
                decision:
                  resolution === "send" ? "confirmed" : resolution === "cancel" ? "cancelled" : "refused-headless",
              });
            },
          };
          return null;
        },
      });
      if (!outcome.ok || !verdict) return null;
      return verdict;
    },

    /**
     * Judges one external tool result. Returns the refusal reason when the
     * result must be withheld, `undefined` otherwise (pass or warn — the
     * middle band is visible in the log and changes nothing).
     */
    async judgeToolResult(name: string, output: string): Promise<InjectionToolVerdict | null> {
      const source: InjectionSource = `tool:${name}`;
      const text = sliceForJudgment(output, INJECTION_TOOL_MAX_BYTES);
      let verdict: InjectionToolVerdict | undefined;
      const outcome = await deps.client.judge({
        state: text,
        questions: INJECTION_QUESTIONS,
        record: (answers, meta) => {
          const signals = signalsOf(answers);
          const band = injectionBand(signals);
          const payload = judgmentRecord({
            source,
            signals,
            band,
            decision: decisionOf(band, source),
            answers,
            meta,
          });
          deps.append(payload);
          verdict = {
            band,
            signals,
            ...(band === "confirm" ? { withhold: injectionWithholdReason(signals) } : {}),
          };
          return null;
        },
      });
      if (!outcome.ok || !verdict) return null;
      return verdict;
    },
  };
}

export type InjectionJudge = ReturnType<typeof createInjectionJudge>;
