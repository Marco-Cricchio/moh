/**
 * #786: the guardrail's decision rule, the session cache and the judge.
 * Every test drives a fake client — no real network anywhere here.
 */
import { describe, expect, test } from "bun:test";
import {
  decideGuardrail,
  GUARDRAIL_QUESTIONS,
  GUARDRAIL_THRESHOLDS,
  type GuardrailSignals,
} from "../src/guardrail";
import {
  createGuardrailCache,
  gitSnapshot,
  guardrailStateKey,
} from "../src/session-state";
import { askBadge, createGuardrailJudge } from "../src/guardrail-judge";
import type { JevClient, JevOutcome } from "../src/client";

const signals = (over: Partial<GuardrailSignals> = {}): GuardrailSignals => ({
  destructive: 0.01,
  inScope: 0.99,
  exfiltration: 0.01,
  riskLevel: 0.1,
  ...over,
});

describe("guardrail decision rule (#786 thresholds)", () => {
  test("pass on clearly safe commands (full mode)", () => {
    expect(decideGuardrail(signals(), false).verdict).toBe("pass");
  });

  test("deny above the destructive threshold", () => {
    const t = GUARDRAIL_THRESHOLDS;
    expect(decideGuardrail(signals({ destructive: t.denyHigh + 0.01 }), false).verdict).toBe("deny");
    expect(decideGuardrail(signals({ destructive: t.denyHigh }), false).verdict).toBe("ask");
    expect(decideGuardrail(signals({ destructive: t.denyHigh }), false).verdict).toBe("ask");
  });

  test("deny above the exfiltration threshold — the curl hole is closed (#867: low in_scope)", () => {
    const d = decideGuardrail(signals({ exfiltration: 0.9, inScope: 0.2 }), false);
    expect(d.verdict).toBe("deny");
    expect(d.reason).toContain("exfiltration");
    expect(d.reason).toContain("ask first");
  });

  test("ask in the middle bands, both dimensions", () => {
    const t = GUARDRAIL_THRESHOLDS;
    expect(decideGuardrail(signals({ destructive: t.askLow }), false).verdict).toBe("ask");
    expect(decideGuardrail(signals({ exfiltration: t.askLow }), false).verdict).toBe("ask");
    expect(decideGuardrail(signals({ destructive: t.askLow - 0.01 }), false).verdict).toBe("pass");
  });

  test("risk bands: ask from 0.75, deny from 1.5", () => {
    expect(decideGuardrail(signals({ riskLevel: 1.49 }), false).verdict).toBe("ask");
    expect(decideGuardrail(signals({ riskLevel: 1.5 }), false).verdict).toBe("deny");
    expect(decideGuardrail(signals({ riskLevel: 0.75 }), false).verdict).toBe("ask");
    expect(decideGuardrail(signals({ riskLevel: 0.74 }), false).verdict).toBe("pass");
  });

  test("lethal-only (yolo): never asks, only the two deny checks decide", () => {
    expect(decideGuardrail(signals({ destructive: 0.6, exfiltration: 0.6, riskLevel: 0.9 }), true).verdict).toBe("pass");
    expect(decideGuardrail(signals({ destructive: 0.9 }), true).verdict).toBe("deny");
    expect(decideGuardrail(signals({ exfiltration: 0.9, inScope: 0.2 }), true).verdict).toBe("deny");
  });
});

describe("guardrail decision rule (#867 exfiltration/in-scope contradiction)", () => {
  const t = GUARDRAIL_THRESHOLDS;

  test("full mode: exfiltration high but in_scope high downgrades deny to ask", () => {
    const d = decideGuardrail(signals({ exfiltration: 0.92, inScope: 0.9 }), false);
    expect(d.verdict).toBe("ask");
    expect(d.reason).toBeUndefined();
  });

  test("full mode: exfiltration high with low in_scope still denies", () => {
    expect(decideGuardrail(signals({ exfiltration: 0.92, inScope: 0.2 }), false).verdict).toBe("deny");
  });

  test("full mode: the contradiction only saves exfiltration, never destructive", () => {
    expect(decideGuardrail(signals({ destructive: 0.92, inScope: 0.9 }), false).verdict).toBe("deny");
  });

  test("full mode: exfiltration in the ask band with high in_scope still asks", () => {
    expect(decideGuardrail(signals({ exfiltration: t.askLow, inScope: 0.9 }), false).verdict).toBe("ask");
  });

  test("yolo: exfiltration high but in_scope high passes (never asks)", () => {
    expect(decideGuardrail(signals({ exfiltration: 0.92, inScope: 0.9 }), true).verdict).toBe("pass");
    expect(decideGuardrail(signals({ exfiltration: 0.92, inScope: 0.2 }), true).verdict).toBe("deny");
  });

  test("all four questions are declared, one call", () => {
    expect(Object.keys(GUARDRAIL_QUESTIONS).sort()).toEqual(["destructive", "exfiltration", "in_scope", "risk_level"]);
  });
});

describe("session cache + key", () => {
  test("non-git state keys on the command alone", () => {
    expect(guardrailStateKey({ command: "bun test", cwd: "/x", git: null })).toBe("bun test");
    expect(guardrailStateKey({ command: "bun test", cwd: "/x", git: "main:dirty" })).toContain("main:dirty");
  });

  test("cache serves full verdicts, clear drops all", () => {
    const cache = createGuardrailCache();
    cache.set("k", { verdict: "ask", badge: "Jev: caso incerto (destructive 0.42)", keyDimension: "destructive", keyProbability: 0.42 });
    expect(cache.get("k")).toEqual({ verdict: "ask", badge: "Jev: caso incerto (destructive 0.42)", keyDimension: "destructive", keyProbability: 0.42 });
    cache.clear();
    expect(cache.get("k")).toBeUndefined();
  });

  test("gitSnapshot returns null off-repo and a branch:dirty string in one", () => {
    expect(gitSnapshot("/nonexistent-repo-zz")).toBeNull();
    const snap = gitSnapshot(process.cwd());
    if (snap !== null) expect(snap).toMatch(/^[^:]+:(dirty|clean)$/);
  });
});

describe("guardrail judge", () => {
  const fakeClient = (script: JevOutcome[]): { client: JevClient; calls: number } => {
    let i = 0;
    return {
      get calls() {
        return i;
      },
      client: {
        judge: async () => {
          const out = script[Math.min(i, script.length - 1)]!;
          i += 1;
          return out;
        },
      },
    };
  };

  const okOutcome = (answers: Record<string, unknown>): JevOutcome => ({
    ok: true,
    answers: answers as never,
    model: "jev-latest",
    latencyMs: 900,
    usage: { inputTokens: 480, outputTokens: 40 },
  });

  const safe = () => okOutcome({ destructive: { type: "noul", noul: 0.01 }, in_scope: { type: "noul", noul: 0.99 }, exfiltration: { type: "noul", noul: 0.01 }, risk_level: { type: "score", score: 0.1, legend: {}, probabilities: {}, confidence: 0.9 } });
  const args = { command: "bun test" };

  test("deny becomes a veto with an actionable reason", async () => {
    const { client } = fakeClient([okOutcome({ destructive: { type: "noul", noul: 0.9 }, in_scope: { type: "noul", noul: 0.9 }, exfiltration: { type: "noul", noul: 0.01 }, risk_level: { type: "score", score: 1.8, legend: {}, probabilities: {}, confidence: 0.9 } })]);
    const judge = createGuardrailJudge({ client, state: {} }, { cwd: () => process.cwd() });
    const r = await judge.judge("c1", args);
    expect(r.verdict.verdict).toBe("deny");
    if (r.verdict.verdict === "deny") expect(r.verdict.reason).toContain("destructive");
  });

  test("ask carries the ratified badge and is served from cache too", async () => {
    const { client, calls } = Object.assign(fakeClient([okOutcome({ destructive: { type: "noul", noul: 0.5 }, in_scope: { type: "noul", noul: 0.9 }, exfiltration: { type: "noul", noul: 0.05 }, risk_level: { type: "score", score: 0.6, legend: {}, probabilities: {}, confidence: 0.9 } })]), {});
    const judge = createGuardrailJudge({ client, state: {} }, { cwd: () => process.cwd() });
    const r1 = await judge.judge("c1", args);
    expect(r1.verdict.verdict).toBe("ask");
    expect(r1.cached).toBe(false);
    if (r1.verdict.verdict === "ask") expect(r1.verdict.badge).toContain("caso incerto");
    const r2 = await judge.judge("c2", args);
    expect(r2.cached).toBe(true);
    expect(r2.verdict.verdict).toBe("ask");
  });

  test("fail-open is a pass and is NOT cached — next call retries", async () => {
    const fake = fakeClient([{ ok: false, kind: "network" as const, message: "down" }, safe()]);
    const judge = createGuardrailJudge({ client: fake.client, state: {} }, { cwd: () => process.cwd() });
    const r1 = await judge.judge("c1", args);
    expect(r1.verdict.verdict).toBe("pass");
    expect(r1.cached).toBe(false);
    const r2 = await judge.judge("c2", args);
    expect(r2.cached).toBe(false);
    expect(r2.verdict.verdict).toBe("pass");
  });

  test("cache invalidates when the git snapshot flips (lastGit change)", async () => {
    const fake = fakeClient([safe(), safe()]);
    const state: Record<string, unknown> = {};
    const judge = createGuardrailJudge({ client: fake.client, state }, { cwd: () => process.cwd() });
    await judge.judge("c1", args);
    const before = fake.calls;
    await judge.judge("c2", args);
    expect(fake.calls).toBe(before); // cache hit
    // Simulate a branch switch: the state's snapshot no longer matches.
    state.lastGit = "other-branch:dirty";
    judge.invalidateOnGitChange();
    await judge.judge("c3", args);
    expect(fake.calls).toBeGreaterThan(before);
  });

  test("mode reaches the rule: yolo is lethal-only", async () => {
    let mode: "normal" | "yolo" = "yolo";
    const fake = fakeClient([okOutcome({ destructive: { type: "noul", noul: 0.6 }, in_scope: { type: "noul", noul: 0.9 }, exfiltration: { type: "noul", noul: 0.01 }, risk_level: { type: "score", score: 0.9, legend: {}, probabilities: {}, confidence: 0.9 } })]);
    const judge = createGuardrailJudge({ client: fake.client, state: {} }, { mode: () => mode, cwd: () => process.cwd() });
    const r = await judge.judge("c1", args);
    expect(r.verdict.verdict).toBe("pass"); // middle-band risk alone never denies in yolo
    mode = "normal";
    const judge2 = createGuardrailJudge({ client: fake.client, state: {} }, { mode: () => mode, cwd: () => process.cwd() });
    const r2 = await judge2.judge("c2", args);
    expect(r2.verdict.verdict).toBe("ask");
  });

  test("badge picks the highest-signal dimension", () => {
    expect(askBadge(signals({ destructive: 0.5 })).badge).toBe("Jev: caso incerto (destructive 0.50)");
    expect(askBadge(signals({ exfiltration: 0.5 })).badge).toBe("Jev: caso incerto (exfiltration 0.50)");
    expect(askBadge(signals({ riskLevel: 1.0 })).badge).toContain("risk");
  });

  test("non-bash guard: the judge itself only sees bash", async () => {
    const fake = fakeClient([safe()]);
    const judge = createGuardrailJudge({ client: fake.client, state: {} }, { cwd: () => process.cwd() });
    const r = await judge.judge("c1", { path: "/x" });
    expect(r.verdict.verdict).toBe("pass"); // no command → pass, no call
    expect(fake.calls).toBe(0);
  });
});
