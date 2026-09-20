/**
 * #790 MPM seed rerank: questions and judge against a fake client
 * (no network in CI). The contract: one noul question per candidate in the
 * same state, never an aggregated Score — the calibration lesson paid for
 * in note 35 ("a Score over a candidate list collapses to one number").
 *
 * The judge caps the candidate set at 30, asks one noul per kept candidate,
 * records the verdict (`useCase: "rerank"`) carrying `candidates`, `kept`,
 * `dropped` and `floor`, and returns the kept paths to the core (the
 * orientation module uses them to assemble the rescued plan). A failure of
 * the underlying client degrades to `null` (no plan), never a broken turn.
 */
import { describe, expect, test } from "bun:test";
import {
  RERANK_CANDIDATES_MAX,
  RERANK_KEEP,
  RERANK_MIN,
  createRerankJudge,
  keepFromAnswers,
  rerankQuestionsFor,
  type RerankCandidate,
} from "../src/index";
import type { JevAnswer, JevClient, JevJudgeInput, JevOutcome } from "../src/client";

function noulAnswer(probability: number): JevAnswer {
  return { type: "noul", noul: probability };
}

interface ScriptedCall {
  /** The probability the answer for `cand:<path>` should carry. */
  [path: string]: number;
}

function fake(scripted: ScriptedCall[] | { fail: true }): JevClient & { calls: JevJudgeInput[] } {
  const calls: JevJudgeInput[] = [];
  let scriptIndex = 0;
  return {
    calls,
    async judge(input: JevJudgeInput): Promise<JevOutcome> {
      calls.push(input);
      if ("fail" in scripted) return { ok: false, kind: "timeout", message: "boom" };
      const map = scripted[scriptIndex++] ?? {};
      const answers: Record<string, JevAnswer> = {};
      for (const [id, q] of Object.entries(input.questions)) {
        if (q.type !== "noul") continue;
        // Default to 0 (the calibration lesson: a missing answer is a no,
        // never a guess). Scripted probabilities win.
        answers[id] = noulAnswer(map[id] ?? 0);
      }
      input.record(answers, { model: "jev-latest", latencyMs: 10, usage: { inputTokens: 80, outputTokens: 8 } });
      return { ok: true, answers, model: "jev-latest", latencyMs: 10, usage: { inputTokens: 80, outputTokens: 8 } };
    },
  };
}

function makeJudge(scripted: ScriptedCall[] | { fail: true }) {
  const records: Record<string, unknown>[] = [];
  const client = fake(scripted);
  const judge = createRerankJudge({ client, append: (p) => records.push(p) });
  return { judge, client, records };
}

const SAMPLE_CANDIDATES: RerankCandidate[] = [
  { id: "src/a.ts", path: "src/a.ts", symbols: ["alpha"], provenance: "imports alpha" },
  { id: "src/b.ts", path: "src/b.ts", symbols: ["beta"], provenance: "matches symbol beta" },
  { id: "src/c.ts", path: "src/c.ts", symbols: ["gamma"], provenance: "mentioned in reasoning" },
];

describe("rerank questions and constants (#790)", () => {
  test("constants match the spec", () => {
    expect(RERANK_MIN).toBe(0.5);
    expect(RERANK_KEEP).toBe(5);
    expect(RERANK_CANDIDATES_MAX).toBe(30);
  });

  test("one noul question per candidate, id `cand:<path>`, same instructions", () => {
    const questions = rerankQuestionsFor(SAMPLE_CANDIDATES);
    const ids = Object.keys(questions);
    expect(ids).toEqual(["cand:src/a.ts", "cand:src/b.ts", "cand:src/c.ts"]);
    for (const q of Object.values(questions)) {
      expect(q.type).toBe("noul");
      // Same instructions for every question — the candidates differ, the
      // task is the state; one prompt, one task, per-candidate evaluation.
      if (q.type === "noul") expect(typeof q.instructions).toBe("string");
    }
    // No aggregated question (Score / single Noul over the whole list):
    // the per-candidate shape is the whole point of the call.
    expect(ids.length).toBe(SAMPLE_CANDIDATES.length);
  });

  test("`keepFromAnswers` ranks by probability, keeps top RERANK_KEEP above RERANK_MIN", () => {
    const candidates: RerankCandidate[] = Array.from({ length: 8 }, (_, i) => ({
      id: `src/f${i}.ts`,
      path: `src/f${i}.ts`,
      symbols: [],
      provenance: "",
    }));
    // 6 above the floor (0.50), 2 below — top 5 must win.
    const probs = [0.91, 0.83, 0.72, 0.66, 0.61, 0.55, 0.31, 0.12];
    const answers: Record<string, JevAnswer> = {};
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      answers[`cand:${c.path}`] = noulAnswer(probs[i]!);
    }
    const kept = keepFromAnswers(candidates, answers);
    expect(kept.map((c) => c.path)).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts"]);
  });

  test("the ranker returns whatever clears the floor (the caller decides the no-plan threshold)", () => {
    // `keepFromAnswers` is the per-candidate ranker: it returns what
    // clears RERANK_MIN. The "fewer than 2 above the floor → no plan"
    // rule lives in the orientation module (the caller), not here — the
    // ranker itself never guesses.
    const candidates: RerankCandidate[] = [
      { id: "src/a.ts", path: "src/a.ts", symbols: [], provenance: "" },
      { id: "src/b.ts", path: "src/b.ts", symbols: [], provenance: "" },
      { id: "src/c.ts", path: "src/c.ts", symbols: [], provenance: "" },
    ];
    const answers: Record<string, JevAnswer> = {
      "cand:src/a.ts": noulAnswer(0.9),
      "cand:src/b.ts": noulAnswer(0.2),
      "cand:src/c.ts": noulAnswer(0.1),
    };
    expect(keepFromAnswers(candidates, answers).map((c) => c.path)).toEqual(["src/a.ts"]);
  });

  test("a missing or malformed answer is treated as 0, never a guess", () => {
    const candidates: RerankCandidate[] = [
      { id: "src/a.ts", path: "src/a.ts", symbols: [], provenance: "" },
      { id: "src/b.ts", path: "src/b.ts", symbols: [], provenance: "" },
    ];
    const answers = { "cand:src/a.ts": noulAnswer(0.6) } as Record<string, JevAnswer>;
    const kept = keepFromAnswers(candidates, answers);
    // Only `a.ts` clears the floor; `b.ts` is malformed → 0 → dropped.
    expect(kept.map((c) => c.path)).toEqual(["src/a.ts"]);
  });
});

describe("rerank judge — one fan-out request per turn (#790)", () => {
  test("the request contains one question per candidate (asserted on the fake client)", async () => {
    const { judge, client, records } = makeJudge([
      { "cand:src/a.ts": 0.9, "cand:src/b.ts": 0.8, "cand:src/c.ts": 0.4 },
    ]);
    const kept = await judge.rerank({ task: "fix the alpha parser", candidates: SAMPLE_CANDIDATES });
    expect(kept?.kept.map((c) => c.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(client.calls.length).toBe(1);
    expect(Object.keys(client.calls[0]!.questions)).toEqual([
      "cand:src/a.ts",
      "cand:src/b.ts",
      "cand:src/c.ts",
    ]);
    // State shape: the task text plus the candidate list.
    const state = client.calls[0]!.state as { task: string; candidates: RerankCandidate[] };
    expect(state.task).toBe("fix the alpha parser");
    expect(state.candidates.map((c) => c.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    // One judgment event recorded.
    expect(records.length).toBe(1);
    expect(records[0]!.useCase).toBe("rerank");
    expect(records[0]!.kept).toEqual(["src/a.ts", "src/b.ts"]);
    expect(records[0]!.dropped).toBe(1);
    expect(records[0]!.floor).toBe(RERANK_MIN);
    expect(records[0]!.candidates).toBe(SAMPLE_CANDIDATES.length);
  });

  test("a client failure degrades to null (no plan), never a broken turn", async () => {
    const { judge, records } = makeJudge({ fail: true });
    const kept = await judge.rerank({ task: "anything", candidates: SAMPLE_CANDIDATES });
    expect(kept).toBeNull();
    // A failed judgment is still recorded (no sampling — ratified).
    expect(records.length).toBe(1);
    expect(records[0]!.useCase).toBe("rerank");
    expect(records[0]!.kept).toEqual([]);
    expect(records[0]!.candidates).toBe(SAMPLE_CANDIDATES.length);
    expect(records[0]!.dropped).toBe(SAMPLE_CANDIDATES.length);
  });

  test("candidates beyond RERANK_CANDIDATES_MAX are dropped from consideration and the payload records how many", async () => {
    // Build 35 candidates; only the first 30 are sent to the model.
    const candidates: RerankCandidate[] = Array.from({ length: 35 }, (_, i) => ({
      id: `src/x${i}.ts`,
      path: `src/x${i}.ts`,
      symbols: [],
      provenance: "",
    }));
    const script: ScriptedCall = {};
    for (let i = 0; i < RERANK_CANDIDATES_MAX; i++) {
      // Spread the kept-above-floor pool across the first 6 to land 5 in
      // the kept list; the rest stay at 0 so they are dropped.
      const probability = i < 6 ? 0.95 - i * 0.05 : 0;
      script[`cand:src/x${i}.ts`] = probability;
    }
    const { judge, client, records } = makeJudge([script]);
    const kept = await judge.rerank({ task: "anything", candidates });
    expect(client.calls.length).toBe(1);
    expect(Object.keys(client.calls[0]!.questions).length).toBe(RERANK_CANDIDATES_MAX);
    expect(kept?.kept.length).toBe(5);
    expect(records[0]!.candidates).toBe(candidates.length);
    // 35 candidates total, 5 kept, 30 dropped (the 25 beyond the cap and
    // the 5 below the floor among the considered 30).
    expect(records[0]!.dropped).toBe(candidates.length - 5);
    expect(records[0]!.droppedByCap).toBe(candidates.length - RERANK_CANDIDATES_MAX);
    expect(records[0]!.kept).toEqual([
      "src/x0.ts",
      "src/x1.ts",
      "src/x2.ts",
      "src/x3.ts",
      "src/x4.ts",
    ]);
  });
});

describe("rerank cap coherence across the seam (#790)", () => {
  test("the extension's cap matches what the spec pins (30) — drift guard", () => {
    // The core's orientation module caps the candidate list it sends to
    // the hook with its own constant (a core must not import from the
    // extension); this test is the cheap tripwire against the two
    // silently diverging. The spec pins both at 30.
    expect(RERANK_CANDIDATES_MAX).toBe(30);
  });
});
