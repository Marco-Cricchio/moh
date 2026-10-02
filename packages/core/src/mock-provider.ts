import { readFileSync } from "node:fs";
import { ProviderError } from "./types";
import { recognizeDeclaredWindow } from "./declared-window";
import type { FinishReason, Message, Provider, ProviderErrorKind, StreamEvent, StreamOptions, ToolSpec } from "./types";

/** Resolves when the signal aborts — so a #1061 hold cannot pin a stream
 * past cancellation (#1127): the hold is a test gate, never a jail. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export interface MockToolCall {
  callId?: string;
  name: string;
  args: unknown;
}

/** A typed error injected at a chosen point of the turn (issue #28). */
export interface MockError {
  kind: ProviderErrorKind;
  message: string;
  /** ADR-0049 (#986): a window the message declares, when moh would read
   * one out of it. Unset means "let the message speak": the MockProvider
   * normalizes its own message exactly as a real provider's error path
   * does (`recognizeDeclaredWindow`), so a cassette can exercise the
   * declared-window door end to end. */
  declaredWindow?: number;
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
  /** #240: provider reasoning emitted before the text deltas. */
  reasoning?: { deltas: string[]; continuation?: Record<string, unknown> };
  /**
   * #1061: hold the turn open at a chosen delta until the test releases it.
   * `afterDeltas` counts text deltas (0 = before the first one), and the
   * provider awaits `release` before emitting delta `afterDeltas`. This
   * gives a mid-stream oracle a **deterministic instant** — "everything up
   * to this delta is painted, nothing past it is" — instead of sampling on
   * a wall clock, which is what made the old PTY tests flaky (#1052).
   */
  hold?: { afterDeltas: number; release: Promise<void> };
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

  async *stream(_messages: Message[], signal: AbortSignal, _tools?: readonly ToolSpec[], options?: StreamOptions): AsyncIterable<StreamEvent> {
    const turn = this.#turns[Math.min(this.#call, this.#turns.length - 1)];
    this.#call += 1;
    // Announce the (notional) model serving this call (#83) and echo the
    // requested thinking level as the effective one (#240 audit).
    yield { type: "model_call_start", model: "mock", ...(options?.thinking ? { thinkingLevel: options.thinking.level } : {}) };
    if (turn.reasoning) {
      yield { type: "reasoning_start" };
      for (const text of turn.reasoning.deltas) {
        if (signal.aborted) return;
        if (turn.deltaDelayMs) await Bun.sleep(turn.deltaDelayMs);
        yield { type: "reasoning_delta", text };
      }
      yield { type: "reasoning_end", ...(turn.reasoning.continuation ? { continuation: turn.reasoning.continuation } : {}) };
    }
    let emitted = 0;
    const failAt = turn.error?.afterDeltas ?? 0;
    for (const text of turn.deltas) {
      if (signal.aborted) return;
      if (turn.deltaDelayMs) await Bun.sleep(turn.deltaDelayMs);
      // #1061: the mid-turn hold — awaited BEFORE the delta it gates, so a
      // test can assert the frame at a deterministic instant with the turn
      // still open (the last delta before the hold is painted, this one and
      // everything after are not). #1127: an abort during the hold ends the
      // wait (the hold is a test gate, never a way to pin the stream past
      // cancellation).
      if (turn.hold && emitted === turn.hold.afterDeltas) {
        await Promise.race([turn.hold.release, aborted(signal)]);
      }
      if (signal.aborted) return;
      if (turn.error && emitted === failAt) {
        throw new ProviderError(
          turn.error.kind,
          turn.error.message,
          turn.error.declaredWindow ?? recognizeDeclaredWindow(turn.error.message),
        );
      }
      emitted += 1;
      yield { type: "text_delta", text };
    }
    if (turn.error) {
      // ADR-0049: a real provider's error text is normalized before the
      // core sees it; the mock does the same, so its scripted refusals
      // teach a declared window exactly like a live one.
      throw new ProviderError(
        turn.error.kind,
        turn.error.message,
        turn.error.declaredWindow ?? recognizeDeclaredWindow(turn.error.message),
      );
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
