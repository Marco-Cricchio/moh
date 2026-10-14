/**
 * S0.1/B2 recording provider: the `MockProvider.scripted` turn format plus
 * a log of every `stream()` call (deep-copied messages, tool specs,
 * options). Deterministic: call order is the log order.
 */
import { MockProvider } from "@moh/core";
import type { Message, Provider, StreamEvent, StreamOptions, ToolSpec } from "../../packages/core/src/types";

/** The scripted-turn format of `MockProvider.scripted` (not re-exported by
 * the package index — structural copy; the recording provider only reads
 * the fields the mock consumes). */
export type MockTurnScript = Parameters<typeof MockProvider.scripted>[0][number];

export interface RecordedCall {
  messages: Message[];
  tools: ToolSpec[];
  options: StreamOptions | undefined;
}

export class RecordingProvider implements Provider {
  readonly name: string;
  readonly #inner: Provider;
  readonly #calls: RecordedCall[] = [];

  private constructor(inner: Provider, name: string) {
    this.#inner = inner;
    this.name = name;
  }

  static scripted(turns: MockTurnScript[], name = "recording"): RecordingProvider {    return new RecordingProvider(MockProvider.scripted(turns), name);
  }

  /** Wraps any provider (e.g. a `createRoute` fallback chain). */
  static around(inner: Provider, name = "route"): RecordingProvider {
    return new RecordingProvider(inner, name);
  }

  get recorded(): readonly RecordedCall[] {
    return this.#calls;
  }

  async *stream(
    messages: Message[],
    signal: AbortSignal,
    tools?: readonly ToolSpec[],
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    this.#calls.push({
      messages: structuredClone(messages),
      tools: tools ? structuredClone([...tools]) : [],
      options: options ? structuredClone(options) : undefined,
    });
    yield* this.#inner.stream(messages, signal, tools, options);
  }
}
