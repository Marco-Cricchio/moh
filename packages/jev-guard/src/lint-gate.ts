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
import { captureHead, inGitRepo, taskDiff, turnMutatedFiles } from "./diff";
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
}

/** The mutable per-task state the extension feeds in. */
export interface LintTaskState {
  /** Repo-relative paths this task wrote or edited (deduplicated). */
  writtenPaths: string[];
  /** Set while a correction turn the gate itself requested is running. */
  inCorrectionTurn: boolean;
  /** Findings already recorded for the current task (correction text). */
  pendingFindings: string[] | null;
}

export function createLintTaskState(): LintTaskState {
  return { writtenPaths: [], inCorrectionTurn: false, pendingFindings: null };
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
      state.pendingFindings = null;
    },

    async onTaskEnd(toolCalls): Promise<number> {
      // A correction turn's own settle is never re-gated (no recursion).
      if (state.inCorrectionTurn) {
        state.inCorrectionTurn = false;
        return 0;
      }
      const paths = [...new Set(state.writtenPaths)];
      // Nothing modified → nothing to judge (ratified).
      if (paths.length === 0 && !turnMutatedFiles(toolCalls)) return 0;
      if (paths.length === 0) return 0;
      // Rubric discovery: no convention documents → inert, no call, no event.
      const rubrics = discoverRubrics(deps.root);
      if (rubrics.length === 0) return 0;
      // Outside a repo, or an unreadable diff → inert for this turn.
      if (!inGitRepo(deps.root)) return 0;
      const head = captureHead(deps.root);
      if (head === null) return 0;
      const diff = taskDiff(deps.root, head, paths);
      if (diff === null || diff.trim() === "") return 0;
      const diffBytes = Buffer.byteLength(diff, "utf8");
      const judgedDiff = truncateToBytes(diff, LINT_DIFF_MAX_BYTES);
      const changes =
        diffBytes > LINT_DIFF_MAX_BYTES ? `${judgedDiff}\n${LINT_DIFF_TRUNCATION_MARKER}` : judgedDiff;
      const judgedState: LintState = {
        rules: rubrics.map((r) => `# ${r.path}\n${r.text}`).join("\n\n"),
        rulesFiles: rubrics.map((r) => r.path),
        changes,
        diffBytes,
      };

      let evaluations = 0;
      // Up to two evaluate→correct cycles (ratified hard stop).
      for (let cycle = 0; cycle < LINT_MAX_CYCLES; cycle++) {
        const verdict = await deps.judge.evaluate(judgedState, cycle);
        if (verdict === null) break; // fail-open: no judgment, no correction
        evaluations += 1;
        if (verdict.decision !== "correct") break;
        const text = correctionText(verdict.findings, cycle);
        state.inCorrectionTurn = true;
        const ok = await deps.requestTurn(text);
        if (!ok) {
          // The core refused (depth cap, busy): the gate stops; the
          // refusal is already a visible core-side event.
          state.inCorrectionTurn = false;
          break;
        }
      }
      // The gate owns the per-task state lifecycle: the task is over.
      state.writtenPaths = [];
      state.pendingFindings = null;
      return evaluations;
    },
  };
}
