import type { FinishReason, Message, Provider, StreamEvent } from "./types";

export interface MockToolCall {
  callId?: string;
  name: string;
  args: unknown;
}

export interface MockTurnScript {
  deltas: string[];
  finish: FinishReason;
  /** Delay before each delta, to simulate streaming and enable abort tests. */
  deltaDelayMs?: number;
  /** Tool calls emitted before finish when finish is "tool_calls". */
  toolCalls?: MockToolCall[];
}

export class MockProvider implements Provider {
  readonly name = "mock";
  #turns: MockTurnScript[];
  #call = 0;
  #nextCallId = 0;

  private constructor(turns: MockTurnScript[]) {
    this.#turns = turns;
  }

  /**
   * Builds a MockProvider from a list of scripted turns, consumed in order.
   * The last turn repeats once the script is exhausted, so short scripts
   * (or single-entry ones) keep working across many calls.
   */
  static scripted(turns: MockTurnScript[]): MockProvider {
    if (turns.length === 0) throw new Error("MockProvider needs at least one scripted turn");
    return new MockProvider(turns);
  }

  async *stream(_messages: Message[], signal: AbortSignal): AsyncIterable<StreamEvent> {
    const turn = this.#turns[Math.min(this.#call, this.#turns.length - 1)];
    this.#call += 1;
    for (const text of turn.deltas) {
      if (signal.aborted) return;
      if (turn.deltaDelayMs) await Bun.sleep(turn.deltaDelayMs);
      yield { type: "text_delta", text };
    }
    if (turn.finish === "tool_calls") {
      yield {
        type: "tool_calls",
        calls: (turn.toolCalls ?? []).map((c) => ({
          callId: c.callId ?? `mock-${this.#nextCallId++}`,
          name: c.name,
          args: c.args,
        })),
      };
    }
    yield { type: "finish", reason: turn.finish };
  }
}
