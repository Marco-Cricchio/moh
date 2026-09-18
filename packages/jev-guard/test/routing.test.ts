/**
 * #787: the routing tier assignment and the decision table — pure logic.
 * Labels beat the price heuristic; unknown prices stay routable as
 * `bilanciato`; a move needs confidence ≥ 0.60 and two consecutive turns.
 */
import { describe, expect, test } from "bun:test";
import {
  ROUTING_CONFIDENCE_MIN,
  ROUTING_MESSAGE_MAX_BYTES,
  ROUTING_STREAK_REQUIRED,
  assignTiers,
  decideRouting,
  nextStreak,
  routableTierCount,
  routingQuestions,
  tierOfModel,
  truncateToBytes,
  type RoutingModel,
} from "../src/routing";

const pool: RoutingModel[] = [
  { ref: "a/big", price: 100 },
  { ref: "a/cheap", price: 1 },
  { ref: "a/mid", price: 10 },
];

describe("tier assignment (#787)", () => {
  test("an explicit label wins over the price heuristic", () => {
    const assignment = assignTiers(pool, { "a/cheap": "potente", "a/big": "economico" });

    expect(assignment.targets.economico).toBe("a/big");
    expect(assignment.targets.potente).toBe("a/cheap");
    expect(assignment.members.potente).toEqual(["a/cheap"]);
    expect(assignment.ignoredLabels).toEqual([]);
  });

  test("the unlabeled pool is ranked by blended price and split into terciles", () => {
    const assignment = assignTiers(pool);

    expect(assignment.targets).toEqual({ economico: "a/cheap", bilanciato: "a/mid", potente: "a/big" });
    expect(assignment.unpriced).toEqual([]);
  });

  test("a two-model pool splits cheapest and dearest", () => {
    const assignment = assignTiers([
      { ref: "a/pricier", price: 50 },
      { ref: "a/cheaper", price: 5 },
    ]);

    expect(assignment.targets).toEqual({ economico: "a/cheaper", potente: "a/pricier" });
    expect(assignment.targets.bilanciato).toBeUndefined();
    expect(routableTierCount(assignment)).toBe(2);
  });

  test("an unknown price falls back to bilanciato — routable, never guessed", () => {
    const assignment = assignTiers([
      { ref: "a/priced-low", price: 1 },
      { ref: "a/priced-high", price: 90 },
      { ref: "a/mystery" },
      { ref: "a/mystery-2" },
    ]);

    expect(assignment.members.bilanciato).toEqual(["a/mystery", "a/mystery-2"]);
    expect(assignment.unpriced).toEqual(["a/mystery", "a/mystery-2"]);
    expect(assignment.targets.economico).toBe("a/priced-low");
    expect(assignment.targets.potente).toBe("a/priced-high");
  });

  test("a label naming a model outside the pool is ignored and reported", () => {
    const assignment = assignTiers(pool, { "b/nope": "potente", "a/mid": "potente" });

    expect(assignment.ignoredLabels).toEqual(["b/nope"]);
    // Labeled first, then the heuristic's own picks for that tier.
    expect(assignment.members.potente).toEqual(["a/mid", "a/big"]);
    // The ignored label does not remove anything from the heuristic: the
    // two remaining models split cheapest/dearest.
    expect(assignment.members.economico).toEqual(["a/cheap"]);
    expect(assignment.members.bilanciato).toEqual([]);
  });

  test("a single reachable tier is inert; tierOfModel finds the serving tier", () => {
    const assignment = assignTiers([{ ref: "a/only", price: 3 }]);

    expect(routableTierCount(assignment)).toBe(1);
    expect(tierOfModel(assignment, "a/only")).toBe("bilanciato");
    expect(tierOfModel(assignment, "a/elsewhere")).toBeUndefined();
  });
});

describe("the decision table (#787)", () => {
  const base = { tier: "potente", currentTier: "economico", streak: 2, paused: false, override: false } as const;

  test("confidence boundaries: 0.59 stays, 0.60 may switch", () => {
    expect(decideRouting({ ...base, confidence: 0.59 })).toEqual({ switch: false, reason: "low-confidence" });
    expect(decideRouting({ ...base, confidence: 0.6 })).toEqual({ switch: true, reason: "hysteresis" });
    expect(ROUTING_CONFIDENCE_MIN).toBe(0.6);
  });

  test("streak boundaries: one turn stays, two switch", () => {
    expect(decideRouting({ ...base, confidence: 0.9, streak: 1 })).toEqual({ switch: false, reason: "streak" });
    expect(decideRouting({ ...base, confidence: 0.9, streak: 2 })).toEqual({ switch: true, reason: "hysteresis" });
    expect(ROUTING_STREAK_REQUIRED).toBe(2);
  });

  test("already being on the target tier stays", () => {
    expect(decideRouting({ ...base, confidence: 0.95, currentTier: "potente" })).toEqual({
      switch: false,
      reason: "same-tier",
    });
  });

  test("a manual override wins over everything, and a pause stays", () => {
    expect(decideRouting({ ...base, confidence: 1, override: true })).toEqual({ switch: false, reason: "override" });
    expect(decideRouting({ ...base, confidence: 1, paused: true })).toEqual({ switch: false, reason: "paused" });
    expect(decideRouting({ ...base, confidence: 0.1, override: true })).toEqual({ switch: false, reason: "override" });
  });

  test("an unpriced model outside the pool can still be the target", () => {
    // currentTier undefined = the serving model is not in the pool: no
    // "same tier" shortcut, the table decides on confidence and streak.
    expect(decideRouting({ tier: "potente", confidence: 0.9, streak: 2, paused: false, override: false })).toEqual({
      switch: true,
      reason: "hysteresis",
    });
  });

  test("the streak counts consecutive turns naming the same tier", () => {
    expect(nextStreak(null, 0, "potente")).toBe(1);
    expect(nextStreak("potente", 1, "potente")).toBe(2);
    expect(nextStreak("potente", 2, "economico")).toBe(1);
    expect(nextStreak("potente", 5, "potente")).toBe(6);
  });
});

describe("the classifier's input (#787)", () => {
  test("the message is truncated to 2 KiB without splitting a character", () => {
    expect(ROUTING_MESSAGE_MAX_BYTES).toBe(2048);
    expect(truncateToBytes("short")).toBe("short");
    const long = "a".repeat(3000);
    expect(truncateToBytes(long)).toHaveLength(2048);
    const multi = "è".repeat(3000); // 2 bytes each
    const cut = truncateToBytes(multi);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(2048);
    expect(cut).toBe("è".repeat(1024));
    expect(cut).not.toContain("\uFFFD");
  });

  test("the questions carry the reachable tiers with their model names", () => {
    const assignment = assignTiers([
      { ref: "a/cheap", price: 1 },
      { ref: "a/big", price: 100 },
    ]);
    const questions = routingQuestions(assignment);

    expect(Object.keys(questions)).toEqual(["difficulty", "needs_context"]);
    const difficulty = questions.difficulty;
    expect(difficulty.type).toBe("choice");
    if (difficulty.type !== "choice") throw new Error("expected a choice question");
    // Only the tiers the pool can actually reach are offered.
    expect(Object.keys(difficulty.criteria)).toEqual(["economico", "potente"]);
    expect(difficulty.criteria.economico).toContain("a/cheap");
    expect(difficulty.criteria.potente).toContain("a/big");
    // The tuning question is a yes/no, never a routing signal.
    expect(questions.needs_context.type).toBe("noul");
  });
});
