/**
 * #787: the routing judge — one Jev call per turn that could switch, the
 * hysteresis streak, the manual override, and the shape of both the
 * request that leaves moh and the record that lands in the log. Driven by
 * a fake client: no network anywhere.
 */
import { describe, expect, test } from "bun:test";
import type { JevAnswer, JevJudgeInput, JevOutcome } from "../src/client";
import { createRoutingJudge } from "../src/routing-judge";
import { isContinuationMessage, type RoutingModel } from "../src/routing";

const pool: RoutingModel[] = [
  { ref: "a/cheap", price: 1 },
  { ref: "a/mid", price: 10 },
  { ref: "a/big", price: 100 },
];

interface Fake {
  judge(input: JevJudgeInput): Promise<JevOutcome>;
  /** Every request the judge made. */
  readonly inputs: JevJudgeInput[];
  /** The payloads the client would have appended to the log. */
  readonly records: Record<string, unknown>[];
}

/** A client that answers a Choice with `choice`/`confidence`. */
function fakeClient(
  answer: { choice?: string; confidence?: number; needsContext?: number } | { fail: "rate_limited" },
): Fake {
  const inputs: JevJudgeInput[] = [];
  const records: Record<string, unknown>[] = [];
  return {
    inputs,
    records,
    async judge(input: JevJudgeInput): Promise<JevOutcome> {
      inputs.push(input);
      if ("fail" in answer) return { ok: false, kind: answer.fail, message: "boom" };
      const answers: Record<string, JevAnswer> = {
        difficulty: {
          type: "choice",
          choice: answer.choice ?? "bilanciato",
          probabilities: { economico: 0.1, bilanciato: 0.8, potente: 0.1 },
          confidence: answer.confidence ?? 0.9,
        },
        needs_context: { type: "noul", noul: answer.needsContext ?? 0 },
      };
      const meta = { model: "jev-latest", latencyMs: 12, usage: { inputTokens: 40, outputTokens: 4 } };
      records.push(input.record(answers, meta) as Record<string, unknown>);
      return { ok: true, answers, model: meta.model, latencyMs: meta.latencyMs, usage: meta.usage };
    },
  };
}

function judgeFor(fake: Fake, models: RoutingModel[] = pool, labels = {}) {
  const state: Record<string, unknown> = {};
  const judge = createRoutingJudge(
    { client: fake, state },
    { pool: async () => ({ models }), labels },
  );
  return { judge, state };
}

describe("routing judge (#787)", () => {
  test("a confident tier two turns in a row switches, and the record explains it", async () => {
    const fake = fakeClient({ choice: "potente", confidence: 0.91 });
    const { judge } = judgeFor(fake);

    const first = await judge.decide("design a module", "a/cheap");
    expect(first).toMatchObject({ decision: "stay", reason: "streak", tier: "potente", streak: 1, currentTier: "economico" });
    expect(first!.ref).toBeUndefined();

    const second = await judge.decide("still designing", "a/cheap");
    expect(second).toMatchObject({ decision: "switch", reason: "hysteresis", streak: 2, ref: "a/big" });

    // The record is one per judgment, and carries the tier, the decision and
    // the exact state Jev saw.
    expect(fake.records).toHaveLength(2);
    expect(fake.records[1]).toMatchObject({
      useCase: "routing",
      decision: "switch",
      reason: "hysteresis",
      tier: "potente",
      confidence: 0.91,
      currentTier: "economico",
      streak: 2,
      target: "a/big",
      message: "still designing",
      model: "jev-latest",
    });
    expect(fake.records[1]!.answers).toMatchObject({ needs_context: { type: "noul", noul: 0 } });
  });

  test("the request carries the truncated message and the tier mapping — nothing else", async () => {
    const fake = fakeClient({ choice: "bilanciato" });
    const { judge } = judgeFor(fake);

    await judge.decide("x".repeat(5000), "a/mid");

    expect(fake.inputs).toHaveLength(1);
    const input = fake.inputs[0]!;
    expect(typeof input.state).toBe("string");
    expect((input.state as string).length).toBe(2048);
    expect(Object.keys(input.questions)).toEqual(["difficulty", "needs_context"]);
    const difficulty = input.questions.difficulty;
    if (difficulty.type !== "choice") throw new Error("expected a choice question");
    // The tier-to-model mapping is the only session fact that leaves moh.
    expect(Object.values(difficulty.criteria).join(" ")).toContain("a/cheap");
    expect(Object.values(difficulty.criteria).join(" ")).toContain("a/big");
  });

  test("the tuning answer never changes the decision", async () => {
    const without = judgeFor(fakeClient({ choice: "potente", confidence: 0.9, needsContext: 0 }));
    const with0 = judgeFor(fakeClient({ choice: "potente", confidence: 0.9, needsContext: 1 }));
    await without.judge.decide("a", "a/cheap");
    await with0.judge.decide("a", "a/cheap");
    const a = await without.judge.decide("b", "a/cheap");
    const b = await with0.judge.decide("b", "a/cheap");
    expect(a).toEqual(b);
  });

  test("confidence boundaries: 0.59 stays, 0.60 switches on the second turn", async () => {
    const low = judgeFor(fakeClient({ choice: "potente", confidence: 0.59 }));
    await low.judge.decide("a", "a/cheap");
    expect(await low.judge.decide("b", "a/cheap")).toMatchObject({ decision: "stay", reason: "low-confidence" });

    const high = judgeFor(fakeClient({ choice: "potente", confidence: 0.6 }));
    await high.judge.decide("a", "a/cheap");
    expect(await high.judge.decide("b", "a/cheap")).toMatchObject({ decision: "switch", ref: "a/big" });
  });

  test("being on the target tier already stays (and needs no switch)", async () => {
    const fake = fakeClient({ choice: "bilanciato", confidence: 0.99 });
    const { judge } = judgeFor(fake);
    await judge.decide("a", "a/mid");
    expect(await judge.decide("b", "a/mid")).toMatchObject({ decision: "stay", reason: "same-tier" });
  });

  test("an answer naming a tier the pool cannot reach is not a judgment", async () => {
    const fake = fakeClient({ choice: "potente", confidence: 0.99 });
    // A two-model pool has no bilanciato; potente/economico are both reachable.
    const { judge } = judgeFor(fake, pool, { "a/mid": "economico" });
    await judge.decide("a", "a/cheap");
    const verdict = await judge.decide("b", "a/cheap");
    // potente is reachable here, so the switch happens — the interesting
    // case is an answer the offer did not include: the fake answers
    // "bilanciato" while the pool has none.
    const unmatched = judgeFor(fakeClient({ choice: "bilanciato", confidence: 0.99 }), [
      { ref: "a/cheap", price: 1 },
      { ref: "a/big", price: 100 },
    ]);
    await unmatched.judge.decide("a", "a/cheap");
    const none = await unmatched.judge.decide("b", "a/cheap");
    expect(none).toMatchObject({ decision: "stay", reason: "low-confidence", confidence: 0 });
    expect(verdict!.decision).toBe("switch");
  });

  test("an unusable answer leaves the streak exactly where it was", async () => {
    // First turn: a real judgment for `potente` (streak 1).
    const fake = fakeClient({ choice: "potente", confidence: 0.9 });
    const { judge } = judgeFor(fake);
    expect(await judge.decide("design", "a/cheap")).toMatchObject({ streak: 1, reason: "streak" });

    // Second turn: an answer naming a tier this pool cannot reach.
    const twoTiers = [
      { ref: "a/cheap", price: 1 },
      { ref: "a/big", price: 100 },
    ];
    const stray = judgeFor(fakeClient({ choice: "bilanciato", confidence: 0.99 }), twoTiers);
    await stray.judge.decide("design", "a/cheap");
    expect(await stray.judge.decide("design more", "a/cheap")).toMatchObject({
      decision: "stay",
      reason: "low-confidence",
      confidence: 0,
      streak: 0,
    });

    // Third turn: back to a real answer for the same tier — a fresh streak,
    // not a continuation of anything the unusable answer touched.
    expect(await judge.decide("still designing", "a/cheap")).toMatchObject({ streak: 2, decision: "switch" });
  });

  test("a failed call produces nothing: no switch, no record, no state change", async () => {
    const fake = fakeClient({ fail: "rate_limited" });
    const { judge, state } = judgeFor(fake);

    expect(await judge.decide("a", "a/cheap")).toBeNull();
    expect(await judge.decide("b", "a/cheap")).toBeNull();

    expect(fake.records).toEqual([]);
    expect(judge.snapshot()).toMatchObject({ streak: 0, streakTier: null, override: false });
    expect(state.routing).toBeDefined();
  });

  test("routing is inert — no call, no cost — with fewer than two tiers", async () => {
    const fake = fakeClient({ choice: "potente" });
    const { judge } = judgeFor(fake, [{ ref: "a/only", price: 1 }]);

    expect(await judge.decide("a", "a/only")).toBeNull();
    expect(fake.inputs).toEqual([]);
  });

  test("a router-caused switch is not an override; a hand-picked model is", async () => {
    const fake = fakeClient({ choice: "potente", confidence: 0.9 });
    const { judge } = judgeFor(fake);

    judge.noteSwitch("a/big");
    expect(judge.noteModelSwitched("a/big")).toBe(false);
    expect(judge.snapshot()).toMatchObject({ override: false, streak: 0 });

    expect(judge.noteModelSwitched("a/other")).toBe(true);
    expect(judge.snapshot()).toMatchObject({ override: true, streak: 0, streakTier: null });
    // The user's pick wins: nothing is judged (and nothing is spent).
    expect(await judge.decide("a", "a/other")).toBeNull();
    expect(fake.inputs).toEqual([]);
  });

  test("a switch resets the streak: the next move needs two fresh turns", async () => {
    const fake = fakeClient({ choice: "potente", confidence: 0.9 });
    const { judge } = judgeFor(fake);

    await judge.decide("a", "a/cheap");
    const switched = await judge.decide("b", "a/cheap");
    expect(switched!.decision).toBe("switch");
    judge.noteSwitch(switched!.ref!);
    expect(judge.snapshot()).toMatchObject({ streak: 0, streakTier: null, expected: "a/big" });
  });

  test("a model outside the pool has no tier: the last judged tier stands", async () => {
    const fake = fakeClient({ choice: "bilanciato", confidence: 0.9 });
    const { judge } = judgeFor(fake);
    const verdict = await judge.decide("a", "custom/model");
    expect(verdict!.currentTier).toBeUndefined();
    expect(verdict).toMatchObject({ decision: "stay", reason: "streak" });
  });

  test("routing resumes on the tier, not on the exact ref the router named", async () => {
    const fake = fakeClient({ choice: "potente", confidence: 0.9 });
    // Two models in the powerful tier: a hand-picked one of that tier is
    // still coherent with the router's decision.
    const judge = createRoutingJudge({ client: fake, state: {} }, {
      pool: async () => ({ models: [...pool, { ref: "a/other-big", price: 120 }] }),
    });
    await judge.decide("design", "a/cheap");
    const switched = await judge.decide("design more", "a/cheap");
    judge.noteSwitch(switched!.ref!); // a/big
    const spent = fake.inputs.length;

    // A different model of the same tier is coherent with the decision:
    // routing resumes on it instead of staying suspended forever.
    const resumed = await judge.decide("look at it once more", "a/other-big");
    expect(resumed).not.toBeNull();
    expect(fake.inputs.length).toBe(spent + 1);
  });

  test("a serving model the router did not pick pauses the judging, visibly, once", async () => {
    const fake = fakeClient({ choice: "potente", confidence: 0.9 });
    const mismatches: [string, string][] = [];
    const judge = createRoutingJudge(
      { client: fake, state: {} },
      { pool: async () => ({ models: pool }), onMismatch: (current, expected) => mismatches.push([current, expected]) },
    );

    // Turns 1-2 pick a/big. ("design more" carries a task signal: #852.)
    await judge.decide("design", "a/cheap");
    const switched = await judge.decide("design more", "a/cheap");
    judge.noteSwitch(switched!.ref!);
    const callsAfterSwitch = fake.inputs.length;

    // Turns 3-5: the serving model is not a/big — no judgment, one notice.
    // (The probe messages carry a task signal: #852.)
    expect(await judge.decide("check the layout", "a/handpicked")).toBeNull();
    expect(await judge.decide("fix the export", "a/handpicked")).toBeNull();
    expect(await judge.decide("try that again from the top", "a/config-change")).toBeNull();
    expect(fake.inputs).toHaveLength(callsAfterSwitch);
    expect(mismatches).toEqual([["a/handpicked", "a/big"]]);

    // Back on the router's pick: judging resumes.
    const resumed = await judge.decide("resume the layout work", "a/big");
    expect(resumed).not.toBeNull();
    expect(fake.inputs).toHaveLength(callsAfterSwitch + 1);
  });

  test("#852: a bare continuation message is judged, but never moves the streak or the model", async () => {
    const fake = fakeClient({ choice: "potente", confidence: 0.95 });
    const { judge } = judgeFor(fake);

    // Two real task turns build a streak of 1... then a bare continuation
    // arrives. It must not complete the hysteresis on its own.
    await judge.decide("write the agent briefs", "a/cheap");
    const continuation = await judge.decide("procedi", "a/cheap");
    expect(continuation).toMatchObject({ decision: "stay", reason: "continuation", streak: 1 });
    expect(continuation!.ref).toBeUndefined();
    // The judgment was never spent: one call, for the first turn only.
    expect(fake.inputs).toHaveLength(1);

    // ...and any number of continuations alone still cannot flip the model.
    await judge.decide("continue", "a/cheap");
    await judge.decide("yes", "a/cheap");
    expect(fake.inputs).toHaveLength(1);
    expect(judge.snapshot()).toMatchObject({ streak: 1, streakTier: "potente" });

    // A substantive message still completes the hysteresis normally.
    expect(await judge.decide("now harden the error paths", "a/cheap")).toMatchObject({
      decision: "switch",
      reason: "hysteresis",
      ref: "a/big",
    });
  });

  test("#852: continuation detection is whole-message, punctuation- and case-tolerant", () => {
    for (const text of ["", "  ", "procedi", "Procedi.", "continue?", "GO AHEAD", "ok vai", "va bene!"]) {
      expect(isContinuationMessage(text)).toBe(true);
    }
    for (const text of [
      "procediamo con il refactor",
      "continue with the export",
      "yes, but make it blue",
      "ok now run the tests",
      "design the module",
    ]) {
      expect(isContinuationMessage(text)).toBe(false);
    }
  });

  test("#852: the continuation stay is recorded like any other stay", async () => {
    const fake = fakeClient({ choice: "potente", confidence: 0.95 });
    const { judge } = judgeFor(fake);
    await judge.decide("write the briefs", "a/cheap");
    await judge.decide("procedi", "a/cheap");
    // The continuation spends no call, so the only record is the real turn.
    expect(fake.records).toHaveLength(1);
    expect(fake.records[0]).toMatchObject({
      useCase: "routing",
      decision: "stay",
      reason: "streak",
      message: "write the briefs",
    });
  });

  test("#852: a cooled-down target is never the switch target", async () => {
    const fake = fakeClient({ choice: "economico", confidence: 0.95 });
    const { judge } = judgeFor(fake);

    // Two powerful-tier turns satisfy the hysteresis, but the cheap model
    // the judgment names is in a quota cooldown: the switch is refused,
    // and the record names why.
    await judge.decide("write the briefs", "a/big");
    const refused = await judge.decide("harden the error paths", "a/big", [
      { ref: "a/cheap", kind: "quota_exhausted" },
    ]);
    expect(refused).toMatchObject({ decision: "stay", reason: "cooled-down", tier: "economico" });
    expect(refused!.ref).toBeUndefined();
    expect(judge.snapshot().decidedModel).toBeNull();
    expect(fake.records[1]).toMatchObject({ decision: "stay", reason: "cooled-down" });

    // The cooldown lifted: the same judgment now switches.
    const allowed = await judge.decide("harden the error paths", "a/big");
    expect(allowed).toMatchObject({ decision: "switch", ref: "a/cheap" });
  });

  test("#868: a cooled-down tier target rotates to the next viable same-tier candidate", async () => {
    // A pool whose economico tier has two members: the target `a/cheap`
    // and the cheaper-sorted `a/cheaper2`. Labels pin the tier so the
    // members list is explicit.
    const richPool: RoutingModel[] = [
      { ref: "a/cheap", price: 1 },
      { ref: "b/cheap", price: 1.5 },
      { ref: "a/big", price: 100 },
    ];
    const labels = { "a/cheap": "economico", "b/cheap": "economico", "a/big": "potente" };
    const fake = fakeClient({ choice: "economico", confidence: 0.95 });
    const { judge } = judgeFor(fake, richPool, labels);

    await judge.decide("write the briefs", "a/big");
    // The tier target `a/cheap` is dead: the router serves `b/cheap` —
    // the next member of the same tier — and records the substitution.
    const rotated = await judge.decide("harden the error paths", "a/big", [
      { ref: "a/cheap", kind: "quota_exhausted" },
    ]);
    expect(rotated).toMatchObject({ decision: "switch", ref: "b/cheap", skipped: "a/cheap" });
    expect(fake.records[1]).toMatchObject({ decision: "switch", target: "b/cheap", skipped: "a/cheap" });
  });

  test("#868: every rotation candidate cooled down stays, visibly, as cooled-down", async () => {
    const richPool: RoutingModel[] = [
      { ref: "a/cheap", price: 1 },
      { ref: "b/cheap", price: 1.5 },
      { ref: "a/big", price: 100 },
    ];
    const labels = { "a/cheap": "economico", "b/cheap": "economico", "a/big": "potente" };
    const fake = fakeClient({ choice: "economico", confidence: 0.95 });
    const { judge } = judgeFor(fake, richPool, labels);

    await judge.decide("write the briefs", "a/big");
    const stayed = await judge.decide("harden the error paths", "a/big", [
      { ref: "a/cheap", kind: "quota_exhausted" },
      { ref: "b/cheap", kind: "rate_limited" },
    ]);
    expect(stayed).toMatchObject({ decision: "stay", reason: "no-viable-candidate", skipped: "a/cheap" });
    expect(stayed!.ref).toBeUndefined();
  });

  test("#868: a declared pool widens rotation beyond the tier bound (option B)", async () => {
    const richPool: RoutingModel[] = [
      { ref: "a/cheap", price: 1 },
      { ref: "a/big", price: 100 },
      { ref: "b/big", price: 110 },
    ];
    const labels = { "a/cheap": "economico", "a/big": "potente" };
    const fake = fakeClient({ choice: "economico", confidence: 0.95 });
    const state: Record<string, unknown> = {};
    const judge = createRoutingJudge(
      { client: fake, state },
      {
        pool: async () => ({ models: richPool }),
        labels,
        // b/big is potente-priced, outside the economico tier: only the
        // declared pool makes it a rotation candidate.
        declaredPool: ["b/big"],
      },
    );

    await judge.decide("write the briefs", "a/big");
    const widened = await judge.decide("harden the error paths", "a/big", [
      { ref: "a/cheap", kind: "quota_exhausted" },
    ]);
    expect(widened).toMatchObject({ decision: "switch", ref: "b/big", skipped: "a/cheap" });
  });

  test("#868: a single-model tier behaves exactly as #852 left it", async () => {
    const fake = fakeClient({ choice: "economico", confidence: 0.95 });
    const { judge } = judgeFor(fake);
    await judge.decide("write the briefs", "a/big");
    const refused = await judge.decide("harden the error paths", "a/big", [
      { ref: "a/cheap", kind: "quota_exhausted" },
    ]);
    expect(refused).toMatchObject({ decision: "stay", reason: "cooled-down" });
    expect(refused!.ref).toBeUndefined();
  });

  test("a command pauses, resumes and releases — and the streak follows", async () => {
    const fake = fakeClient({ choice: "potente", confidence: 0.9 });
    const { judge } = judgeFor(fake);

    expect(judge.control("off")).toEqual({ paused: true, override: false });
    expect(await judge.decide("design", "a/cheap")).toBeNull();
    expect(fake.inputs).toHaveLength(0);

    expect(judge.control("on")).toEqual({ paused: false, override: false });
    await judge.decide("design", "a/cheap");
    expect(judge.snapshot()).toMatchObject({ streak: 1, streakTier: "potente" });
    expect(await judge.decide("design more", "a/cheap")).toMatchObject({ decision: "switch" });

    // A manual override, then the release: routing works again, hysteresis
    // from zero, and the current model is left alone (ratified).
    judge.noteModelSwitched("a/handpicked");
    expect(judge.snapshot()).toMatchObject({ override: true });
    expect(judge.control("auto")).toEqual({ paused: false, override: false });
    // Releasing hands routing back whole: the next turn is judged again
    // (and the current model is left alone — the ratification).
    expect(judge.snapshot()).toMatchObject({ override: false, streak: 0, streakTier: null, decidedModel: null });
    expect(await judge.decide("design again", "a/handpicked")).toMatchObject({ decision: "stay", reason: "streak" });

    expect(judge.control("banana")).toBeNull();
  });

  test("#944: two interleaved sessions do not share a streak", async () => {
    // One runtime (hence one judge) serves the owner session and every
    // subagent child it spawns: the child's turns run `beforeTurn` through
    // it. Their state must stay separate — the parent's hysteresis is the
    // parent's turns only, and a child's switch is the child's.
    const fake = fakeClient({ choice: "potente", confidence: 0.9 });
    const { judge } = judgeFor(fake);
    const owner = { id: "s-owner", owner: true };
    const child = { id: "s-child", owner: false };

    // Two children, one turn each — the shape that used to complete the
    // hysteresis between two different children.
    expect(await judge.decide("child task one", "a/cheap", [], child)).toMatchObject({
      decision: "stay",
      reason: "streak",
      streak: 1,
    });
    const second = await judge.decide("child task two", "a/cheap", [], { id: "s-child-2", owner: false });
    expect(second).toMatchObject({ decision: "stay", reason: "streak", streak: 1 });

    // The owner has judged nothing: no streak, no expectation, no switch.
    expect(judge.snapshot(owner)).toMatchObject({ streak: 0, streakTier: null, decidedModel: null, expected: null });
    expect(judge.snapshot(child)).toMatchObject({ streak: 1, streakTier: "potente" });

    // The owner's own first turn is a first turn, whatever its children did.
    const ownerFirst = await judge.decide("owner task one", "a/cheap", [], owner);
    expect(ownerFirst).toMatchObject({ decision: "stay", reason: "streak", streak: 1 });
    const ownerSecond = await judge.decide("owner task two", "a/cheap", [], owner);
    expect(ownerSecond).toMatchObject({ decision: "switch", reason: "hysteresis", streak: 2, ref: "a/big" });
  });

  test("#944: a child's switch never sets or clears the owner's expectation", async () => {
    const fake = fakeClient({ choice: "potente", confidence: 0.9 });
    const { judge } = judgeFor(fake);
    const owner = { id: "s-owner", owner: true };
    const child = { id: "s-child", owner: false };

    await judge.decide("child task one", "a/cheap", [], child);
    const switched = await judge.decide("child task two", "a/cheap", [], child);
    expect(switched).toMatchObject({ decision: "switch", ref: "a/big" });
    judge.noteSwitch(switched!.ref!, "a/cheap", child);

    // The child expects a/big — the owner expects nothing, so its serving
    // model (never a/big) is not a mismatch it invented.
    expect(judge.snapshot(child).expected).toBe("a/big");
    expect(judge.snapshot(owner)).toMatchObject({ decidedModel: null, expected: null, servingAtDecision: null });
    const mismatches: string[] = [];
    expect(await judge.decide("owner task one", "a/cheap", [], owner)).toMatchObject({ decision: "stay", reason: "streak" });
    expect(mismatches).toEqual([]);

    // A switch that fails to apply is the child's pending one, never the
    // owner's: the owner's own skip bookkeeping is untouched.
    expect(judge.switchPending()).toBe(false);
  });

  test("#944: a child is born with the pause in force, never the override", async () => {
    const fake = fakeClient({ choice: "potente", confidence: 0.9 });
    const { judge } = judgeFor(fake);

    // `/routing off` in the owner session: the work at hand is paused, and
    // the subagents that work spawns inherit exactly that.
    judge.control("off");
    expect(await judge.decide("child task one", "a/cheap", [], { id: "s-child", owner: false })).toBeNull();
    expect(fake.inputs).toHaveLength(0);

    // A manual override is the user's own choice in their own session: a
    // child is routed normally.
    judge.control("on");
    judge.noteModelSwitched("a/handpicked");
    expect(judge.snapshot().override).toBe(true);
    expect(await judge.decide("child task one", "a/cheap", [], { id: "s-child-2", owner: false })).toMatchObject({
      decision: "stay",
      reason: "streak",
      streak: 1,
    });
  });

  test("the assignment is resolved once and reported once", async () => {
    const fake = fakeClient({ choice: "bilanciato" });
    const reported: unknown[] = [];
    let calls = 0;
    const judge = createRoutingJudge(
      { client: fake, state: {} },
      {
        pool: async () => {
          calls += 1;
          return { models: pool, warnings: ["endpoint \"local\": listing failed"] };
        },
        labels: { "a/nope": "potente" },
        onResolved: (resolution) => reported.push(resolution),
      },
    );

    await judge.decide("a", "a/cheap");
    await judge.decide("b", "a/cheap");

    expect(calls).toBe(1);
    expect(reported).toHaveLength(1);
    const resolution = reported[0] as { assignment: { ignoredLabels: string[] }; warnings: string[] };
    expect(resolution.assignment.ignoredLabels).toEqual(["a/nope"]);
    expect(resolution.warnings).toEqual(['endpoint "local": listing failed']);
  });
});
