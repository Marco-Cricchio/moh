/**
 * The end-of-task quality gate runner (#789): turns one settled "done"
 * turn into at most two evaluate→correct cycles.
 *
 * Flow (ratified): the extension collects the paths the task wrote or
 * edited through its `onToolCall` observation; at `afterTurn` with
 * `status: "done"` the runner checks the cheap preconditions (task
 * changed files, rubric docs exist, git diff readable), evaluates, and on
 * a finding asks the core for a synthetic correction turn (ADR-0037),
 * then re-judges. Hard stop after two cycles; correction turns are
 * marked and never re-gated (the core's depth cap is the backstop, the
 * runner's own cycle cap is the policy).
 *
 * Fail-open: every degraded precondition produces silence, never a false
 * correction.
 */
import { captureHead, inGitRepo, taskDiff } from "./diff";
import { correctionText, LINT_DIFF_MAX_BYTES, LINT_DIFF_TRUNCATION_MARKER } from "./lint";
import type { LintJudge, LintState } from "./lint-judge";
import { truncateToBytes } from "./routing";
import { discoverRubrics } from "./rubrics";

/** The correction cycles this gate may spend (ratified hard stop). */
export const LINT_MAX_CYCLES = 2;

export interface LintGateDeps {
  judge: Pick<LintJudge, "evaluate">;
  /** The project root (rubric discovery + git). */
  root: string;
  /** The core-mediated correction-turn door (ADR-0037). */
  requestTurn: (text: string) => Promise<boolean>;
  /**
   * Records a cycle-cap stop (spec §2: "a cycle-cap stop is recorded as
   * such on the final record") — the last judgment said `correct` but the
   * gate cannot ask for another turn.
   */
  reportStop: (reason: "cycle-cap" | "request-refused", lastFindings: readonly string[]) => void;
}

/** The mutable per-task state the extension feeds in. */
export interface LintTaskState {
  /** Repo-relative paths this task wrote or edited (deduplicated). */
  writtenPaths: string[];
  /** Set while a correction turn the gate itself requested is running. */
  inCorrectionTurn: boolean;
}

export function createLintTaskState(): LintTaskState {
  return { writtenPaths: [], inCorrectionTurn: false };
}

export interface LintGate {
  /** Cheap per-tool-call observation: record the path a write/edit touches. */
  observeToolCall(name: string, args: unknown): void;
  /**
   * The `afterTurn` body. Skips silently when the preconditions fail
   * (no changes, no rubrics, no repo, correction turn); returns the
   * number of gate evaluations that actually ran.
   */
  onTaskEnd(toolCalls: readonly { name: string }[]): Promise<number>;
  /** Clears the per-task state (session end, or a fresh user turn). */
  reset(): void;
}

export function createLintGate(deps: LintGateDeps, state: LintTaskState = createLintTaskState()): LintGate {
  return {
    observeToolCall(name: string, args: unknown): void {
      if (name !== "write" && name !== "edit") return;
      const a = (args ?? {}) as Record<string, unknown>;
      if (typeof a.path === "string" && a.path.trim() !== "") state.writtenPaths.push(a.path.trim());
    },

    reset(): void {
      state.writtenPaths = [];
      state.inCorrectionTurn = false;
    },

    async onTaskEnd(): Promise<number> {
      // A correction turn's own settle is never re-gated (no recursion).
      if (state.inCorrectionTurn) {
        state.inCorrectionTurn = false;
        state.writtenPaths = [];
        return 0;
      }
      const paths = [...new Set(state.writtenPaths)];
      // Nothing modified → nothing to judge (ratified).
      if (paths.length === 0) return 0;
      // Rubric discovery: no convention documents → inert, no call, no event.
      const rubrics = discoverRubrics(deps.root);
      if (rubrics.length === 0) return 0;
      // Outside a repo, or an unreadable diff → inert for this turn.
      if (!inGitRepo(deps.root)) return 0;
      const head = captureHead(deps.root);
      if (head === null) return 0;
      const rules = rubrics.map((r) => `# ${r.path}\n${r.text}`).join("\n\n");
      const rulesFiles = rubrics.map((r) => r.path);

      let evaluations = 0;
      // Up to two evaluate→correct cycles (ratified hard stop). The diff
      // is recomputed each cycle, so cycle 2 judges the *corrected* tree.
      for (let cycle = 0; cycle < LINT_MAX_CYCLES; cycle++) {
        const diff = taskDiff(deps.root, head, paths);
        if (diff === null || diff.trim() === "") break;
        const diffBytes = Buffer.byteLength(diff, "utf8");
        const judgedDiff = truncateToBytes(diff, LINT_DIFF_MAX_BYTES);
        const judgedState: LintState = {
          rules,
          rulesFiles,
          changes: diffBytes > LINT_DIFF_MAX_BYTES ? `${judgedDiff}\n${LINT_DIFF_TRUNCATION_MARKER}` : judgedDiff,
          diffBytes,
        };
        const verdict = await deps.judge.evaluate(judgedState, cycle);
        if (verdict === null) break; // fail-open: no judgment, no correction
        evaluations += 1;
        if (verdict.decision !== "correct") break;
        const text = correctionText(verdict.findings, cycle);
        state.inCorrectionTurn = true;
        const ok = await deps.requestTurn(text);
        if (!ok) {
          // The core refused (depth cap, busy): the gate stops; the
          // refusal is already a visible core-side event, and the stop is
          // recorded on top of it.
          state.inCorrectionTurn = false;
          deps.reportStop("request-refused", verdict.findings);
          break;
        }
        // The cap was reached and the verdict was still `correct`: record
        // the stop (spec §2), then the loop ends naturally.
        if (cycle === LINT_MAX_CYCLES - 1) deps.reportStop("cycle-cap", verdict.findings);
      }
      // The gate owns the per-task state lifecycle: the task is over.
      state.writtenPaths = [];
      return evaluations;
    },
  };
}
