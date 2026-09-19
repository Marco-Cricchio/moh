/**
 * #793 Jev skill suggestion: the two-call cookbook judge against a fake
 * client (no network in CI). The contract: call 1 ranks the whole roster
 * plus the `needs_skill` gate, call 2 re-reads at most the top 3 finalists;
 * at most ONE suggestion leaves the judge, every failure degrades to
 * no suggestion, and both calls leave one `jev_skill_suggest` record each.
 */
import { describe, expect, test } from "bun:test";
import { createSkillSuggestJudge } from "../src/skill-judge";
import { NEEDS_SKILL_MIN, SKILL_RELEVANCE_MIN, SKILL_SUGGEST_KEEP } from "../src/skills";
import type { JevAnswer, JevClient, JevJudgeInput, JevOutcome } from "../src/client";

function noul(p: number): JevAnswer {
  return { type: "noul", noul: p };
}

const ROSTER = [
  { name: "tdd", description: "Test-driven development." },
  { name: "releaser", description: "Cut a release." },
  { name: "prototype", description: "Throwaway prototype." },
  { name: "triage", description: "Move issues through triage." },
];

/** Scripted per-call answer maps keyed by question id; a `{ fail: true }` entry fails that call. */
function fake(scripted: (Record<string, number> | { fail: true })[]): JevClient & { calls: JevJudgeInput[] } {
  const calls: JevJudgeInput[] = [];
  let i = 0;
  return {
    calls,
    async judge(input: JevJudgeInput): Promise<JevOutcome> {
      calls.push(input);
      const script = scripted[i++];
      if (script && "fail" in script) return { ok: false, kind: "timeout", message: "boom" };
      const map = script ?? {};
      const answers: Record<string, JevAnswer> = {};
      for (const id of Object.keys(input.questions)) {
        answers[id] = noul(map[id] ?? 0);
      }
      const meta = { model: "jev-latest", latencyMs: 10, usage: { inputTokens: 80, outputTokens: 8 } };
      input.record(answers, meta);
      return { ok: true, answers, ...meta };
    },
  };
}

function makeJudge(scripted: (Record<string, number> | { fail: true })[]) {
  const records: Record<string, unknown>[] = [];
  const client = fake(scripted);
  const judge = createSkillSuggestJudge({ client, append: (p) => records.push(p) });
  return { judge, client, records };
}

describe("skill suggestion judge (#793)", () => {
  test("constants match the ratified shape", () => {
    expect(NEEDS_SKILL_MIN).toBe(0.6);
    expect(SKILL_SUGGEST_KEEP).toBe(3);
    expect(SKILL_RELEVANCE_MIN).toBe(0.6);
  });

  test("two calls, one suggestion, two records", async () => {
    const { judge, client, records } = makeJudge([
      { needs_skill: 0.9, "skill:tdd": 0.8, "skill:releaser": 0.5 },
      { "relevance:tdd": 0.9 },
    ]);
    const verdict = await judge.suggest("write tests first", ROSTER);
    expect(client.calls).toHaveLength(2);
    expect(verdict?.skill).toBe("tdd");
    expect(verdict?.line).toContain("`tdd`");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ useCase: "skill_suggest", call: "rank", needsSkill: 0.9, gated: false });
    expect((records[0] as any).top[0]).toEqual({ name: "tdd", probability: 0.8 });
    expect(records[1]).toMatchObject({ useCase: "skill_suggest", call: "relevance", suggested: "tdd" });
  });

  test("needs_skill below the floor short-circuits: one call, no suggestion, record says gated", async () => {
    const { judge, client, records } = makeJudge([{ needs_skill: 0.4, "skill:tdd": 0.99 }]);
    const verdict = await judge.suggest("hello", ROSTER);
    expect(verdict).toBeNull();
    expect(client.calls).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ call: "rank", gated: true });
  });

  test("call 2 washout (no finalist clears the floor) → no suggestion, honest record", async () => {
    const { judge, client, records } = makeJudge([
      { needs_skill: 0.9, "skill:tdd": 0.8 },
      { "relevance:tdd": 0.3 },
    ]);
    const verdict = await judge.suggest("write tests", ROSTER);
    expect(verdict).toBeNull();
    expect(client.calls).toHaveLength(2);
    expect(records[1]).toMatchObject({ call: "relevance", ok: false, kind: "no-winner" });
  });

  test("rank call failure → one record, no suggestion", async () => {
    const { judge, client, records } = makeJudge([{ fail: true }]);
    expect(await judge.suggest("write tests", ROSTER)).toBeNull();
    expect(client.calls).toHaveLength(1);
    expect(records[0]).toMatchObject({ call: "rank", ok: false, kind: "timeout" });
  });

  test("relevance call failure → two records, no suggestion", async () => {
    const { judge, records } = makeJudge([{ needs_skill: 0.9, "skill:tdd": 0.8 }, { fail: true }]);
    expect(await judge.suggest("write tests", ROSTER)).toBeNull();
    expect(records[1]).toMatchObject({ call: "relevance", ok: false, kind: "timeout" });
  });

  test("empty roster: no call at all", async () => {
    const { judge, client } = makeJudge([]);
    expect(await judge.suggest("write tests", [])).toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  test("roster is capped at the rank max; finalists capped at keep", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `s${i}`, description: `d${i}` }));
    const script: Record<string, number> = { needs_skill: 0.9 };
    for (let i = 0; i < 30; i++) script[`skill:s${i}`] = 0.9 - i / 100;
    const { judge, client } = makeJudge([script, {}]);
    await judge.suggest("task", many);
    const rank = client.calls[0]!;
    expect(Object.keys(rank.questions)).toHaveLength(31); // 30 skills + needs_skill
    expect(rank.state).not.toContain("s30");
    // Call 2 re-reads only the top keep.
    expect(Object.keys(client.calls[1]!.questions)).toHaveLength(SKILL_SUGGEST_KEEP);
  });

  test("two finalists above the floor: strongest wins, one line", async () => {
    const { judge } = makeJudge([
      { needs_skill: 0.9, "skill:tdd": 0.85, "skill:releaser": 0.8 },
      { "relevance:tdd": 0.7, "relevance:releaser": 0.65 },
    ]);
    const verdict = await judge.suggest("task", ROSTER);
    expect(verdict?.skill).toBe("tdd");
  });
});
