/**
 * The Jev prompt classification use case (#788): task-type context and the
 * MPM per-turn gate.
 *
 * Golden rule (TypeSafe skill guidance): a use case's questions AND its
 * thresholds live in ONE file, co-written with the owner and revised as
 * configuration — never scattered through the logic. This module is that
 * single home for the classification check.
 *
 * Ratified shape (vision note 35 #3, issue #788):
 * - one Choice over the task types `question` / `bugfix` / `feature` /
 *   `refactoring` / `analysis`, plus one yes/no probability
 *   (`codebase_oriented`) answering "does answering this require
 *   understanding this project's code, structure or conventions?";
 * - consumer one: the MPM gate — a `codebase_oriented` probability below
 *   `CODEBASE_ORIENTED_MIN` suppresses the per-turn orientation plan;
 * - consumer two: task-type hints — small typed system-prompt additions
 *   (constants below), applied when the task-type confidence is at least
 *   `HINT_CONFIDENCE_MIN`; no hint on a low-confidence classification;
 * - reuses the routing classifier's request when routing is on (one state,
 *   one question set composed of both use cases' questions).
 */
import { questions } from "./questions-core";

/** The task types; the names themselves are the contract. */
export const TASK_TYPES = ["question", "bugfix", "feature", "refactoring", "analysis"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Ratified thresholds (code constants in v1, tuned on data, never config). */
export const CLASSIFICATION_THRESHOLDS = {
  /** `codebase_oriented` below this suppresses the per-turn MPM plan. */
  codebaseOrientedMin: 0.5,
  /** Task-type confidence at or above this applies the hint. */
  hintConfidenceMin: 0.6,
} as const;

/** The judged state: the last user message, capped like routing's (2 KiB). */
export const CLASSIFICATION_MESSAGE_MAX_BYTES = 2048;

const TASK_RUBRIC: Record<TaskType, string> = {
  question:
    "an informational request: the user asks how something works, what something means, or where something is",
  bugfix:
    "something is broken or behaves wrongly and the user wants it fixed",
  feature:
    "the user asks for new behaviour or a new capability that does not exist yet",
  refactoring:
    "the user asks to restructure or clean up existing behaviour without changing it",
  analysis:
    "the user asks to investigate, review, or explain code or a problem before acting on it",
};

const TYPE_INSTRUCTIONS =
  "Judge what kind of engineering task this single user message asks for, ignoring any earlier conversation you cannot see. Pick the closest type.";

const CODEBASE_INSTRUCTIONS =
  "Does answering this message well require understanding this specific project's code, structure or conventions?";

/** The classification question set: one Choice + one noul. */
export const CLASSIFICATION_QUESTIONS = {
  task_type: questions.choice(TYPE_INSTRUCTIONS, {
    question: TASK_RUBRIC.question,
    bugfix: TASK_RUBRIC.bugfix,
    feature: TASK_RUBRIC.feature,
    refactoring: TASK_RUBRIC.refactoring,
    analysis: TASK_RUBRIC.analysis,
  }),
  codebase_oriented: questions.noul(CODEBASE_INSTRUCTIONS, {
    true: "the answer needs this project's own code or conventions",
    false: "a generic answer without the project would do",
  }),
} as const;

/** The task type a Choice answer named, or undefined when it is not one. */
export function taskTypeFromAnswer(choice: string | undefined): TaskType | undefined {
  return choice !== undefined && (TASK_TYPES as readonly string[]).includes(choice)
    ? (choice as TaskType)
    : undefined;
}

/**
 * The hints: small fixed per-type constants (ratified: co-written copy,
 * never generated). None of them outranks the project's own instructions —
 * the core renders them in the subordinate `turn_notes` section (ADR-0036),
 * which is what keeps that promise mechanically.
 */
export const TASK_TYPE_HINTS: Record<TaskType, string> = {
  question: "Answer this question concisely, and point at the supporting files.",
  bugfix: "This looks like a bug fix: reproduce the failure first, then fix the cause rather than the symptom.",
  feature:
    "This looks like new work: follow the existing structure, and extend an existing seam rather than adding a parallel one.",
  refactoring:
    "This looks like a refactoring: keep behaviour unchanged and the diff mechanical.",
  analysis: "This looks like an analysis task: investigate and answer without modifying files.",
};

/** The classification's answers, as signals. */
export interface ClassificationSignals {
  /** The task type the answer named, when it is a valid one. */
  readonly taskType?: TaskType;
  /** The Choice answer's confidence, 0–1 (0 for a malformed answer). */
  readonly confidence: number;
  /** The `codebase_oriented` probability, 0–1. */
  readonly codebaseOriented: number;
}

/** Reads one answers map into the classification's signals. */
export function classificationSignals(answers: Record<string, import("./client").JevAnswer>): ClassificationSignals {
  const type = answers.task_type;
  const choice = type?.type === "choice" ? type.choice : undefined;
  const confidence = type?.type === "choice" && typeof type.confidence === "number" ? type.confidence : 0;
  const oriented = answers.codebase_oriented;
  return {
    ...(taskTypeFromAnswer(choice) !== undefined ? { taskType: taskTypeFromAnswer(choice) } : {}),
    confidence,
    codebaseOriented:
      oriented?.type === "noul" && typeof oriented.noul === "number" ? oriented.noul : 0,
  };
}

/**
 * The per-turn MPM gate (#788 consumer one): a confidently-conversational
 * turn suppresses the orientation plan. `undefined` (no answer — feature
 * off, outage, malformed) means "no opinion": the map behaves exactly as
 * today. Never anything but the per-turn plan: the projection, the
 * `mpm_query` tool and the manual commands are untouched.
 */
export function mpmGate(signals: ClassificationSignals): boolean | undefined {
  if (signals.confidence === 0 && signals.codebaseOriented === 0) return undefined;
  return signals.codebaseOriented >= CLASSIFICATION_THRESHOLDS.codebaseOrientedMin;
}

/**
 * The hint for this turn, or `undefined` when none applies: an unusable or
 * low-confidence task type gets no hint (never a guess), and the `question`
 * type's hint still applies (it is a hint like any other).
 */
export function hintFor(signals: ClassificationSignals): string | undefined {
  if (signals.taskType === undefined) return undefined;
  if (signals.confidence < CLASSIFICATION_THRESHOLDS.hintConfidenceMin) return undefined;
  return TASK_TYPE_HINTS[signals.taskType];
}
