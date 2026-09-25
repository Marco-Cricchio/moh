import { describe, expect, it } from "bun:test";
import { createSession, EMPTY_REASONING_PARTS, foldReasoningParts, foldReasoningText, reasoningPartsText, type AgentEvent, type Provider, type ReasoningParts, type ReasoningStreamEvent } from "../src/index";
import type { StreamEvent } from "../src/types";

/** #993: the reasoning lifecycle's fold is the channel's contract, and the
 * log and every live consumer must apply the same one. These tests bind the
 * exported fold to what the loop actually persists, over hand-written and
 * randomized lifecycle shapes — so a provider is free to announce a part per
 * stream chunk, emit empty parts, or never announce at all, and the two
 * sides cannot drift. */

/** Runs one lifecycle through a real session and returns the persisted
 * reasoning block texts (the settled projection's source of truth). */
async function persist(events: readonly ReasoningStreamEvent[]): Promise<string[]> {
  const logged: AgentEvent[] = [];
  const provider: Provider = {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "model_call_start", model: "scripted" };
      for (const event of events) yield event as StreamEvent;
      yield { type: "text_delta", text: "answer" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const session = createSession({ provider, sink: (event) => logged.push(event), memory: { enabled: false } });
  await session.send("hi");
  return logged.filter((event): event is AgentEvent & { type: "reasoning"; text: string } => event.type === "reasoning").map((event) => event.text);
}

function fold(events: readonly ReasoningStreamEvent[]): ReasoningParts {
  let state = EMPTY_REASONING_PARTS;
  for (const event of events) state = foldReasoningParts(state, event);
  return state;
}

const start = { type: "reasoning_start" } as const;
const delta = (text: string): ReasoningStreamEvent => ({ type: "reasoning_delta", text });
const end = (continuation?: Record<string, unknown>): ReasoningStreamEvent => ({ type: "reasoning_end", ...(continuation ? { continuation } : {}) });

const SHAPES: Record<string, ReasoningStreamEvent[]> = {
  "one part": [start, delta("a thought"), end()],
  "several parts": [start, delta("first"), end(), start, delta("second"), end()],
  // The shape a real provider produced: a part announced per stream chunk,
  // most of them carrying nothing (measured: 637 starts for one call).
  "start per chunk, empties interleaved": [start, delta(""), start, delta("word "), end(), start, delta(""), start, delta(""), start, delta("word two"), end()],
  "only empty parts": [start, delta(""), start, delta(""), start, end()],
  "leading empty part": [start, delta(""), end(), start, delta("text"), end()],
  "trailing empty part": [start, delta("text"), end(), start, delta(""), end()],
  "newline-only part": [start, delta("\n\n"), end(), start, delta("text"), end()],
  "text with a blank line": [start, delta("para one\n\npara two"), end()],
  "text ending in a blank line": [start, delta("text\n\n"), end(), start, delta("more"), end()],
  "deltas without a start": [delta("no start"), delta(" here"), end()],
  "end without a start": [end(), start, delta("after"), end()],
  "start with an open part (unterminated text is dropped)": [start, delta("dropped"), start, delta("kept"), end()],
  "continuation metadata on the end": [start, delta("signed"), end({ signature: "opaque" })],
  "no reasoning at all": [delta(""), end()],
};

describe("reasoning lifecycle fold (#993)", () => {
  it("drops empty parts and joins kept ones with one blank line", () => {
    expect(foldReasoningText([start, delta("a"), end(), start, delta(""), end(), start, delta("b"), end()])).toBe("a\n\nb");
    expect(foldReasoningText([start, delta(""), end(), start, delta(""), end()])).toBe("");
    expect(foldReasoningText([start, delta("solo"), end()]).replace("solo", "x")).toBe("x");
  });

  it("keeps a part open until the end that closes it", () => {
    let state = foldReasoningParts(EMPTY_REASONING_PARTS, start);
    state = foldReasoningParts(state, delta("streaming"));
    expect(reasoningPartsText(state)).toBe("streaming");
    expect(state.parts).toEqual([]);
    state = foldReasoningParts(state, end());
    expect(reasoningPartsText(state)).toBe("streaming");
    expect(state.parts).toEqual(["streaming"]);
  });

  it("ignores unrelated lifecycle events (tool progress rides the same channel)", () => {
    const state = foldReasoningParts({ parts: ["a"], open: "b" }, { type: "tool_progress", callId: "c", tool: "bash", chunk: "out" });
    expect(state).toEqual({ parts: ["a"], open: "b" });
  });

  for (const [name, events] of Object.entries(SHAPES)) {
    it(`matches what the log persists — ${name}`, async () => {
      const persisted = await persist(events);
      const state = fold(events);
      // The fold's closed parts ARE the persisted blocks: same order, same
      // texts, empties dropped on both sides.
      expect([...state.parts]).toEqual(persisted);
      // The live text is exactly the persisted blocks plus the part still
      // open — one separator between them, never one per announced part.
      // (An unterminated part is visible while it streams and dropped when
      // the call settles: the log keeps only what `reasoning_end` closed.)
      const expected = [...persisted, ...(state.open ? [state.open] : [])].join("\n\n");
      expect(foldReasoningText(events)).toBe(expected);
    });
  }

  it("an unterminated part is visible live and dropped by the settled log", async () => {
    const events = [start, delta("never closed")];
    expect(foldReasoningText(events)).toBe("never closed");
    expect(await persist(events)).toEqual([]);
  });

  it("every prefix of a well-formed lifecycle is a prefix of the settled text", async () => {
    const events = [
      start, delta("one "), delta("part"), end(),
      start, delta(""), end(),
      start, delta("two"), delta("\n\n"), delta("paragraphs"), end(),
      start, delta("three"), end(),
    ];
    const persisted = await persist(events);
    const settled = persisted.join("\n\n");
    for (let i = 1; i <= events.length; i++) {
      const partial = foldReasoningText(events.slice(0, i));
      expect(settled.startsWith(partial)).toBe(true);
    }
  });

  it("random lifecycle shapes stay bound to the log", async () => {
    // Deterministic PRNG: the fuzz must reproduce a failure identically.
    let seed = 0x984n;
    const rand = () => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      return Number(seed >> 33n) / 2 ** 31;
    };
    const vocabulary: Array<() => ReasoningStreamEvent> = [
      () => start,
      () => end(),
      () => delta(""),
      () => delta("word "),
      () => delta("\n"),
      () => delta("\n\n"),
      () => delta("tail\n\n"),
      () => delta(" more"),
    ];
    const failures: string[] = [];
    for (let round = 0; round < 120; round++) {
      const events = Array.from({ length: 1 + Math.floor(rand() * 24) }, () => vocabulary[Math.floor(rand() * vocabulary.length)]!());
      const persisted = await persist(events);
      const state = fold(events);
      const expected = [...persisted, ...(state.open ? [state.open] : [])].join("\n\n");
      if (JSON.stringify(state.parts) !== JSON.stringify(persisted) || foldReasoningText(events) !== expected) {
        failures.push(`${JSON.stringify(events)} → fold ${JSON.stringify(state.parts)} vs log ${JSON.stringify(persisted)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 30_000);
});
