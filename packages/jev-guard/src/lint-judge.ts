/**
 * The quality gate's judge (#789): one end-of-task evaluation over the
 * discovered convention documents (state.rules) and the task's unified
 * diff (state.changes), answered with the three fixed questions.
 *
 * Fail-open throughout (ratified degradation model): a failed call, a
 * missing rubric set or an unreadable diff produces **no judgment** — the
 * gate stays silent and moh behaves exactly as without Jev. The one
 * `∅ jev offline` signal is the only trace.
 */
import { noulProbability, type JevAnswer, type JevClient, type JevJudgmentMeta } from "./client";
import {
  LINT_DIMENSION_LABELS,
  LINT_QUESTIONS,
  LINT_THRESHOLDS,
  type LintQuestionId,
} from "./lint";

/** A task's judged state: the conventions plus the task's own diff. */
export interface LintState {
  /** The discovered convention documents, combined (already capped). */
  readonly rules: string;
  /** Repo-relative paths of the documents judged, for the record. */
  readonly rulesFiles: readonly string[];
  /** The unified diff of the files this task changed (capped). */
  readonly changes: string;
  /** The diff's byte size before truncation, for the record. */
  readonly diffBytes: number;
}

/** The three probabilities, one per dimension. */
export interface LintSignals {
  readonly conventions_respected: number;
  readonly error_handling: number;
  readonly completeness: number;
}

/** What one evaluation decided. */
export interface LintVerdict {
  readonly signals: LintSignals;
  /** The dimensions strictly below the alert threshold. */
  readonly findings: LintQuestionId[];
  /** `pass` when nothing was flagged, `correct` when a turn is asked for. */
  readonly decision: "pass" | "correct";
}

export interface LintJudgeDeps {
  client: Pick<JevClient, "judge">;
  /**
   * The one log seam: the extension turns this into `ctx.appendEvent`
   * (`jev_judgment`). Required — no sampling.
   */
  append: (payload: Record<string, unknown>) => void;
}

function signalsOf(answers: Record<string, JevAnswer>): LintSignals {
  return {
    conventions_respected: noulProbability(answers, "conventions_respected"),
    error_handling: noulProbability(answers, "error_handling"),
    completeness: noulProbability(answers, "completeness"),
  };
}

/** The boundary, in one place: strictly below the alert is a finding. */
export function lintFindings(signals: LintSignals): LintQuestionId[] {
  return (Object.keys(LINT_QUESTIONS) as LintQuestionId[]).filter((id) => signals[id] < LINT_THRESHOLDS.LINT_ALERT);
}

export function createLintJudge(deps: LintJudgeDeps) {
  return {
    /**
     * One evaluation. `null` = no judgment (the call failed): the gate is
     * inert for this cycle, never a false correction.
     */
    async evaluate(
      state: LintState,
      cycle: number,
    ): Promise<LintVerdict | null> {
      let answers: Record<string, JevAnswer> | undefined;
      let meta: JevJudgmentMeta | undefined;
      const outcome = await deps.client.judge({
        state: { rules: state.rules, changes: state.changes },
        questions: LINT_QUESTIONS,
        record: (a, m) => {
          answers = a;
          meta = m;
          // The full record is built below once the decision is known;
          // the client appends only what this returns (nothing here).
          return {};
        },
      });
      if (!outcome.ok || !answers || !meta) return null;
      const signals = signalsOf(answers);
      const findings = lintFindings(signals);
      const decision: LintVerdict["decision"] = findings.length > 0 ? "correct" : "pass";
      deps.append({
        useCase: "lint",
        cycle,
        decision,
        ...(findings.length > 0 ? { findings: findings.map((f) => LINT_DIMENSION_LABELS[f]) } : {}),
        conventions_respected: signals.conventions_respected,
        error_handling: signals.error_handling,
        completeness: signals.completeness,
        rulesFiles: [...state.rulesFiles],
        diffBytes: state.diffBytes,
        questions: { ...signals },
        answers,
        model: meta.model,
        latencyMs: meta.latencyMs,
        usage: meta.usage,
      });
      return { signals, findings, decision };
    },
  };
}

export type LintJudge = ReturnType<typeof createLintJudge>;
