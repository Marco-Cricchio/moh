import { describe, expect, test } from "bun:test";
import {
  SKILL_RELEVANCE_MIN,
  SKILL_SUGGEST_KEEP,
  SKILLS_RANK_MAX,
  buildRelevance,
  candidatesForRank,
  rankQuestionsFor,
  rankStateFor,
  relevanceQuestionsFor,
  relevanceStateFor,
  rosterFromIndex,
} from "../src/skills";

const ROSTER = [
  { name: "tdd", description: "Test-driven development." },
  { name: "releaser", description: "Cut a release." },
  { name: "prototype", description: "Throwaway prototype." },
];

describe("#793 skill suggestion — roster and state", () => {
  test("rosterFromIndex renders one line per skill and caps the roster", () => {
    expect(rosterFromIndex(ROSTER)).toBe(
      "- tdd: Test-driven development.\n- releaser: Cut a release.\n- prototype: Throwaway prototype.",
    );
    const many = Array.from({ length: SKILLS_RANK_MAX + 5 }, (_, i) => ({ name: `s${i}`, description: `d${i}` }));
    expect(candidatesForRank(many)).toHaveLength(SKILLS_RANK_MAX);
    expect(rosterFromIndex(candidatesForRank(many))).not.toContain(`s${SKILLS_RANK_MAX}`);
  });

  test("empty roster short-circuits: no candidates, no state", () => {
    expect(candidatesForRank([])).toHaveLength(0);
    expect(rosterFromIndex([])).toBe("");
  });

  test("state builders carry the task and the roster, truncated", () => {
    const rank = rankStateFor({ task: "fix the flaky test", roster: ROSTER });
    expect(rank).toContain("fix the flaky test");
    expect(rank).toContain("- tdd:");
    const rel = relevanceStateFor({ task: "fix the flaky test", roster: [ROSTER[0]!] });
    expect(rel).toContain("tdd");
    expect(rel.length).toBeLessThan(rank.length);
  });
});

describe("#793 skill suggestion — calls and verdict", () => {
  test("call 1: one noul per skill over the rank state", () => {
    const qs = rankQuestionsFor(ROSTER);
    expect(Object.keys(qs).sort()).toEqual(["needs_skill", "skill:prototype", "skill:releaser", "skill:tdd"]);
    for (const q of Object.values(qs)) expect(q.type).toBe("noul");
  });

  test("call 1: does_not_need keeps only confident skills, ranked strongest-first", () => {
    expect(SKILL_RELEVANCE_MIN).toBe(0.6);
    expect(SKILL_SUGGEST_KEEP).toBe(3);
    expect(rankQuestionsFor(ROSTER)).toBeTruthy();
  });

  test("call 2: relevanceQuestionsFor asks one noul per finalist", () => {
    const qs = relevanceQuestionsFor(["tdd", "releaser"]);
    expect(Object.keys(qs).sort()).toEqual(["relevance:releaser", "relevance:tdd"]);
    expect(qs["relevance:tdd"]?.type).toBe("noul");
  });

  test("buildRelevance: a clear winner becomes the prompt line; none above the floor → no suggestion", () => {
    const line = buildRelevance([
      { name: "tdd", probability: 0.91 },
      { name: "releaser", probability: 0.4 },
    ]);
    expect(line).toBe("This request looks like a fit for the `tdd` skill — load its SKILL.md before acting.");
    expect(buildRelevance([{ name: "tdd", probability: 0.59 }])).toBeUndefined();
    expect(buildRelevance([])).toBeUndefined();
    // Two above the floor: strongest wins, never two suggestions.
    const two = buildRelevance([
      { name: "releaser", probability: 0.8 },
      { name: "tdd", probability: 0.95 },
    ]);
    expect(two).toContain("`tdd`");
  });

  test("buildRelevance accepts a score-shaped answer too (call-2 confidence)", () => {
    const line = buildRelevance([{ name: "tdd", probability: 0.7 }], 0.9);
    expect(line).toContain("`tdd`");
  });
});
