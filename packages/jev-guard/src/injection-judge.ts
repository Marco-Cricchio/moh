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
 * The notable records land as soon as the answers land: `silent` and `warn`
 * immediately, the `confirm` band when the user's decision is known
 * (through the `resolve` callback the hook hands to `onResolved`), because
 * "was this sent?" is part of what happened. A tool-result judgment that
 * decided nothing is the exception (#980, the #846 precedent): a passing
 * result changes neither what the user saw nor what the model received, and
 * one record per fetched page reaches ADR-0032's per-turn event cap on its
 * own, dropping the judgments that *did* matter. So the passes accumulate
 * and land as one aggregate record per turn (`flushPasses`), which keeps
 * "judged and passed" distinguishable from "never judged" — the count and
 * the call ids — without spending the budget page by page.
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
   * is a judgment nobody can audit (ratified: no sampling). A tool-result
   * *pass* is not a record of its own: it is counted and flushed once per
   * turn (#980).
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

/** The tool result to judge, as the `onToolResult` seam hands it over. */
export interface InjectionToolCall {
  /** Correlates the aggregate record with the `tool_call` it judged (#980). */
  readonly callId: string;
  readonly name: string;
  readonly output: string;
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
  /** The judged tool call, on the tool half only (#980). */
  readonly callId?: string;
}

/**
 * The turn's pass aggregate (#980): the count is derived from the ids, so
 * the two can never disagree, and the ids are what keeps "judged and
 * passed" distinguishable from "never judged".
 */
function passesRecord(callIds: readonly string[]): Record<string, unknown> {
  return { useCase: "injection_passes", calls: callIds.length, callIds: [...callIds] };
}

/**
 * ADR-0032 §2 drops an over-8-KiB payload whole rather than truncating it,
 * so the aggregate is split instead of grown: one record per chunk of ids,
 * each well inside the cap. Only a turn judging hundreds of results ever
 * gets a second record — and it still names every one of them, which is the
 * distinction the aggregate exists for.
 */
const PASSES_RECORD_MAX_BYTES = 4096;

/** An aggregate's fixed fields minus the ids: the size a chunk's ids have
 * to fit alongside. Taken from the builder itself, never re-estimated. */
const PASSES_OVERHEAD_BYTES = Buffer.byteLength(JSON.stringify(passesRecord([])), "utf8");

/** Splits the turn's passing call ids into per-record chunks (#980). A
 * single id longer than the budget rides alone: an id is never cut. */
function chunkPasses(callIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let size = PASSES_OVERHEAD_BYTES;
  for (const callId of callIds) {
    // The quotes JSON adds, plus the separating comma.
    const bytes = Buffer.byteLength(callId, "utf8") + 3;
    if (chunk.length > 0 && size + bytes > PASSES_RECORD_MAX_BYTES) {
      chunks.push(chunk);
      chunk = [];
      size = PASSES_OVERHEAD_BYTES;
    }
    chunk.push(callId);
    size += bytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
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
    ...(judgment.callId !== undefined ? { callId: judgment.callId } : {}),
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
  // #980: the turn's passing tool-result judgments, aggregated into one
  // record. A pass decided nothing — the result reached the model exactly
  // as it would have without the check — so it needs no record of its own;
  // but it must stay distinguishable from "never judged", hence the ids.
  // The input half is untouched: one judgment per send, notable or not.
  //
  // The aggregate rides at the end of the turn, so a turn whose *notable*
  // records alone exhaust ADR-0032's per-turn cap loses the count too — the
  // existing `event_cap` report is the visible trace of that, and the
  // notable records (the ones that changed what the model received) are
  // already in the log. No reservation seam exists to spend earlier.
  const passCallIds = new Set<string>();

  return {
    /**
     * #980: flushes this turn's passing tool-result judgments as one
     * aggregate record (called at `afterTurn`); a turn whose judged
     * results all decided something records nothing here. A turn with more
     * passing results than one record can name gets a record per chunk,
     * never a dropped one; either way the set resets for the next turn.
     */
    flushPasses(): void {
      if (passCallIds.size === 0) return;
      const callIds = [...passCallIds];
      passCallIds.clear();
      for (const chunk of chunkPasses(callIds)) deps.append(passesRecord(chunk));
    },
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
     *
     * A `pass` is not recorded here (#980): it joins the turn's aggregate
     * (see `flushPasses`). `warn` and the withholding `confirm` band are
     * safety-relevant — they change what will be sent — so each keeps its
     * own record, unsampled.
     */
    async judgeToolResult(call: InjectionToolCall): Promise<InjectionToolVerdict | null> {
      const source: InjectionSource = `tool:${call.name}`;
      const text = sliceForJudgment(call.output, INJECTION_TOOL_MAX_BYTES);
      let verdict: InjectionToolVerdict | undefined;
      const outcome = await deps.client.judge({
        state: text,
        questions: INJECTION_QUESTIONS,
        record: (answers, meta) => {
          const signals = signalsOf(answers);
          const band = injectionBand(signals);
          const decision = decisionOf(band, source);
          if (decision === "pass") {
            // #980: a passing judgment lands as one aggregate record per
            // turn, not one per fetched page.
            passCallIds.add(call.callId);
          } else {
            deps.append(
              judgmentRecord({
                source,
                callId: call.callId,
                signals,
                band,
                decision,
                answers,
                meta,
              }),
            );
          }
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
