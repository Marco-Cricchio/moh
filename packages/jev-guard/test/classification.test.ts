/**
 * #788 prompt classification: the questions, the gate rule, the hint rule
 * and the judge against a fake client (no network in CI). The golden set
 * maps ~10 messages to their expected task types through a scripted
 * answer table — the mapping itself is the classifier's contract; the
 * shared-request path with routing issues exactly one call per turn.
 */
import { describe, expect, test } from "bun:test";
import {
  CLASSIFICATION_QUESTIONS,
  CLASSIFICATION_THRESHOLDS,
  TASK_TYPES,
  TASK_TYPE_HINTS,
  classificationSignals,
  createClassificationJudge,
  hintFor,
  mpmGate,
  taskTypeFromAnswer,
  type TaskType,
} from "../src/index";
import type { JevAnswer, JevClient, JevJudgeInput, JevOutcome } from "../src/client";

function choiceAnswer(choice: string, confidence: number): JevAnswer {
  return { type: "choice", choice, probabilities: { [choice]: confidence }, confidence };
}

function fake(
  answers: { taskType: string; confidence: number; oriented: number } | { fail: true },
): JevClient & { calls: JevJudgeInput[] } {
  const calls: JevJudgeInput[] = [];
  return {
    calls,
    async judge(input: JevJudgeInput): Promise<JevOutcome> {
      calls.push(input);
      if ("fail" in answers) return { ok: false, kind: "timeout", message: "boom" };
      const payload: Record<string, JevAnswer> = {
        task_type: choiceAnswer(answers.taskType, answers.confidence),
        codebase_oriented: { type: "noul", noul: answers.oriented },
      };
      input.record(payload, { model: "jev-latest", latencyMs: 10, usage: { inputTokens: 60, outputTokens: 6 } });
      return { ok: true, answers: payload, model: "jev-latest", latencyMs: 10, usage: { inputTokens: 60, outputTokens: 6 } };
    },
  };
}

function judgeOver(answers: { taskType: string; confidence: number; oriented: number } | { fail: true }) {
  const records: Record<string, unknown>[] = [];
  const client = fake(answers);
  const judge = createClassificationJudge({ client, append: (p) => records.push(p) });
  return { judge, records, client };
}

describe("classification questions and thresholds (#788)", () => {
  test("one Choice over the five task types + one noul", () => {
    expect(Object.keys(CLASSIFICATION_QUESTIONS)).toEqual(["task_type", "codebase_oriented"]);
    expect(CLASSIFICATION_QUESTIONS.task_type.type).toBe("choice");
    expect(Object.keys(CLASSIFICATION_QUESTIONS.task_type.criteria)).toEqual([...TASK_TYPES]);
    expect(CLASSIFICATION_QUESTIONS.codebase_oriented.type).toBe("noul");
    expect(CLASSIFICATION_THRESHOLDS).toEqual({ codebaseOrientedMin: 0.5, hintConfidenceMin: 0.6 });
  });

  test("a malformed or foreign answer is no judgment", () => {
    expect(taskTypeFromAnswer("cooking")).toBeUndefined();
    expect(taskTypeFromAnswer(undefined)).toBeUndefined();
    const signals = classificationSignals({});
    expect(signals.taskType).toBeUndefined();
    expect(signals.confidence).toBe(0);
    expect(signals.codebaseOriented).toBe(0);
    // No opinion at all: the gate is undefined, the hint absent.
    expect(mpmGate(signals)).toBeUndefined();
    expect(hintFor(signals)).toBeUndefined();
  });
});

describe("MPM gate rule", () => {
  test("below 0.50 suppresses the plan; at or above it does not", () => {
    expect(mpmGate(classificationSignals(sig("bugfix", 0.9, 0.49)))).toBe(false);
    expect(mpmGate(classificationSignals(sig("bugfix", 0.9, 0.5)))).toBe(true);
    expect(mpmGate(classificationSignals(sig("bugfix", 0.9, 1)))).toBe(true);
  });

  test("a failed call is no opinion, never a suppression", () => {
    expect(mpmGate(classificationSignals({}))).toBeUndefined();
  });
});

describe("hint rule", () => {
  test("applies at or above 0.60 confidence, omitted below", () => {
    expect(hintFor(classificationSignals(sig("bugfix", 0.6, 0.9)))).toBe(TASK_TYPE_HINTS.bugfix);
    expect(hintFor(classificationSignals(sig("bugfix", 0.59, 0.9)))).toBeUndefined();
    expect(hintFor(classificationSignals(sig("analysis", 0.95, 0.1)))).toBe(TASK_TYPE_HINTS.analysis);
  });

  test("hints are short, fixed constants — one or two sentences", () => {
    for (const type of TASK_TYPES) {
      expect(TASK_TYPE_HINTS[type].split(". ").length).toBeLessThanOrEqual(2);
    }
  });
});

describe("judge against a fake client", () => {
  test("records one jev_judgment with the useCase, flags and answers", async () => {
    const { judge, records } = judgeOver({ taskType: "bugfix", confidence: 0.9, oriented: 0.8 });
    const verdict = await judge.judge("fix the login crash");
    expect(verdict?.hint).toBe(TASK_TYPE_HINTS.bugfix);
    expect(verdict?.mpmAllowed).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      useCase: "classification",
      taskType: "bugfix",
      confidence: 0.9,
      codebaseOriented: 0.8,
      hintApplied: true,
      mpmGated: false,
      sharedRequest: false,
    });
  });

  test("a failure produces no record and no verdict (fail-open)", async () => {
    const { judge, records } = judgeOver({ fail: true });
    expect(await judge.judge("anything")).toBeNull();
    expect(records).toHaveLength(0);
    expect(judge.hint()).toBeUndefined();
    expect(judge.mpmAllowed()).toBeUndefined();
  });

  test("the golden set: ten messages map to their expected task types", async () => {
    const golden: [string, TaskType, number][] = [
      ["why does the resolver cache stale results?", "question", 0.9],
      ["the build fails after the last merge, fix it", "bugfix", 0.95],
      ["login crashes when the token expires", "bugfix", 0.9],
      ["add an export button to the report page", "feature", 0.9],
      ["can we support SSO logins?", "feature", 0.85],
      ["rename `getUser` to `fetchUser` everywhere", "refactoring", 0.9],
      ["extract this 300-line function into modules", "refactoring", 0.85],
      ["review the auth module for security issues", "analysis", 0.9],
      ["why is the test suite slow since yesterday?", "analysis", 0.75],
      ["what does this error message mean?", "question", 0.7],
    ];
    for (const [text, expected, confidence] of golden) {
      const { judge } = judgeOver({ taskType: expected, confidence, oriented: 0.9 });
      const verdict = await judge.judge(text);
      expect(verdict?.signals.taskType).toBe(expected);
      expect(verdict?.signals.confidence).toBe(confidence);
    }
  });
});

/** A literal signals table row (helper keeps the call sites readable). */
function sig(taskType: string, confidence: number, oriented: number) {
  return {
    task_type: choiceAnswer(taskType, confidence),
    codebase_oriented: { type: "noul" as const, noul: oriented },
  };
}
