/**
 * Eval case types (#524): one JSON file per case, scored deterministically
 * against `moh run --cassette` output.
 *
 * A case is data only — no code — so suites stay reviewable diffs. The
 * runner materializes each case in an isolated home + temp project root,
 * runs the real headless path, then scores the streamed event log.
 */

/** One scripted model turn (MockProvider.cassette format). */
export type { MockTurnScript } from "../../core/src/mock-provider";

export interface ToolCallExpectation {
  name: string;
  /** Substrings that must all appear in the JSON-serialized call args. */
  argsInclude?: string[];
}

export interface FileExpectation {
  path: string;
  /** Exact expected content; omit to assert only existence/non-empty. */
  content?: string;
  /** File must NOT exist (use with `forbidden`-style negative checks). */
  absent?: boolean;
}

export interface CaseAssertions {
  /** Ordered subset-match: every expected call appears in this order among the case's tool_call events (extra calls allowed). */
  toolCalls?: ToolCallExpectation[];
  /** Expected files in the temp project root after the run. */
  files?: FileExpectation[];
  /** Expected denied tool results: tool name + denial reason. */
  denials?: { tool: string; reason: string }[];
  /** Expected run exit code (default 0). */
  exitCode?: number;
  /** Tool names that must NOT appear in any tool_call event. */
  forbiddenTools?: string[];
  /** Path fragments that must not appear in any write/edit call. */
  forbiddenPaths?: string[];
  /** Substrings that must appear somewhere in the assistant reply text. */
  replyIncludes?: string[];
}

/** A single eval case file. */
export interface EvalCase {
  prompt: string;
  /** Cassette turns scripting the model side (inline or a file path relative to the case dir). */
  cassette: string | unknown[];
  /** Permission rules granted for the run (same grammar as --allow). */
  permissions?: { allow?: string[]; deny?: string[] };
  assertions: CaseAssertions;
  /** Optional extra CLI flags for the run (e.g. --fork workflows are driven by the runner's session suite instead). */
  flags?: string[];
  /** Files created in the temp project root before the run (key = relative path). */
  setup?: Record<string, string>;
}

/** A step in a multi-run case: each step is one `moh run`, later steps resume the same session file. */
export interface RunStep {
  prompt: string;
  cassette: string | unknown[];
  permissions?: { allow?: string[]; deny?: string[] };
  flags?: string[];
  /** Fork instead of plain resume (step >= 2 only). */
  fork?: boolean;
  assertions?: CaseAssertions;
}

/** A multi-run case: step 1 starts the session, later steps resume (--session) or fork (--session --fork) it. */
export interface MultiRunCase {
  steps: RunStep[];
  setup?: Record<string, string>;
  /** Assertions on the final session's event log (the whole JSONL, all runs). */
  sessionAssertions?: {
    /** Ordered subset-match over tool names across the whole log. */
    toolCallOrder?: string[];
    /** Chrome events that must appear (e.g. "session_resumed"). */
    chromeEvents?: string[];
    /** Chrome events that must NOT appear. */
    absentChromeEvents?: string[];
  };
}
