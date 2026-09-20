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
  test("a pass aggregates into the turn record after flush; no key probability (#846)", async () => {
    const records: Record<string, unknown>[] = [];
    const judge = createGuardrailJudge(
      { client: fakeClient([safe()]), state: {}, append: (p) => records.push(p) },
      { cwd: () => process.cwd() },
    );
    const result = await judge.judge("c1", args);
    expect(result.verdict.verdict).toBe("pass");
    // No per-call record on a pass — it joins the turn aggregate.
    expect(records).toHaveLength(0);
    judge.flushPasses();
    expect(records[0]).toMatchObject({ useCase: "guardrail_passes", calls: 1 });
    expect(records[0] && ("keyProbability" in records[0] || "decision" in records[0])).toBe(false);
  });

  test("an ask records decision: ask with the key dimension and probability", async () => {
    const { result, record } = await judged(
      okOutcome({ destructive: noul(0.42), in_scope: noul(0.9), exfiltration: noul(0.05), risk_level: score(0.6) }),
    );
    expect(result.verdict.verdict).toBe("ask");
    expect(record).toMatchObject({ useCase: "guardrail", decision: "ask", keyDimension: "destructive", keyProbability: 0.42 });
  });

  test("a deny records decision: deny with the key dimension and probability", async () => {
    const { result, record } = await judged(
      okOutcome({ destructive: noul(0.9), in_scope: noul(0.9), exfiltration: noul(0.01), risk_level: score(0.2) }),
    );
    expect(result.verdict.verdict).toBe("deny");
    expect(record).toMatchObject({ useCase: "guardrail", decision: "deny", keyDimension: "destructive", keyProbability: 0.9 });
  });

  test("an exfiltration-driven ask keys on exfiltration, not destructive", async () => {
    const { record } = await judged(
      okOutcome({ destructive: noul(0.01), in_scope: noul(0.9), exfiltration: noul(0.5), risk_level: score(0.2) }),
    );
    expect(record).toMatchObject({ decision: "ask", keyDimension: "exfiltration", keyProbability: 0.5 });
  });

  test("a cache hit records the verdict too, including a deny's key probability (#843 review)", async () => {
    const records: Record<string, unknown>[] = [];
    const outcome = okOutcome({ destructive: noul(0.9), in_scope: noul(0.9), exfiltration: noul(0.01), risk_level: score(0.2) });
    const judge = createGuardrailJudge(
      { client: fakeClient([outcome]), state: {}, append: (p) => records.push(p) },
      { cwd: () => process.cwd() },
    );
    await judge.judge("c1", args);
    const r2 = await judge.judge("c2", args);
    expect(r2.cached).toBe(true);
    expect(r2.verdict.verdict).toBe("deny");
    expect(records[1]).toMatchObject({ decision: "deny", keyDimension: "destructive", keyProbability: 0.9 });
  });

  test("#848: a cache-hit record is marked cached: true and carries no fabricated model/latency/usage", async () => {
    const records: Record<string, unknown>[] = [];
    const outcome = okOutcome({ destructive: noul(0.01), in_scope: noul(0.99), exfiltration: noul(0.01), risk_level: score(0.1) });
    const judge = createGuardrailJudge(
      { client: fakeClient([outcome]), state: {}, append: (p) => records.push(p) },
      { cwd: () => process.cwd() },
    );
    await judge.judge("c1", args);
    await judge.judge("c2", args); // cache hit
    judge.flushPasses();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ useCase: "guardrail_passes", calls: 2 });
    expect(records[0]!.model).toBeUndefined();
    expect(records[0]!.latencyMs).toBeUndefined();
    expect(records[0]!.usage).toBeUndefined();
    expect(records[0]!.answers).toBeUndefined();
    expect(records[0]!.decision).toBeUndefined();
  });
});

describe("guardrail pass aggregation (#846)", () => {
  test("passing judgments aggregate into one record per turn; asks record immediately", async () => {
    const records: Record<string, unknown>[] = [];
    const safeCmd = { ...args, command: "ls -la" };
    const denyCmd = { ...args, command: "rm -rf /" };
    const denyOutcome = okOutcome({ destructive: noul(0.9), in_scope: noul(0.9), exfiltration: noul(0.01), risk_level: score(0.2) });
    const judge = createGuardrailJudge(
      { client: fakeClient([safe(), denyOutcome]), state: {}, append: (p) => records.push(p) },
      { cwd: () => process.cwd() },
    );
    await judge.judge("c1", safeCmd);
    await judge.judge("c2", safeCmd); // cache hit, script not consumed
    await judge.judge("c3", denyCmd);
    // Two pass judgments → nothing yet; the deny landed immediately.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ useCase: "guardrail", decision: "deny" });
    judge.flushPasses();
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ useCase: "guardrail_passes", calls: 2, callIds: ["c1", "c2"] });
  });

  test("a turn with no passing calls flushes nothing", () => {
    const records: Record<string, unknown>[] = [];
    const judge = createGuardrailJudge(
      { client: fakeClient([]), state: {}, append: (p) => records.push(p) },
      { cwd: () => process.cwd() },
    );
    judge.flushPasses();
    expect(records).toHaveLength(0);
  });

  test("a cached pass joins the aggregate; a cached ask/deny records immediately", async () => {
    const records: Record<string, unknown>[] = [];
    const sameCmd = { ...args, command: "bun test" };
    const denyOutcome = okOutcome({ destructive: noul(0.9), in_scope: noul(0.9), exfiltration: noul(0.01), risk_level: score(0.2) });
    const judge = createGuardrailJudge(
      { client: fakeClient([safe(), denyOutcome]), state: {}, append: (p) => records.push(p) },
      { cwd: () => process.cwd() },
    );
    await judge.judge("c1", sameCmd);
    const cached = await judge.judge("c2", sameCmd);
    expect(cached.cached).toBe(true);
    // Live pass + cached pass: nothing per-call, only the flush record.
    expect(records).toHaveLength(0);
    await judge.judge("c3", { ...args, command: "bun test && echo x" }); // live deny
    await judge.judge("c4", { ...args, command: "bun test && echo x" }); // cached deny, recorded immediately
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ decision: "deny" });
    expect(records[1]).toMatchObject({ decision: "deny" });
    judge.flushPasses(); // the earlier passes (c1, c2) still aggregate here
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({ useCase: "guardrail_passes", calls: 2, callIds: ["c1", "c2"] });
  });
});

describe("#846: a tool-heavy turn stays under the event cap", () => {
  test("70 judged calls emit at most one record per turn (the aggregate), never 70", async () => {
    const records: Record<string, unknown>[] = [];
    const judge = createGuardrailJudge(
      // One live outcome; the other 69 judgments are cache hits.
      { client: fakeClient([safe()]), state: {}, append: (p) => records.push(p) },
      { cwd: () => process.cwd() },
    );
    for (let i = 0; i < 70; i++) await judge.judge(`c${i}`, args);
    judge.flushPasses();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ useCase: "guardrail_passes", calls: 70 });
  });
});
