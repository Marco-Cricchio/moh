/**
 * Shared test doubles for the #1101 telemetry tests — the same
 * one-shot-provider shape the attempt-telemetry tests use, plus small
 * event factories for the pure projections.
 */
import { createSession } from "../src/index";
import type { AgentEvent, AttemptTelemetry, Message, StreamEvent } from "../src/types";

export function providerOf(name: string, stream: (signal: AbortSignal) => AsyncGenerator<StreamEvent>) {
  return {
    name,
    async *stream(_messages: Message[], signal: AbortSignal): AsyncGenerator<StreamEvent> {
      yield* stream(signal);
    },
  };
}

export function sessionOf(provider?: ReturnType<typeof providerOf> | ((signal: AbortSignal) => AsyncGenerator<StreamEvent>)) {
  const p = typeof provider === "function"
    ? providerOf("gw/auto", provider)
    : provider ?? providerOf("gw/auto", async function* () {
    yield { type: "model_call_start", model: "gw/auto" };
    yield { type: "usage", inputTokens: 10, outputTokens: 5, provenance: "provider" };
    yield { type: "text_delta", text: "ok" };
    yield { type: "finish", reason: "stop" };
  });
  const session = createSession({ provider: p as never, tools: {} });
  void (async () => {
    for await (const _ of session.events) void _;
  })();
  return session;
}

/** A one-turn provider whose streamed text is the given content — used to
 * assert that prompt/completion text never reaches the projections. */
export function textCallEvents(content = "ok"): (signal: AbortSignal) => AsyncGenerator<StreamEvent> {
  return async function* () {
    yield { type: "model_call_start", model: "gw/auto" };
    yield { type: "usage", inputTokens: 10, outputTokens: 5, provenance: "provider" };
    yield { type: "text_delta", text: content };
    yield { type: "finish", reason: "stop" };
  };
}

export const modelCallOf = (
  model: string,
  attempt: Partial<AttemptTelemetry> & { outcome: AttemptTelemetry["outcome"]; durationMs: number },
): AgentEvent => ({
  type: "model_call",
  model,
  usage: { inputTokens: 10, outputTokens: 5 },
  usageProvenance: "provider",
  failed: attempt.outcome !== "completed",
  attempt: {
    callId: attempt.callId ?? newCallId(),
    attemptId: attempt.attemptId ?? `a-${Math.random().toString(36).slice(2)}`,
    turnId: attempt.turnId ?? "t1",
    retryIndex: attempt.retryIndex ?? 0,
    chainIndex: attempt.chainIndex ?? 0,
    selectedModel: attempt.selectedModel ?? model,
    servingModel: model,
    endpoint: attempt.endpoint ?? { kind: "test" },
    startedAt: attempt.startedAt ?? "2026-01-01T00:00:00.000Z",
    endedAt: attempt.endedAt ?? "2026-01-01T00:00:01.000Z",
    durationMs: attempt.durationMs,
    outcome: attempt.outcome,
    ...(attempt.errorKind !== undefined ? { errorKind: attempt.errorKind } : {}),
    ...(attempt.ttfcMs !== undefined ? { ttfcMs: attempt.ttfcMs } : {}),
    consumedUsage: attempt.consumedUsage ?? true,
    pricingVersion: "test",
  },
} as AgentEvent);

let callCounter = 0;
function newCallId(): string {
  return `call-${++callCounter}`;
}
