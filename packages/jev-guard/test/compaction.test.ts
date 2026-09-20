/**
 * #792 compaction cut guide: the judge against a fake client (no
 * network). High droppable probability → drop, low → keep, a failed call
 * → keep (fail-open), one per-section record plus one aggregate record,
 * and the judged state is the preview only — never a full body.
 */
import { describe, expect, test } from "bun:test";
import {
  COMPACTION_CUT_THRESHOLDS,
  createCompactionJudge,
  type JudgedSection,
} from "../src/index";
import type { JevAnswer, JevClient, JevJudgeInput, JevOutcome } from "../src/client";

function fake(droppable: number | { fail: true }): JevClient & { states: unknown[] } {
  const states: unknown[] = [];
  return {
    states,
    async judge(input: JevJudgeInput): Promise<JevOutcome> {
      states.push(input.state);
      if (typeof droppable !== "number") return { ok: false, kind: "timeout", message: "boom" };
      const payload: Record<string, JevAnswer> = {
        droppable: { type: "noul", noul: droppable },
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
  test("the threshold is the ratified DROP_MIN", () => {
    expect(COMPACTION_CUT_THRESHOLDS.DROP_MIN).toBe(0.7);
  });

  test("sections above DROP_MIN drop, the rest keep", async () => {
    const high = judgeOver(0.95);
    const verdict = await high.judge.judge(SECTIONS);
    expect(verdict.drop).toEqual(["s0", "s1"]);
    const low = judgeOver(0.1);
    expect((await low.judge.judge(SECTIONS)).drop).toEqual([]);
  });

  test("a failed call keeps its section and records nothing (fail-open)", async () => {
    const { judge, records } = judgeOver({ fail: true });
    expect((await judge.judge(SECTIONS)).drop).toEqual([]);
    expect(records).toEqual([]);
  });

  test("one per-section record, then one aggregate record with sizes", async () => {
    const { judge, records } = judgeOver(0.95);
    const verdict = await judge.judge(SECTIONS);
    expect((verdict.summary as { bytesBefore: number }).bytesBefore).toBe(4500);
    expect((verdict.summary as { bytesAfter: number }).bytesAfter).toBe(0);
    for (const record of [...records, verdict.summary]) {
      expect((record as { useCase: string }).useCase).toBe("compact-cut");
    }
    const aggregate = records.filter((r) => (r as { kind?: string }).kind === "compaction");
    expect(aggregate.length).toBe(0); // the aggregate is appended by the hook, post-floor
  });

  test("the judged state is the preview, never a full body", async () => {
    const { judge, client } = judgeOver(0.95);
    await judge.judge([{ id: "s0", kind: "tool_result", bytes: 900_000, preview: "short preview" }]);
    expect((client.states[0] as string).includes("short preview")).toBe(true);
    expect((client.states[0] as string).length).toBeLessThan(300);
  });
});
