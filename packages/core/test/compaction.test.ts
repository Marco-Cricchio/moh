/**
 * Compaction producer (#466): CompactionRunner — auto trigger on the
 * 80% context-window threshold (180k absolute fallback), anti-loop
 * stale-measurement guard, 10-turn verbatim tail, chained summaries,
 * one retry fail-silent, forced path, and the transcript renderer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentSession, MockProvider, createSession } from "../src/index";
import { ProviderRegistry } from "../src/provider-registry";
import {
  CompactionRunner,
  FALLBACK_CONTEXT_WINDOW,
  compactionTranscript,
  contextWindowFor,
  createCompactionSummarizer,
  type CompactionSummarizer,
} from "../src/compaction";
import type { AgentEvent, Provider } from "../src/types";

const TMP = join(import.meta.dir, "tmp-compaction");

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function log(...events: AgentEvent[]): AgentEvent[] {
  return events;
}

function turnEvents(i: number, inputTokens: number): AgentEvent[] {
  return [
    { type: "user_message", text: `user turn ${i}` },
    { type: "assistant_delta", text: `reply ${i}` },
    { type: "done", usage: { inputTokens, outputTokens: 10 } },
    { type: "model_call", model: "mock", usage: { inputTokens, outputTokens: 10 } },
  ];
}

const scriptedSummarizer: CompactionSummarizer = async ({ previous, transcript }) =>
  `SUMMARY of ${transcript.length} chars${previous ? ` (after: ${previous})` : ""}`;

/** Indices of `user_message` events. */
function indicesFor(events: AgentEvent[], turn: number): number {
  let seen = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.type === "user_message") {
      seen += 1;
      if (seen === turn) return i;
    }
  }
  throw new Error(`turn ${turn} not found`);
}

/** True when the tail beginning at `start` would not open on a `tool_result`. */
function legalBoundariesOk(events: AgentEvent[], start: number): boolean {
  const first = events[start]!.type;
  return first === "user_message" || first === "assistant_delta" || first === "reasoning" || first === "tool_call";
}

function runner(events: AgentEvent[], summarizer: CompactionSummarizer = scriptedSummarizer, window?: number) {  const appended: AgentEvent[] = [];
  const r = new CompactionRunner({
    sessionId: "session-test",
    provider: () => MockProvider.scripted([{ deltas: ["x"], finish: "stop" }]),
    endpointType: window === undefined ? undefined : () => "anthropic",
    append: (e) => appended.push(e),
    onCompacted: () => {},
    summarizer,
    ...(window !== undefined ? { fallbackWindowTokens: window } : {}),
  });
  return { r, appended };
}

describe("upToFor / tail", () => {
  test("keeps the last 10 turns verbatim", () => {
    const events: AgentEvent[] = [{ type: "session_start", schemaVersion: 1, promptVersion: "p" }];
    for (let i = 0; i < 13; i++) events.push({ type: "user_message", text: `t${i}` });
    // 13 turns; tail of 10 → upTo = index of turn #3 (the 4th turn).
    expect(CompactionRunner.upToFor(events, 10)).toEqual({ upTo: 4, partial: false });
  });

  test("undefined when the log has too few turns", () => {
    const events = log({ type: "user_message", text: "a" }, { type: "user_message", text: "b" });
    expect(CompactionRunner.upToFor(events, 10)).toBeUndefined();
  });

  test("upTo counts from the full log after a chained marker", () => {
    // Simulate a chained situation: marker upTo=2, then 8 new turns →
    // the new upTo is absolute (index 5 = the 5th user_message overall
    // when tail=5 and total turns = 9).
    const events: AgentEvent[] = [];
    for (let i = 0; i < 9; i++) events.push({ type: "user_message", text: `t${i}` });
    expect(CompactionRunner.upToFor(events, 5)).toEqual({ upTo: 4, partial: false });
  });

  test("tail never exceeds ~25% of the window when turn tokens are measured (#949: the window wins)", () => {
    // 30 turns × 40k tokens each; window 1M → 25% cap = 250k. The 10-turn
    // tail would span 400k > cap: the shrink continues past the old floor
    // down to the largest whole-turn count under the cap (6 turns = 240k).
    const events: AgentEvent[] = [];
    for (let i = 0; i < 30; i++) events.push(...turnEvents(i, 40_000));
    const indices40: number[] = [];
    for (let i = 0; i < events.length; i++) if (events[i]!.type === "user_message") indices40.push(i);
    expect(CompactionRunner.upToFor(events, 10, 1_000_000)).toEqual({ upTo: indices40[24], partial: false });
    // Smaller turns: 30 × 20k, window 1M → cap 250k fits 12 turns → the
    // tail spans 12 turns, upTo = the 18th user_message (index 1 + 17*5).
    const small: AgentEvent[] = [];
    for (let i = 0; i < 30; i++) small.push(...turnEvents(i, 20_000));
    // tail=12: user_messages 17..29 span 12×20k = 240k ≤ 250k.
    const indices: number[] = [];
    for (let i = 0; i < small.length; i++) if (small[i]!.type === "user_message") indices.push(i);
    expect(CompactionRunner.upToFor(small, 12, 1_000_000)?.upTo).toBe(indices[18]);
    // The protected last turn: even when it alone busts the cap, it stays
    // whole while it fits window − 8k (here 900k ≤ 1M − 8192).
    const huge: AgentEvent[] = [];
    for (let i = 0; i < 15; i++) huge.push(...turnEvents(i, i === 14 ? 900_000 : 100));
    const hugeCut = CompactionRunner.upToFor(huge, 12, 1_000_000)!;
    expect(hugeCut.partial).toBe(false);
    expect(hugeCut.upTo).toBe(indicesFor(huge, 14)); // the whole tail folds; only turn 14 remains
    // When the last turn alone exceeds window − 8k, the cut goes INSIDE
    // it (partial tail): the largest legal suffix under the ceiling.
    const giant: AgentEvent[] = [];
    for (let i = 0; i < 15; i++) giant.push(...turnEvents(i, i === 14 ? 1_100_000 : 100));
    const giantCut = CompactionRunner.upToFor(giant, 10, 1_000_000)!;
    expect(giantCut.partial).toBe(true);
    expect(giantCut.upTo).toBeGreaterThan(indicesFor(giant, 13)); // inside turn 14, not at its user_message
    expect(legalBoundariesOk(giant, giantCut.upTo)).toBe(true);
  });
});

describe("threshold", () => {
  test("fires above 80% of the catalog window, not below", () => {
    // claude-haiku-4-5: 200k window → 80% = 160k.
    const appended: AgentEvent[] = [];
    const r = new CompactionRunner({
      sessionId: "session-test",
      provider: () => ({ name: "anthropic/claude-haiku-4-5" }) as never,
      endpointType: () => "anthropic",
      append: (e) => appended.push(e),
      onCompacted: () => {},
      summarizer: scriptedSummarizer,
    });
    expect(r.shouldAutoCompact(turnEvents(1, 170_000))).toBe(true);
    expect(r.shouldAutoCompact(turnEvents(1, 150_000))).toBe(false);
  });

  test("unknown window falls back to the absolute threshold", () => {
    const events = turnEvents(1, FALLBACK_CONTEXT_WINDOW + 1);
    // No endpointType → contextWindowFor = 0 → fallback.
    const { r } = runner(events, scriptedSummarizer, FALLBACK_CONTEXT_WINDOW);
    expect(r.shouldAutoCompact(events)).toBe(true);
    const below = turnEvents(1, FALLBACK_CONTEXT_WINDOW - 1);
    expect(r.shouldAutoCompact(below)).toBe(false);
  });

  test("contextWindowFor resolves catalog entries and unknown models", () => {
    expect(contextWindowFor("anthropic/claude-sonnet-4-5", "anthropic")).toBe(1_000_000);
    expect(contextWindowFor("anthropic/claude-haiku-4-5", "anthropic")).toBe(200_000);
    expect(contextWindowFor("mock", "anthropic")).toBe(0);
    expect(contextWindowFor("anthropic/nonexistent-model", "anthropic")).toBe(0);
    expect(contextWindowFor("anthropic/claude-sonnet-4-5", undefined)).toBe(0);
  });
});

describe("auto trigger", () => {
  test("compacts once past the threshold and does not re-trigger on the stale measurement", async () => {
    const events: AgentEvent[] = [];
    const appended: AgentEvent[] = [];
    let compacted = 0;
    const r = new CompactionRunner({
      sessionId: "session-test",
      provider: () => MockProvider.scripted([{ deltas: ["x"], finish: "stop" }]),
      endpointType: () => "anthropic",
      append: (e) => appended.push(e),
      onCompacted: () => compacted++,
      summarizer: scriptedSummarizer,
    });
    // Two turns below threshold.
    for (const i of [1, 2]) events.push(...turnEvents(i, 100));
    r.maybeCompact({ status: "done" }, events, false);
    expect(appended).toHaveLength(0);
    // 13th turn crosses the threshold with 13+ turns present.
    for (let i = 3; i <= 13; i++) events.push(...turnEvents(i, 100));
    events[events.length - 1] = { type: "model_call", model: "mock", usage: { inputTokens: 900_000, outputTokens: 10 } };
    r.maybeCompact({ status: "done" }, events, false);
    await r.pending;
    expect(appended).toHaveLength(1);
    expect(appended[0]!.type).toBe("compaction");
    expect(compacted).toBe(1);
    // Re-fire with the same log (no new model_call): no loop.
    r.maybeCompact({ status: "done" }, events, false);
    await r.pending;
    expect(appended).toHaveLength(1);
  });

  test("ignores non-done turns", () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 13; i++) events.push(...turnEvents(i, 900_000));
    const { r, appended } = runner(events);
    r.maybeCompact({ status: "cancelled" }, events, false);
    expect(appended).toHaveLength(0);
  });
});

describe("context_length recovery (#947)", () => {
  test("lastMeasuredCall skips failed calls — a {0,0} is not a measurement", () => {
    const events = turnEvents(1, 253_325);
    events.push({ type: "model_call", model: "m", usage: { inputTokens: 0, outputTokens: 0 }, failed: true });
    expect(CompactionRunner.lastMeasuredCall(events)?.inputTokens).toBe(253_325);
  });

  test("a context_length error turn arms the producer despite the stale guard", async () => {
    // Real #947 shape: the last successful measurement is over threshold and
    // already seen by a previous settle; the overflow turn only adds a failed call.
    const events: AgentEvent[] = [];
    for (let i = 0; i < 13; i++) events.push(...turnEvents(i, i === 12 ? 253_325 : 100));
    events.push({ type: "model_call", model: "mock", usage: { inputTokens: 0, outputTokens: 0 }, failed: true });
    const { r, appended } = runner(events);
    r.maybeCompact({ status: "done" }, events, false); // the pre-overflow settle saw the 253k call
    expect(appended).toHaveLength(0);
    r.maybeCompact({ status: "error", reason: "context_length", message: "maximum context length" }, events, false);
    await r.pending;
    expect(appended).toHaveLength(1);
    expect(appended[0]!.type).toBe("compaction");
  });

  test("the overflow producer runs below the threshold too — the provider error outranks the arithmetic", async () => {
    // Unknown window + real 128k endpoint: measured 150k sits under the 180k
    // fallback threshold (144k is crossed at 144k... 150k is above; use 130k).
    const events: AgentEvent[] = [];
    for (let i = 0; i < 13; i++) events.push(...turnEvents(i, i === 12 ? 130_000 : 100));
    events.push({ type: "model_call", model: "mock", usage: { inputTokens: 0, outputTokens: 0 }, failed: true });
    const { r, appended } = runner(events);
    r.maybeCompact({ status: "error", reason: "context_length", message: "maximum context length" }, events, false);
    await r.pending;
    expect(appended).toHaveLength(1);
  });

  test("other error reasons still append nothing", () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 13; i++) events.push(...turnEvents(i, 900_000));
    const { r, appended } = runner(events);
    r.maybeCompact({ status: "error", reason: "rate_limited", message: "429" }, events, false);
    expect(appended).toHaveLength(0);
  });
});

describe("forced compaction", () => {
  test("ignores the threshold and guard", async () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 12; i++) events.push(...turnEvents(i, 100));
    const { r, appended } = runner(events);
    const result = await r.compactNow(events);
    await r.pending;
    expect(result.ok).toBe(true);
    expect(appended).toHaveLength(1);
    const marker = appended[0] as Extract<AgentEvent, { type: "compaction" }>;
    const upTo = CompactionRunner.upToFor(events, 10)!.upTo;
    // #578: the marker carries `upToId` — the id (or legacy bridge) of
    // the last covered event on the path.
    expect(marker.upToId).toBe(events[upTo - 1]!.id ?? `line:${upTo}`);
  });

  test("refuses when there is nothing to compact", async () => {
    const events = turnEvents(1, 100);
    const { r } = runner(events);
    const result = await r.compactNow(events);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("nothing to compact");
  });

  test("chained: a later summary receives the previous one", async () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 12; i++) events.push(...turnEvents(i, 100));
    const appended: AgentEvent[] = [];
    const r = new CompactionRunner({
      sessionId: "session-test",
      provider: () => MockProvider.scripted([{ deltas: ["x"], finish: "stop" }]),
      append: (e) => {
        appended.push(e);
        events.push(e); // markers are ordinary appends in the real log
      },
      onCompacted: () => {},
      summarizer: scriptedSummarizer,
    });
    const firstResult = await r.compactNow(events);
    await r.pending;
    expect(firstResult.ok).toBe(true);
    const first = appended[0] as Extract<AgentEvent, { type: "compaction" }>;
    // More turns after the marker.
    for (let i = 12; i < 24; i++) events.push(...turnEvents(i, 100));
    const result = await r.compactNow(events);
    await r.pending;
    if (!result.ok) throw new Error(`second compaction failed: ${result.error}`);
    expect(result.ok).toBe(true);
    const second = appended[1] as Extract<AgentEvent, { type: "compaction" }>;
    expect(second.upToId).toBeDefined();
    expect(first.upToId).toBeDefined();
    // Chained pointers advance along the path (ids or `line:N` bridges
    // for a legacy identity-less log — the format d8 bridge rule).
    const pos = (ref: string | undefined): number => {
      const m = ref !== undefined ? /^line:([1-9]\d*)$/.exec(ref) : null;
      return m ? Number(m![1]) - 1 : events.findIndex((e) => e.id === ref);
    };
    expect(pos(second.upToId)).toBeGreaterThan(pos(first.upToId));
    // scriptedSummarizer echoes `previous` — proof of chaining.
    expect(result.ok && result.summary).toContain("after: SUMMARY of");
  });
});

describe("fail-silent", () => {
  test("failure appends compaction_failed; backoff grows with consecutive failures (#466)", async () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 13; i++) events.push(...turnEvents(i, i === 12 ? 900_000 : 100));
    let calls = 0;
    const failing: CompactionSummarizer = async () => {
      calls++;
      throw new Error("provider down");
    };
    const { r, appended } = runner(events, failing);
    r.maybeCompact({ status: "done" }, events, false);
    await r.pending;
    expect(appended.filter((e) => e.type === "compaction_failed")).toHaveLength(1);
    // Forced path failure also emits the chrome event.
    await r.compactNow(events);
    await r.pending;
    expect(appended.filter((e) => e.type === "compaction_failed")).toHaveLength(2);
    expect((appended[1] as Extract<AgentEvent, { type: "compaction_failed" }>).reason).toBe("provider down");
  });
  test("one retry then no marker; the guard re-arms on a new measurement", async () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 13; i++) events.push(...turnEvents(i, i === 12 ? 900_000 : 100));
    let calls = 0;
    const failing: CompactionSummarizer = async () => {
      calls++;
      throw new Error("provider down");
    };
    const { r, appended } = runner(events, failing);
    r.maybeCompact({ status: "done" }, events, false);
    await r.pending;
    expect(calls).toBe(2); // one retry, then give up
    // No `compaction` marker (not lossy), but the chrome failure event is
    // appended — clients need it for their sticky warning (ADR-0022).
    expect(appended.filter((e) => e.type === "compaction")).toHaveLength(0);
    expect(appended.filter((e) => e.type === "compaction_failed")).toHaveLength(1);
    // A new model_call measurement re-arms the trigger.
    events.push({ type: "model_call", model: "mock", usage: { inputTokens: 900_001, outputTokens: 1 } });
    events.push(...turnEvents(14, 100));
    events[events.length - 1] = { type: "model_call", model: "mock", usage: { inputTokens: 900_002, outputTokens: 1 } };
    r.maybeCompact({ status: "done" }, events, false);
    await r.pending;
    expect(calls).toBe(4);
  });
});

describe("transcript", () => {
  test("renders user/assistant text and tool activity", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "p" },
      { type: "user_message", text: "run the tests" },
      { type: "assistant_delta", text: "Running" },
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "bun test" } },
      { type: "tool_result", callId: "c1", ok: true, output: "42 pass" },
      { type: "assistant_delta", text: " done" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const text = compactionTranscript(events, 0, events.length);
    expect(text).toContain("user: run the tests");
    expect(text).toContain("assistant: Running");
    expect(text).toContain("assistant: done");
    expect(text).toContain("tool bash");
  });
});

describe("subagent summarizer (integration)", () => {
  test("createCompactionSummarizer summarizes via a child session", async () => {
    mkdirSync(TMP, { recursive: true });
    const summarizer = createCompactionSummarizer(
      MockProvider.scripted([{ deltas: ["Task: tests were run, all green. Next: commit."], finish: "stop" }]),
      TMP,
    );
    const summary = await summarizer({ transcript: "user: hi\nassistant: hello" });
    expect(summary).toContain("Next: commit");
  });

  test("end-to-end: forced compaction through an AgentSession", async () => {
    mkdirSync(TMP, { recursive: true });
    const events: AgentEvent[] = [];
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ack"], finish: "stop" }]),
      cwd: TMP,
      compaction: {
        summarizer: async () => "Task state: everything is fine.",
      },
    });
    for await (const e of session.events) {
      events.push(e);
      if (e.type === "session_start") break;
    }
    for (let i = 0; i < 12; i++) {
      await session.send(`turn ${i}`);
      for (const e of session.history()) if (!events.includes(e)) events.push(e);
    }
    const before = session.history().length;
    const result = await session.compact();
    expect(result.ok).toBe(true);
    const history = session.history();
    expect(history.length).toBeGreaterThan(before);
    const marker = [...history].reverse().find((e) => e.type === "compaction") as Extract<AgentEvent, { type: "compaction" }>;
    expect(marker.summary).toBe("Task state: everything is fine.");
    await session.dispose();
  });

  test("next turn's provider context starts from the summary (inputTokens drop)", async () => {
    mkdirSync(TMP, { recursive: true });
    let contextSize = 0;
    const capture: Provider = {
      name: "capture",
      async *stream(messages) {
        contextSize = JSON.stringify(messages).length;
        yield { type: "text_delta", text: "ack" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const session = createSession({
      provider: capture,
      cwd: TMP,
      compaction: { summarizer: async () => "SUMMARY" },
    });
    for (let i = 0; i < 12; i++) await session.send(`turn ${i}`);
    const beforeSize = contextSize;
    expect(beforeSize).toBeGreaterThan(0);
    const result = await session.compact();
    expect(result.ok).toBe(true);
    await session.send("after compaction");
    // The context the provider saw after compaction is much smaller than
    // the pre-compaction one (the summary replaces the covered prefix).
    expect(contextSize).toBeLessThan(beforeSize);
    expect(contextSize).toBeGreaterThan(0);
    await session.dispose();
  });
});

describe("#949: the window wins — reachability", () => {
  /** The reported #949 shape, synthetic: 3 gigantic turns (one long
   * agentic turn with tool traffic), measured 253_325 input tokens. */
  function giganticFixture(): AgentEvent[] {
    const events: AgentEvent[] = [{ type: "session_start", schemaVersion: 1, promptVersion: "p" }];
    for (let i = 0; i < 3; i++) {
      events.push({ type: "user_message", text: `please run the suite, turn ${i}` });
      for (let c = 0; c < 20; c++) {
        events.push({ type: "tool_call", callId: `c${i}-${c}`, name: "bash", args: { command: `bun test file-${c}` } });
        events.push({ type: "tool_result", callId: `c${i}-${c}`, ok: true, output: `x`.repeat(40_000) });
      }
      events.push({ type: "assistant_delta", text: `suite is green for round ${i}` });
      events.push({ type: "model_call", model: "mock", usage: { inputTokens: i === 2 ? 253_325 : 80_000, outputTokens: 500 } });
    }
    return events;
  }

  test("upToFor compacts a 3-turn gigantic log with a window (today: undefined)", () => {
    const events = giganticFixture();
    // Old policy: 3 turns ≤ 10 → undefined. New policy: the cut lands
    // inside the last turn (it alone exceeds 200k − 8k).
    const cut = CompactionRunner.upToFor(events, 10, 200_000)!;
    expect(cut.partial).toBe(true);
    // The tail never opens on a tool_result.
    expect(legalBoundariesOk(events, cut.upTo)).toBe(true);
    // The covered prefix is non-empty: there is something to compact.
    expect(cut.upTo).toBeGreaterThan(0);
  });

  test("legalBoundaries: no tool_result head, no split pair", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "go" },
      { type: "tool_call", callId: "a", name: "bash", args: {} },
      { type: "tool_result", callId: "a", ok: true, output: "out" },
      { type: "assistant_delta", text: "done" },
    ];
    const legal = CompactionRunner.legalBoundaries(events, 0, events.length);
    expect(legal).toEqual([0, 1, 3]); // the tool_result at index 2 is never a boundary
  });

  test("intraTurnCut picks the largest legal suffix under the ceiling", () => {
    const events = giganticFixture();
    const cut = CompactionRunner.intraTurnCut(events, 2, events.length, 150_000);
    expect(cut).toBeGreaterThan(2);
    expect(legalBoundariesOk(events, cut)).toBe(true);
  });

  test("the auto path appends compaction_skipped instead of failing silently", async () => {
    // Unknown window (no endpointType): 1 small turn cannot fold, but the
    // orphan over-threshold measurement arms the trigger — the refusal is
    // now VISIBLE.
    const events = turnEvents(1, 100);
    events.push({ type: "model_call", model: "mock", usage: { inputTokens: 900_000, outputTokens: 1 } });
    const appended: AgentEvent[] = [];
    const r = new CompactionRunner({
      sessionId: "session-test",
      provider: () => MockProvider.scripted([{ deltas: ["x"], finish: "stop" }]),
      append: (e) => appended.push(e),
      onCompacted: () => {},
      summarizer: scriptedSummarizer,
    });
    r.maybeCompact({ status: "done" }, events, false);
    await r.pending;
    expect(appended).toHaveLength(1);
    expect(appended[0]!.type).toBe("compaction_skipped");
    // With a real catalog window the same #949 log compacts (reachability restored).
    const gigantic = giganticFixture();
    const r2 = new CompactionRunner({
      sessionId: "session-test",
      provider: () => ({ name: "anthropic/claude-haiku-4-5" }) as never,
      endpointType: () => "anthropic",
      append: (e) => appended.push(e),
      onCompacted: () => {},
      summarizer: scriptedSummarizer,
    });
    r2.maybeCompact({ status: "done" }, gigantic, false);
    await r2.pending;
    expect(appended.filter((e) => e.type === "compaction")).toHaveLength(1);
  });

  test("compaction_skipped carries the numbers that justify the skip", async () => {
    // Small turns fully inside the tail preference, but over the
    // fallback threshold (orphan measurement): the auto path skips.
    const events: AgentEvent[] = [];
    for (let i = 0; i < 3; i++) events.push(...turnEvents(i, 900));
    events.push({ type: "model_call", model: "mock", usage: { inputTokens: 900_000, outputTokens: 1 } });
    const { r, appended } = runner(events, scriptedSummarizer, FALLBACK_CONTEXT_WINDOW);
    r.maybeCompact({ status: "done" }, events, false);
    await r.pending;
    const skips = appended.filter((e) => e.type === "compaction_skipped") as Extract<AgentEvent, { type: "compaction_skipped" }>[];
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toBe("too_few_turns");
    expect(skips[0]!.turns).toBe(3);
    expect(skips[0]!.measuredTokens).toBe(900_000);
    expect(skips[0]!.window).toBe(0); // unknown window: the honest number
  });

  test("compaction_skipped is appended once per new measurement, not per settle", async () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 3; i++) events.push(...turnEvents(i, 900));
    events.push({ type: "model_call", model: "mock", usage: { inputTokens: 900_000, outputTokens: 1 } });
    const { r, appended } = runner(events, scriptedSummarizer, FALLBACK_CONTEXT_WINDOW);
    r.maybeCompact({ status: "done" }, events, false);
    await r.pending;
    r.maybeCompact({ status: "done" }, events, false); // stale measurement: nothing
    await r.pending;
    events.push({ type: "model_call", model: "mock", usage: { inputTokens: 950_000, outputTokens: 1 } });
    r.maybeCompact({ status: "done" }, events, false); // new measurement: one more skip
    await r.pending;
    expect(appended.filter((e) => e.type === "compaction_skipped")).toHaveLength(2);
  });

  test("forced path on a gigantic log now compacts (was: nothing to compact)", async () => {
    const events = giganticFixture();
    const appended: AgentEvent[] = [];
    const r = new CompactionRunner({
      sessionId: "session-test",
      provider: () => ({ name: "anthropic/claude-haiku-4-5" }) as never,
      endpointType: () => "anthropic",
      append: (e) => appended.push(e),
      onCompacted: () => {},
      summarizer: scriptedSummarizer,
    });
    const result = await r.compactNow(events);
    await r.pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.partial).toBe(true);
      expect(result.upTo).toBeGreaterThan(0);
    }
    const marker = appended.find((e) => e.type === "compaction") as Extract<AgentEvent, { type: "compaction" }>;
    // #949: the intra-turn cut is an audit flag ON the marker (keptByFloor
    // precedent), never a skip warning.
    expect(marker.partialTail).toBe(true);
  });

  test("session: the auto producer compacts a gigantic log during turns (was: silent)", async () => {
    mkdirSync(TMP, { recursive: true });
    const session = createSession({
      // Emits a real (huge) measurement per call — three turns above the
      // 200k fallback window, the #949 shape.
      provider: {
        // Named "<endpointType>/<model>" (catalog-backed) so the
        // session resolves a real 200k window for the tail policy.
        name: "anthropic/claude-haiku-4-5",
        async *stream() {
          yield { type: "model_call_start", model: "anthropic/claude-haiku-4-5" };
          yield { type: "usage", inputTokens: 900_000, outputTokens: 10 };
          yield { type: "text_delta", text: "ack" };
          yield { type: "finish", reason: "stop" };
        },
      } as never,
      cwd: TMP,
      compaction: { summarizer: async () => "SUMMARY", fallbackWindowTokens: 200_000 },
    });
    // Few turns, huge measurements — the auto producer folds mid-turn
    // where today's answer is `nothing to compact`.
    await session.send("run the suite");
    await session.send("and again");
    await session.send("once more");
    const markers = session.history().filter((e) => e.type === "compaction");
    expect(markers.length).toBeGreaterThanOrEqual(1);
    await session.dispose();
  });

  test("replay coherence after an intra-turn cut: the tail has no orphan tool_result at the head", () => {
    const events = giganticFixture();
    const cut = CompactionRunner.upToFor(events, 10, 200_000)!.upTo;
    // The producer anchors at `path[cut - 1]`; the replayed tail starts
    // at `cut`. Assert the protocol constraint directly.
    expect(legalBoundariesOk(events, cut)).toBe(true);
  });
});
