import { readFileSync } from "node:fs";
import { ProviderError } from "./types";
import type { FinishReason, Message, Provider, ProviderErrorKind, StreamEvent } from "./types";

export interface MockToolCall {
  callId?: string;
  name: string;
  args: unknown;
}

/** A typed error injected at a chosen point of the turn (issue #28). */
export interface MockError {
  kind: ProviderErrorKind;
  message: string;
  /** How many deltas to emit before throwing. Default 0 (fail before streaming). */
  afterDeltas?: number;
}

export interface MockTurnScript {
  deltas: string[];
  finish: FinishReason;
  /** Delay before each delta, to simulate streaming and enable abort tests. */
  deltaDelayMs?: number;
  /** Tool calls emitted before finish when finish is "tool_calls". */
  toolCalls?: MockToolCall[];
  /** Fail the turn with a typed ProviderError (fallback-chain tests). */
  error?: MockError;
  /** Usage tokens emitted before finish (subagent result events, #13). */
  usage?: { inputTokens: number; outputTokens: number };
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

  /** Loads versioned JSON cassettes (arrays of MockTurnScript) for deterministic tests. */
  static cassette(file: string): MockProvider {
    return MockProvider.scripted(JSON.parse(readFileSync(file, "utf8")) as MockTurnScript[]);
  }

  /** Zero-credential demo provider: `provider: "mock"` in moh.json or createSession. */
  static demo(): MockProvider {
    return MockProvider.scripted([
      {
        deltas: [
          "Hello from moh's mock provider. No credentials are configured, so this is a canned reply. ",
          "Run `moh provider add` to connect a real endpoint.",
        ],
        finish: "stop",
      },
    ]);
  }

  async *stream(_messages: Message[], signal: AbortSignal): AsyncIterable<StreamEvent> {
    const turn = this.#turns[Math.min(this.#call, this.#turns.length - 1)];
    this.#call += 1;
    let emitted = 0;
    const failAt = turn.error?.afterDeltas ?? 0;
    for (const text of turn.deltas) {
      if (signal.aborted) return;
      if (turn.deltaDelayMs) await Bun.sleep(turn.deltaDelayMs);
      if (turn.error && emitted === failAt) {
        throw new ProviderError(turn.error.kind, turn.error.message);
      }
      emitted += 1;
      yield { type: "text_delta", text };
    }
    if (turn.error) {
      throw new ProviderError(turn.error.kind, turn.error.message);
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
    if (turn.usage) {
      yield { type: "usage", inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens };
    }
    yield { type: "finish", reason: turn.finish };
  }
}
