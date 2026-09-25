/**
 * #792 compaction cut guide: the judge against a fake client (no
 * network). High droppable probability → drop, low → keep, a failed call
 * → keep (fail-open), the judged state is the preview only — never a full
 * body — and #979: ONE aggregate record per compaction, bounded calls, and
 * an honest outcome for every way the cut can end.
 */
import { describe, expect, test } from "bun:test";
import {
  COMPACTION_CUT_THRESHOLDS,
  COMPACTION_JUDGE_SECTION_BUDGET,
  createCompactionJudge,
  type JudgedSection,
} from "../src/index";
import type { JevAnswer, JevClient, JevJudgeInput, JevOutcome } from "../src/client";
import type { AppliedCut } from "@moh/extension";

interface FakeOptions {
  /** The `droppable` answer; an object fails the call instead. */
  answer?: number | { fail: true };
  /** Delay before answering, ms (a slow service). */
  delayMs?: number;
  /** Requires the call's signal to still be live (real abort semantics). */
  honorAbort?: boolean;
}

function fake(options: number | { fail: true } | FakeOptions = 0.95): JevClient & {
  states: unknown[];
  inFlight: number;
  peak: number;
  started: number;
} {
  const opts: FakeOptions = typeof options === "object" && !("fail" in options) ? options : { answer: options };
  const self = {
    states: [] as unknown[],
    inFlight: 0,
    peak: 0,
    started: 0,
    async judge(input: JevJudgeInput): Promise<JevOutcome> {
      self.states.push(input.state);
      self.started += 1;
      self.inFlight += 1;
      self.peak = Math.max(self.peak, self.inFlight);
      try {
        if (opts.delayMs !== undefined) await Bun.sleep(opts.delayMs);
        const answer = opts.answer ?? 0.95;
        if (typeof answer !== "number") return { ok: false, kind: "timeout", message: "boom" };
        if (opts.honorAbort && input.signal?.aborted) return { ok: false, kind: "unknown", message: "aborted" };
        const payload: Record<string, JevAnswer> = { droppable: { type: "noul", noul: answer } };
        input.record(payload, { model: "jev-latest", latencyMs: 10, usage: { inputTokens: 40, outputTokens: 4 } });
        return { ok: true, answers: payload, model: "jev-latest", latencyMs: 10, usage: { inputTokens: 40, outputTokens: 4 } };
      } finally {
        self.inFlight -= 1;
      }
    },
  };
  return self;
}

const SECTIONS: JudgedSection[] = [
  { id: "s0", kind: "tool_result", bytes: 4200, preview: "tool bash: bun test…" },
  { id: "s1", kind: "assistant", bytes: 300, preview: "assistant: I will refactor the parser now." },
];

/** A span of `n` sections, the earliest bodies the biggest (as a real
 * covered span tends to be: the heaviest work is the oldest). */
function span(n: number, bytes = 1000): JudgedSection[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    kind: "tool_result" as const,
    bytes: bytes + (n - i) * 10,
    preview: `tool_result c${i}: ok`,
  }));
}

/** Runs one dispatch and returns the records the judge appended. */
async function dispatch(
  sections: readonly JudgedSection[],
  options: { fake?: ReturnType<typeof fake>; judgeOptions?: Parameters<ReturnType<typeof createCompactionJudge>["judge"]>[1] } = {},
) {
  const records: Record<string, unknown>[] = [];
  const client = options.fake ?? fake();
  const judge = createCompactionJudge({ client, append: (payload) => records.push(payload) });
  const run = await judge.judge(sections, options.judgeOptions ?? {});
  return {
    run,
    records,
    client,
    /** The core's part: apply the cut and let the hook record the outcome. */
    applied: (applied: AppliedCut) => {
      run.onApplied(applied);
      return records.at(-1);
    },
  };
}

describe("compaction cut judge (#792)", () => {
  test("the threshold is the ratified DROP_MIN", () => {
    expect(COMPACTION_CUT_THRESHOLDS.DROP_MIN).toBe(0.7);
  });

  test("sections above DROP_MIN drop, the rest keep", async () => {
    const high = await dispatch(SECTIONS, { fake: fake(0.95) });
    expect(high.run.drop).toEqual(["s0", "s1"]);
    const low = await dispatch(SECTIONS, { fake: fake(0.1) });
    expect(low.run.drop).toEqual([]);
  });

  test("a failed call keeps its section and records nothing (fail-open)", async () => {
    const { run, records } = await dispatch(SECTIONS, { fake: fake({ fail: true }) });
    expect(run.drop).toEqual([]);
    run.onApplied({ keptByFloor: false, bytesAfter: 4500 });
    // A compaction that judged nothing has no judgment to audit.
    expect(records).toEqual([]);
  });

  test("the judged state is the preview, never a full body", async () => {
    const { client } = await dispatch([{ id: "s0", kind: "tool_result", bytes: 900_000, preview: "short preview" }]);
    expect((client.states[0] as string).includes("short preview")).toBe(true);
    expect((client.states[0] as string).length).toBeLessThan(300);
  });

  test("one aggregate record carries the verdicts, the drops and the sizes", async () => {
    const { run, applied } = await dispatch(SECTIONS);
    const aggregate = applied({ keptByFloor: false, bytesAfter: 0 })!;
    expect(aggregate.useCase).toBe("compact-cut");
    expect(aggregate.kind).toBe("compaction");
    expect(aggregate.outcome).toBe("cut");
    expect(aggregate.offered).toBe(2);
    expect(aggregate.judged).toBe(2);
    expect(aggregate.dropped).toEqual(["s0", "s1"]);
    expect(aggregate.bytesBefore).toBe(4500);
    expect(aggregate.bytesAfter).toBe(0);
    expect(aggregate.keptByFloor).toBe(false);
    // Every judged section's verdict is auditable in the aggregate.
    expect(aggregate.sections).toEqual([
      { id: "s0", kind: "tool_result", bytes: 4200, decision: "drop", droppable: 0.95 },
      { id: "s1", kind: "assistant", bytes: 300, decision: "drop", droppable: 0.95 },
    ]);
  });
});

describe("the per-compaction record volume is bounded (#979)", () => {
  test("a span far above the per-turn event cap produces exactly one record", async () => {
    const { run, records, applied } = await dispatch(span(200), { fake: fake(0.95) });
    // No per-section records at all: the one aggregate is the whole volume.
    expect(records).toEqual([]);
    const aggregate = applied({ keptByFloor: false, bytesAfter: 0 })!;
    expect(records).toHaveLength(1);
    // Bounded below the cap, in count *and* in payload: the record has to
    // still be appendable (the runtime drops anything above 8 KiB).
    const verdicts = aggregate.sections as unknown[];
    expect(verdicts.length).toBe(COMPACTION_JUDGE_SECTION_BUDGET);
    expect(aggregate.offered).toBe(200);
    expect(aggregate.unjudged).toBe(200 - COMPACTION_JUDGE_SECTION_BUDGET);
    expect(aggregate.unjudgedReason).toBe("budget");
    expect(JSON.stringify(aggregate).length).toBeLessThan(8 * 1024);
  });

  test("the largest bodies are the ones judged (where the bytes are)", async () => {
    const sections = span(COMPACTION_JUDGE_SECTION_BUDGET + 5);
    const { applied } = await dispatch(sections);
    const aggregate = applied({ keptByFloor: false, bytesAfter: 0 })!;
    const judged = (aggregate.sections as { id: string }[]).map((s) => s.id);
    // The five smallest sections — the span's newest — are the ones left out.
    for (let i = sections.length - 5; i < sections.length; i++) expect(judged).not.toContain(`s${i}`);
    expect(judged).toContain("s0");
  });

  test("the judged set is declared, never sampled away: the verdicts are in transcript order", async () => {
    const { applied } = await dispatch(span(20));
    const aggregate = applied({ keptByFloor: false, bytesAfter: 0 })!;
    expect((aggregate.sections as { id: string }[]).map((s) => s.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `s${i}`),
    );
    expect(aggregate.unjudged).toBeUndefined();
  });
});

describe("the cut does not blow the hook window (#979)", () => {
  test("section calls run concurrently, not one after another", async () => {
    const client = fake({ answer: 0.2, delayMs: 20 });
    await dispatch(span(40), { fake: client });
    expect(client.started).toBe(40);
    expect(client.peak).toBeGreaterThan(1);
  });

  test("a span the window cannot cover is judged as far as it goes, and says so", async () => {
    const client = fake({ answer: 0.95, delayMs: 50, honorAbort: true });
    const started = Date.now();
    const { run, applied } = await dispatch(span(100), {
      fake: client,
      judgeOptions: { hookTimeoutMs: 400 },
    });
    const elapsed = Date.now() - started;
    // It answered inside its window instead of being abandoned at 5 s.
    expect(elapsed).toBeLessThan(600);
    const aggregate = applied({ keptByFloor: false, bytesAfter: 0 })!;
    expect(aggregate.outcome).toBe("cut");
    expect(aggregate.judged).toBeGreaterThan(0);
    expect(aggregate.unjudgedReason).toBe("deadline");
    expect(run.drop.length).toBe(aggregate.judged as number);
  });

  test("a window too small to judge anything is still honest about it", async () => {
    const { run, records, applied } = await dispatch(span(10), {
      fake: fake({ answer: 0.95, delayMs: 50, honorAbort: true }),
      judgeOptions: { hookTimeoutMs: 20 },
    });
    expect(run.drop).toEqual([]);
    // Nothing was judged: the offline status is the trace, no record is owed.
    expect(applied({ keptByFloor: false, bytesAfter: 0 })).toBeUndefined();
    expect(records).toEqual([]);
  });

  test("the runtime's abandonment stops the judge instead of burning calls", async () => {
    const controller = new AbortController();
    const client = fake({ answer: 0.95, delayMs: 30, honorAbort: true });
    const judge = createCompactionJudge({ client, append: () => {} });
    setTimeout(() => controller.abort(), 80);
    const run = await judge.judge(span(200), {
      hookTimeoutMs: 5_000,
      signal: controller.signal,
    });
    // Far fewer than the 200 offered: the abandoned dispatch stopped working.
    expect(client.started).toBeLessThan(80);
    expect(run.drop.length).toBeLessThan(80);
  });
});

describe("the aggregate carries the outcome of every ending (#979)", () => {
  test("an applied cut", async () => {
    const { applied } = await dispatch(SECTIONS);
    expect(applied({ keptByFloor: false, bytesAfter: 500 })!.outcome).toBe("cut");
  });

  test("a cut the survival floor reduced", async () => {
    const { applied } = await dispatch(SECTIONS);
    const record = applied({ keptByFloor: true, bytesAfter: 4000 })!;
    expect(record.outcome).toBe("floor");
    expect(record.keptByFloor).toBe(true);
    expect(record.bytesAfter).toBe(4000);
  });

  test("judged, nothing dropped", async () => {
    const { applied } = await dispatch(SECTIONS, { fake: fake(0.1) });
    const record = applied({ keptByFloor: false, bytesAfter: 4500 })!;
    expect(record.outcome).toBe("empty");
    expect(record.dropped).toEqual([]);
  });

  test("a discarded cut: the runtime abandoned the dispatch", async () => {
    const controller = new AbortController();
    const { run, records, applied } = await dispatch(SECTIONS, {
      judgeOptions: { hookTimeoutMs: 5_000, signal: controller.signal },
    });
    // The run happened, then the window closed before the core could apply it.
    const record = applied({ keptByFloor: false, bytesAfter: 4500, droppedIds: [], applied: false })!;
    expect(record.outcome).toBe("discarded");
    // Nothing was dropped — the core says so — and the judgment still
    // happened: it must not look like a compaction that found nothing.
    expect(record.dropped).toEqual([]);
    expect((record.sections as unknown[]).length).toBe(2);
    void run;
    // And the record is written exactly once.
    expect(records).toHaveLength(1);
    applied({ keptByFloor: false, bytesAfter: 0 });
    expect(records).toHaveLength(1);
  });

  test("the record carries the cut the core applied, not the one that was asked for", async () => {
    const { applied } = await dispatch(SECTIONS);
    const record = applied({ keptByFloor: true, bytesAfter: 4300, droppedIds: ["s1"] })!;
    expect(record.outcome).toBe("floor");
    // The floor restored s0: the record must not claim it was dropped.
    expect(record.dropped).toEqual(["s1"]);
  });
});
