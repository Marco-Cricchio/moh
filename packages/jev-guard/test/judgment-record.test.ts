/**
 * #843: the guardrail's `jev_judgment` record carries its verdict —
 * `decision` plus the key probability on an ask/deny — so the log is a
 * complete audit of what was decided, and the transcript projection can
 * phrase it. Every test drives a fake client: no network anywhere.
 */
import { describe, expect, test } from "bun:test";
import { createGuardrailJudge } from "../src/guardrail-judge";
import type { JevClient, JevOutcome } from "../src/client";

const okOutcome = (answers: Record<string, unknown>): JevOutcome => ({
  ok: true,
  answers: answers as never,
  model: "jev-latest",
  latencyMs: 900,
  usage: { inputTokens: 480, outputTokens: 40 },
});

const noul = (v: number) => ({ type: "noul", noul: v });
const score = (v: number) => ({ type: "score", score: v, legend: {}, probabilities: {}, confidence: 0.9 });

const fakeClient = (script: JevOutcome[]): JevClient => {
  let i = 0;
  return {
    judge: async () => {
      const out = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return out;
    },
  } as unknown as JevClient;
};

const safe = () =>
  okOutcome({ destructive: noul(0.01), in_scope: noul(0.99), exfiltration: noul(0.01), risk_level: score(0.1) });

const args = { command: "bun test" };

const judged = async (outcome: JevOutcome) => {
  const records: Record<string, unknown>[] = [];
  const judge = createGuardrailJudge(
    { client: fakeClient([outcome]), state: {}, append: (p) => records.push(p) },
    { cwd: () => process.cwd() },
  );
  const result = await judge.judge("c1", args);
  return { result, record: records[0] };
};

describe("guardrail judgment record carries the verdict (#843)", () => {
  test("a pass records decision: pass, no key probability", async () => {
    const { result, record } = await judged(safe());
    expect(result.verdict.verdict).toBe("pass");
    expect(record).toMatchObject({ useCase: "guardrail", decision: "pass" });
    expect(record && "keyProbability" in record).toBe(false);
  });

  test("an ask records decision: ask with the key probability", async () => {
    const { result, record } = await judged(
      okOutcome({ destructive: noul(0.42), in_scope: noul(0.9), exfiltration: noul(0.05), risk_level: score(0.6) }),
    );
    expect(result.verdict.verdict).toBe("ask");
    expect(record).toMatchObject({ useCase: "guardrail", decision: "ask", keyProbability: 0.42 });
  });

  test("a deny records decision: deny with the key probability", async () => {
    const { result, record } = await judged(
      okOutcome({ destructive: noul(0.9), in_scope: noul(0.9), exfiltration: noul(0.01), risk_level: score(0.2) }),
    );
    expect(result.verdict.verdict).toBe("deny");
    expect(record).toMatchObject({ useCase: "guardrail", decision: "deny", keyProbability: 0.9 });
  });

  test("an exfiltration-driven ask keys on exfiltration, not destructive", async () => {
    const { record } = await judged(
      okOutcome({ destructive: noul(0.01), in_scope: noul(0.9), exfiltration: noul(0.5), risk_level: score(0.2) }),
    );
    expect(record).toMatchObject({ decision: "ask", keyProbability: 0.5 });
  });
});
