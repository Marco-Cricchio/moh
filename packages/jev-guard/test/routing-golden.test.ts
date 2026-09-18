/**
 * #787: the golden set — ten real messages, the tier a careful reader
 * picks for each, and the exact model trajectory the hysteresis must
 * produce. The classifier is a fake client answering from the table (no
 * network), so the assertions cover the whole pipeline: the message that
 * leaves moh, the tier mapping, the streak and the two switches.
 */
import { describe, expect, test } from "bun:test";
import type { JevAnswer, JevJudgeInput, JevOutcome } from "../src/client";
import { createRoutingJudge } from "../src/routing-judge";

/** Real messages, in the order they are sent. */
const GOLDEN: { message: string; tier: "economico" | "bilanciato" | "potente" }[] = [
  { message: "quale è la capitale del Portogallo?", tier: "economico" },
  { message: "rinomina la variabile `foo` in `bar` dentro src/util.ts", tier: "economico" },
  { message: "aggiungi un caso di test per parseRule con una regola vuota", tier: "economico" },
  { message: "perché il test di compaction fallisce solo in CI?", tier: "bilanciato" },
  { message: "spiegami come funziona il turn queue rispetto allo steering", tier: "bilanciato" },
  { message: "estrai la risoluzione delle regole fuori dal permission gate", tier: "bilanciato" },
  { message: "progetta il canale client→extension che serve /routing", tier: "potente" },
  { message: "debugga la race fra il repaint differito e la chiusura dell'alternate screen", tier: "potente" },
  { message: "implementa il routing multi-endpoint con catene di fallback intatte", tier: "potente" },
  { message: "analizza l'intero codebase e proponi un piano di modularizzazione in tre fasi", tier: "potente" },
];

const pool = {
  models: [
    { ref: "a/cheap", price: 1 },
    { ref: "a/mid", price: 10 },
    { ref: "a/big", price: 100 },
  ],
};

/** Answers the tier the table expects for the message it receives. */
function goldenClient(): { judge(input: JevJudgeInput): Promise<JevOutcome>; inputs: JevJudgeInput[] } {
  const inputs: JevJudgeInput[] = [];
  return {
    inputs,
    async judge(input: JevJudgeInput): Promise<JevOutcome> {
      inputs.push(input);
      const row = GOLDEN.find((r) => r.message === input.state);
      if (!row) {
        // The message did not reach Jev intact (or was truncated when it
        // should not have been): an unconfident answer, so the trajectory
        // assertion below fails loudly rather than silently passing.
        const answers: Record<string, JevAnswer> = {
          difficulty: { type: "choice", choice: "bilanciato", probabilities: {}, confidence: 0.1 },
          needs_context: { type: "noul", noul: 0 },
        };
        const meta = { model: "jev-latest", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } };
        input.record(answers, meta);
        return { ok: true, answers, model: meta.model, latencyMs: 1, usage: meta.usage };
      }
      const answers: Record<string, JevAnswer> = {
        difficulty: { type: "choice", choice: row.tier, probabilities: { [row.tier]: 0.9 }, confidence: 0.9 },
        needs_context: { type: "noul", noul: 0 },
      };
      const meta = { model: "jev-latest", latencyMs: 8, usage: { inputTokens: 60, outputTokens: 5 } };
      input.record(answers, meta);
      return { ok: true, answers, model: meta.model, latencyMs: 8, usage: meta.usage };
    },
  };
}

describe("routing golden set (#787)", () => {
  test("ten real messages produce the expected tier and switch trajectory", async () => {
    const client = goldenClient();
    const judge = createRoutingJudge({ client, state: {} }, { pool: async () => pool });
    /** The model that would serve each turn, or undefined when it stays. */
    const switches: (string | undefined)[] = [];
    const tiers: string[] = [];
    /** The serving model, exactly as the session updates it on a switch. */
    let serving = "a/cheap";

    for (const row of GOLDEN) {
      const verdict = await judge.decide(row.message, serving);
      expect(verdict).not.toBeNull();
      tiers.push(verdict!.tier!);
      switches.push(verdict!.ref);
      if (verdict!.ref !== undefined) {
        judge.noteSwitch(verdict!.ref);
        serving = verdict!.ref;
      }
    }

    // Every message reached Jev whole, and the judged tier is the expected one.
    expect(tiers).toEqual(GOLDEN.map((r) => r.tier));
    expect(client.inputs.map((i) => i.state)).toEqual(GOLDEN.map((r) => r.message));

    // The trajectory: three cheap messages keep the cheap model (same tier),
    // the balanced tier needs its second turn, then the same for powerful.
    expect(switches).toEqual([
      undefined, // 1 · economico = current tier (a/cheap)
      undefined, // 2
      undefined, // 3
      undefined, // 4 · bilanciato, first turn (streak 1)
      "a/mid", //   5 · bilanciato, second turn → switch
      undefined, // 6 · already on a/mid
      undefined, // 7 · potente, first turn (streak 1)
      "a/big", //   8 · potente, second turn → switch
      undefined, // 9 · already on a/big (streak was reset by the switch)
      undefined, // 10 · still potente — and already there
    ]);

    // The strict privacy half: only the last message and the questions leave.
    for (const input of client.inputs) {
      expect(typeof input.state).toBe("string");
      expect(Object.keys(input.questions)).toEqual(["difficulty", "needs_context"]);
    }
  });
});
