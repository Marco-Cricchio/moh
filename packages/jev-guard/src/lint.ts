/**
 * The quality gate's questions, thresholds and correction copy (#789).
 *
 * Golden rule (TypeSafe skill guidance): a use case's questions AND its
 * thresholds live in ONE file, co-written with the owner and revised as
 * configuration — never scattered through the logic.
 *
 * Three fixed yes/no judgments, independent of which convention documents
 * were found (the documents are *state*, the questions are *constants*).
 * Any answer below `LINT_ALERT` counts as a finding; the gate speaks when
 * there is at least one.
 */
import { questions } from "./questions-core";

/** `conventions_respected` (noul): yes = the change follows the rules. */
export const LINT_CONVENTIONS_QUESTION = questions.noul(
  "Does the changed code follow the conventions described in the rules?",
  {
    true: "naming, structure, error and style decisions match what the rules ask for",
    false: "the change contradicts or ignores a stated convention",
  },
);

/** `error_handling` (noul): yes = failure paths are handled. */
export const LINT_ERROR_HANDLING_QUESTION = questions.noul(
  "Does the changed code handle failure paths rather than assuming success (missing files, network errors, invalid input)?",
  {
    true: "errors are caught, surfaced or propagated deliberately",
    false: "calls can throw or fail silently on plausible bad input",
  },
);

/** `completeness` (noul): yes = nothing obvious is missing. */
export const LINT_COMPLETENESS_QUESTION = questions.noul(
  "Does the change fully address the request, with no obvious piece left unimplemented or stubbed?",
  {
    true: "the work is whole: no TODO stubs, no dangling half-wired pieces",
    false: "a visible piece is missing, stubbed or falsely claimed done",
  },
);

/** Map of question id → question, exactly what one judge call sends. */
export const LINT_QUESTIONS = {
  conventions_respected: LINT_CONVENTIONS_QUESTION,
  error_handling: LINT_ERROR_HANDLING_QUESTION,
  completeness: LINT_COMPLETENESS_QUESTION,
} as const;

/** The ids of the three questions, as the answers come back keyed. */
export type LintQuestionId = keyof typeof LINT_QUESTIONS;

/** Ratified thresholds (code constants in v1, tuned on data, never config). */
export const LINT_THRESHOLDS = {
  /** Any question strictly below this is a finding; the gate speaks. */
  LINT_ALERT: 0.4,
} as const;

/** The diff and rubric budgets (ratified ~32 KiB / 16 KiB). */
export const LINT_DIFF_MAX_BYTES = 32 * 1024;

/** The visible truncation marker for the diff. */
export const LINT_DIFF_TRUNCATION_MARKER = "…[truncated]";

/** Plain-words names for the three dimensions (correction text + records). */
export const LINT_DIMENSION_LABELS: Record<LintQuestionId, string> = {
  conventions_respected: "conventions",
  error_handling: "error handling",
  completeness: "completeness",
};

/**
 * The deterministic correction-turn text (ratified: never
 * model-generated). Names the failing dimensions in plain words AND the
 * files that were judged (#851 — a fix request without its scope is not
 * actionable), and asks for a fix; the model runs a normal turn with
 * tools available.
 */
export function correctionText(findings: LintQuestionId[], cycle: number, judgedPaths: readonly string[]): string {
  // A decision of "correct" always carries findings; the guard keeps the
  // copy well-formed even on a boundary violation.
  if (findings.length === 0) findings = ["completeness"];
  const labels = findings.map((f) => LINT_DIMENSION_LABELS[f]);
  const list =
    labels.length === 1
      ? labels[0]!
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]!}`;
  const ordinal = cycle === 0 ? "second" : "final";
  return [
    "[automatic quality check by jev-guard]",
    `The quality gate flagged this task's changes on: ${list}.`,
    `Judged files: ${judgedPaths.length > 0 ? judgedPaths.join(", ") : "(unspecified)"}.`,
    `Please fix the flagged ${labels.length === 1 ? "area" : "areas"} in this ${ordinal} correction round before considering the task done.`,
  ].join("\n");
}

/**
 * #851: whether a unified diff touches repository code. The three
 * questions are written for code; a diff whose every file is a non-code
 * artifact (markdown, lockfiles, configs) must not be scored with them —
 * the gate stays silent instead of demanding an impossible fix.
 */
const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|cts|mts|json|rs|go|py|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|css|scss|html|vue|svelte|lua|dart|scala|clj|ex|exs|erl|hs|ml|toml|ya?ml)$/i;

export function containsCodeChanges(diff: string): boolean {
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/") || line.startsWith("--- a/")) {
      const file = line.slice(6).trim();
      if (CODE_EXTENSIONS.test(file)) return true;
    } else if (line.startsWith("+++ /dev/null") || line.startsWith("--- /dev/null")) {
      // The no-index new-file form names /dev/null on one side; the
      // other side carries the real path — already checked above.
    }
  }
  return false;
}
