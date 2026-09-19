/**
 * #792 compaction cut guide: the judge against a fake client (no
 * network). Low unrecoverable probability → drop, high → keep, a failed
 * call → keep (fail-open), one record per section either way, and the
 * judged state is the preview only — never a full body.
 */
import { describe, expect, test } from "bun:test";
import {
  COMPACTION_CUT_THRESHOLDS,
  createCompactionJudge,
  type JudgedSection,
} from "../src/index";
import type { JevAnswer, JevClient, JevJudgeInput, JevOutcome } from "../src/client";

function fake(unrecoverable: number | { fail: true }): JevClient & { states: unknown[] } {
  const states: unknown[] = [];
  return {
    states,
    async judge(input: JevJudgeInput): Promise<JevOutcome> {
      states.push(input.state);
      if (typeof unrecoverable !== "number") return { ok: false, kind: "timeout", message: "boom" };
      const payload: Record<string, JevAnswer> = {
        unrecoverable: { type: "noul", noul: unrecoverable },
      };
      input.record(payload, { model: "jev-latest", latencyMs: 10, usage: { inputTokens: 40, outputTokens: 4 } });
      return { ok: true, answers: payload, model: "jev-latest", latencyMs: 10, usage: { inputTokens: 40, outputTokens: 4 } };
    },
  };
}

const SECTIONS: JudgedSection[] = [
  { id: "s0", kind: "tool_result", bytes: 4200, preview: "tool bash: bun test…" },
  { id: "s1", kind: "assistant", bytes: 300, preview: "assistant: I will refactor the parser now." },
];

function judgeOver(p: number | { fail: true }) {
  const records: Record<string, unknown>[] = [];
  const client = fake(p);
  const judge = createCompactionJudge({ client, append: (payload) => records.push(payload) });
  return { judge, records, client };
}

describe("compaction cut judge (#792)", () => {
  test("the threshold is strict: drop only strictly below", () => {
    expect(COMPACTION_CUT_THRESHOLDS.dropBelow).toBe(0.4);
  });

  test("low unrecoverable sections drop, high ones keep", async () => {
    const low = judgeOver(0.05);
    expect(await low.judge.judge(SECTIONS)).toEqual({ drop: ["s0", "s1"] });
    const high = judgeOver(0.9);
    expect(await high.judge.judge(SECTIONS)).toEqual({ drop: [] });
  });

  test("a failed call keeps its section and records nothing (fail-open)", async () => {
    const { judge, records } = judgeOver({ fail: true });
    expect(await judge.judge(SECTIONS)).toEqual({ drop: [] });
    expect(records).toEqual([]);
  });

  test("one record per judged section — drops and keeps alike", async () => {
    const { judge, records } = judgeOver(0.05);
    await judge.judge(SECTIONS);
    expect(records.length).toBe(SECTIONS.length);
    expect((records[0] as { useCase: string }).useCase).toBe("compaction-cut");
    expect((records[0] as { decision: string }).decision).toBe("drop");
    expect((records[1] as { decision: string }).decision).toBe("drop");
  });

  test("the judged state is the preview, never a full body", async () => {
    const { judge, client } = judgeOver(0.05);
    await judge.judge([{ id: "s0", kind: "tool_result", bytes: 900_000, preview: "short preview" }]);
    expect((client.states[0] as string).includes("short preview")).toBe(true);
    expect((client.states[0] as string).length).toBeLessThan(300);
  });
});
