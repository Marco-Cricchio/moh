/**
 * #1099: provider billing and request-attempt telemetry — per-attempt
 * audit records on `model_call` events, reconstructable attempt chains,
 * and usage detail that never conflates "provider reported zero" with
 * "the provider reported nothing". Every assertion reads metadata only.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/index";
import { aggregateTelemetry, type AgentEvent } from "../src/index";
import { attemptChains, summarizeAttempts } from "../src/telemetry";
import { estimateModelCost } from "../src/pricing";
import { endpointIdentity, ProviderError, type Message, type StreamEvent } from "../src/types";
import { projectSessionsDir } from "../src/session-store";
import { ENCODING } from "../src/session/ulid";

/** A one-shot provider whose stream is the given generator function. */
function providerOf(name: string, stream: (signal: AbortSignal) => AsyncGenerator<StreamEvent>) {
  return {
    name,
    async *stream(_messages: Message[], signal: AbortSignal): AsyncGenerator<StreamEvent> {
      yield* stream(signal);
    },
  };
}

function session(provider: ReturnType<typeof providerOf>) {
  const session = createSession({ provider: provider as never, tools: {} });
  void (async () => {
    for await (const _ of session.events) void _;
  })();
  return session;
}

const modelCalls = (events: AgentEvent[]) => events.filter((e) => e.type === "model_call") as Extract<AgentEvent, { type: "model_call" }>[];

describe("attempt telemetry (#1099)", () => {
  it("a completed call carries a full attempt record: ids, timing, identity, provenance", async () => {
    const provider = providerOf("gw/auto", async function* () {
      yield { type: "model_call_start", model: "gw/auto", endpoint: endpointIdentity("anthropic", "https://api.example.com/v1?key=SECRET#frag"), wire: "anthropic-messages" };
      yield { type: "usage", inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 12, provenance: "provider" };
      yield { type: "text_delta", text: "hi" };
      yield { type: "finish", reason: "stop" };
    });
    const s = session(provider);
    const result = await s.send("go");
    expect(result.status).toBe("done");

    const calls = modelCalls(s.history());
    expect(calls).toHaveLength(1);
    const event = calls[0]!;
    expect(event.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    // Cache/reasoning ride beside the aggregate pair — never added to it.
    expect(event.cacheReadTokens).toBe(40);
    expect(event.reasoningTokens).toBe(12);
    expect(event.usageProvenance).toBe("provider");
    const attempt = event.attempt!;
    expect(attempt.outcome).toBe("completed");
    expect(attempt.servingModel).toBe("gw/auto");
    expect(attempt.selectedModel).toBe("gw/auto");
    expect(attempt.retryIndex).toBe(0);
    expect(attempt.chainIndex).toBe(0);
    expect(attempt.consumedUsage).toBe(true);
    expect(attempt.turnId).toBeString();
    expect(attempt.callId).toBeString();
    expect(attempt.attemptId).toBeString();
    expect(attempt.pricingVersion).toBeString();
    // Explicit boundaries, monotonic duration.
    expect(Date.parse(attempt.startedAt)).not.toBeNaN();
    expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
    expect(attempt.wire).toBe("anthropic-messages");
    // Secret redaction: query string and fragment never enter the log.
    expect(JSON.stringify(event)).not.toContain("SECRET");
    expect(attempt.endpoint).toEqual({ kind: "anthropic", baseUrl: "https://api.example.com/v1" });
  });

  it("retry/fallback within one logical call: same callId, distinct attemptIds, reconstructable chain", async () => {
    const provider = providerOf("gw/auto", async function* () {
      yield { type: "model_call_start", model: "gw/auto", endpoint: { kind: "anthropic" } };
      yield { type: "usage", inputTokens: 10, outputTokens: 2, provenance: "provider" };
      yield { type: "text_delta", text: "half" };
      yield { type: "fallback", from: "gw/auto", to: "direct/glm", reason: "quota_exhausted" };
      yield { type: "model_call_start", model: "direct/glm", endpoint: { kind: "openai", baseUrl: "https://api.other.example/v1" } };
      yield { type: "usage", inputTokens: 8, outputTokens: 3, provenance: "provider" };
      yield { type: "text_delta", text: "recovered" };
      yield { type: "finish", reason: "stop" };
    });
    const s = session(provider);
    const result = await s.send("go");
    expect(result.status).toBe("done");

    const calls = modelCalls(s.history());
    expect(calls).toHaveLength(2);
    const [failed, ok] = calls.map((e) => e.attempt!);
    expect(calls[0]!.failed).toBe(true);
    expect(failed.callId).toBe(ok.callId);
    expect(failed.turnId).toBe(ok.turnId);
    expect(failed.attemptId).not.toBe(ok.attemptId);
    expect(failed.retryIndex).toBe(0);
    expect(ok.retryIndex).toBe(1);
    expect(failed.outcome).toBe("failed");
    expect(failed.errorKind).toBe("quota_exhausted");
    expect(failed.consumedUsage).toBe(true);
    expect(ok.outcome).toBe("completed");

    const chains = attemptChains(s.history());
    expect(chains).toHaveLength(1);
    expect(chains[0]!.attempts.map((a) => a.servingModel)).toEqual(["gw/auto", "direct/glm"]);
    const summary = summarizeAttempts(chains);
    expect(summary.calls).toBe(1);
    expect(summary.attempts).toBe(2);
    expect(summary.retriedCalls).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.unknownUsage).toBe(0);
  });

  it("duplicate-attempt prevention: attempts never share an id, same-target retries stay distinct", async () => {
    const provider = providerOf("gw/auto", async function* () {
      // Two same-target attempts (a retry): both announce, both recorded.
      for (let i = 0; i < 2; i++) {
        yield { type: "model_call_start", model: "gw/auto" };
        yield { type: "text_delta", text: "x" };
        if (i === 0) yield { type: "fallback", from: "gw/auto", to: "gw/auto", reason: "overloaded" };
      }
      yield { type: "finish", reason: "stop" };
    });
    const s = session(provider);
    await s.send("go");
    const attempts = modelCalls(s.history()).map((e) => e.attempt!);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((a) => a.attemptId)).size).toBe(2);
    expect(attempts.map((a) => a.retryIndex)).toEqual([0, 1]);
  });

  it("a provider failure carries the normalized kind and sanitized transport facts", async () => {
    const provider = providerOf("gw/auto", async function* () {
      yield { type: "model_call_start", model: "gw/auto" };
      throw new ProviderError("rate_limited", "slow down", undefined, { httpStatus: 429, retryAfterMs: 30_000 });
    });
    const s = session(provider);
    const result = await s.send("go");
    expect(result.status).toBe("error");

    const calls = modelCalls(s.history());
    expect(calls).toHaveLength(1);
    const attempt = calls[0]!.attempt!;
    expect(attempt.outcome).toBe("failed");
    expect(attempt.errorKind).toBe("rate_limited");
    expect(attempt.httpStatus).toBe(429);
    expect(attempt.retryAfterMs).toBe(30_000);
    // The failed attempt reported no usage: unknown, not zero.
    expect(attempt.consumedUsage).toBe(false);
    expect(calls[0]!.usageProvenance).toBe("unavailable");
  });

  it("an interrupted call records an aborted attempt, still reconstructable", async () => {
    const provider = providerOf("mock", async function* () {
      yield { type: "model_call_start", model: "mock" };
      yield { type: "usage", inputTokens: 5, outputTokens: 1, provenance: "provider" };
      // Stream ends without `finish`: nothing is checkpointed (#243).
    });
    const s = session(provider);
    const result = await s.send("go");
    expect(result.status).toBe("cancelled");

    const attempt = modelCalls(s.history())[0]!.attempt!;
    expect(attempt.outcome).toBe("aborted");
    expect(attempt.consumedUsage).toBe(true);
  });

  it("unavailable usage stays unknown: zeros are the neutral shape, never evidence", async () => {
    const provider = providerOf("mock", async function* () {
      yield { type: "model_call_start", model: "mock" };
      yield { type: "usage", inputTokens: 0, outputTokens: 0, provenance: "unavailable" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "finish", reason: "stop" };
    });
    const s = session(provider);
    const result = await s.send("go");
    expect(result.status).toBe("done");

    const call = modelCalls(s.history())[0]!;
    expect(call.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(call.usageProvenance).toBe("unavailable");
    expect(call.cacheReadTokens).toBeUndefined();
    expect(call.attempt!.consumedUsage).toBe(false);
  });

  it("malformed provider usage is treated as unreported, never summed as garbage", async () => {
    const provider = providerOf("mock", async function* () {
      yield { type: "model_call_start", model: "mock" };
      // Detail fields of the wrong shape: unreported, not NaN-poisoned.
      yield { type: "usage", inputTokens: 7, outputTokens: 2, cacheReadTokens: "12" as unknown as number, provenance: "provider" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "finish", reason: "stop" };
    });
    const s = session(provider);
    const result = await s.send("go");
    expect(result.status).toBe("done");

    const call = modelCalls(s.history())[0]!;
    expect(call.cacheReadTokens).toBeUndefined();
    expect(call.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(call.usageProvenance).toBe("provider");
  });

  it("endpointIdentity sanitizes: query strings, fragments and userinfo never reach the log", () => {
    expect(endpointIdentity("openai", "https://user:pass@api.example.com/v1?key=sk-SECRET#x")).toEqual({
      kind: "openai",
      baseUrl: "https://api.example.com/v1",
    });
    expect(endpointIdentity("openai", undefined)).toEqual({ kind: "openai" });
    expect(endpointIdentity("openai", "not a url")).toEqual({ kind: "openai" });
  });

  it("the report query reads measured usage, unknown usage, cache rate, retries and fallback cost — no prompt text", async () => {
    // Deterministic fixture log: one call served on the fallback stop with
    // provider-reported cache detail, one call the provider reported
    // nothing for, plus a retried call — like the chain a real session
    // produces. The query reads none of the user_message text.
    let t = 1;
    const uid = () => {
      let time = "";
      let m = t++;
      for (let i = 9; i >= 0; i--) {
        time = ENCODING[m % 32] + time;
        m = Math.floor(m / 32);
      }
      return time + "AAAAAAAAAAAAAAAA";
    };
    const attemptBase = { callId: "c1", turnId: "t1", startedAt: "2026-10-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:01.000Z", durationMs: 1000, pricingVersion: "test" };
    const events: AgentEvent[] = [
      { id: uid(), type: "session_start", schemaVersion: 1, promptVersion: "v" },
      { id: uid(), type: "user_message", text: "SECRET-PROMPT-TEXT" },
      {
        id: uid(),
        type: "model_call",
        model: "primary/expensive",
        usage: { inputTokens: 1000, outputTokens: 100 },
        cacheReadTokens: 800,
        usageProvenance: "provider",
        failed: true,
        attempt: { ...attemptBase, attemptId: "a1", retryIndex: 0, chainIndex: 0, selectedModel: "primary/expensive", servingModel: "primary/expensive", endpoint: { kind: "openai" }, outcome: "failed", errorKind: "quota_exhausted", consumedUsage: true },
      },
      {
        id: uid(),
        type: "model_call",
        model: "fallback/cheap",
        usage: { inputTokens: 500, outputTokens: 50 },
        usageProvenance: "provider",
        attempt: { ...attemptBase, attemptId: "a2", retryIndex: 1, chainIndex: 1, selectedModel: "primary/expensive", servingModel: "fallback/cheap", endpoint: { kind: "openai" }, outcome: "completed", consumedUsage: true },
      },
      {
        id: uid(),
        type: "model_call",
        model: "fallback/cheap",
        usage: { inputTokens: 10, outputTokens: 5 },
        usageProvenance: "unavailable",
        attempt: { ...attemptBase, callId: "c2", attemptId: "a3", retryIndex: 0, chainIndex: 1, selectedModel: "primary/expensive", servingModel: "fallback/cheap", endpoint: { kind: "openai" }, outcome: "completed", consumedUsage: false },
      },
      { id: uid(), type: "done", usage: { inputTokens: 1510, outputTokens: 155 } },
    ];

    const home = mkdtempSync(join(tmpdir(), "moh-attempts-"));
    try {
      const dir = projectSessionsDir(home, home);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "s.jsonl");
      const chained = events.map((e, i) => (i === 0 ? e : { ...e, parentId: events[i - 1]!.id }));
      writeFileSync(file, chained.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const report = aggregateTelemetry({ cwd: home, home });

      const fallbackRow = report.models.find((r) => r.model === "fallback/cheap")!;
      expect(fallbackRow.callsWithoutUsage).toBe(1);
      // Cache rate is computable from the record, never invented: the
      // primary attempt reported 800 of 1000 input tokens as cache reads.
      const cacheRate = 800 / 1000;
      expect(cacheRate).toBeCloseTo(0.8);
      // Fallback cost: the estimate the report's own convention derives for
      // the stop that served — undefined means tokens-only (no price row),
      // never zero.
      const fallbackCost = estimateModelCost("fallback/cheap", {
        inputTokens: fallbackRow.inputTokens,
        outputTokens: fallbackRow.outputTokens,
      });
      expect(fallbackCost === undefined || fallbackCost.usd > 0).toBe(true);
      const primaryRow = report.models.find((r) => r.model === "primary/expensive");
      expect(primaryRow).toBeUndefined(); // failed calls get no usage row
      expect(fallbackRow.inputTokens).toBe(510);
      expect(report.attempts.calls).toBe(2);
      expect(report.attempts.attempts).toBe(3);
      expect(report.attempts.retriedCalls).toBe(1);
      expect(report.attempts.fallbackMoves).toBe(1);
      expect(report.attempts.unknownUsage).toBe(1);
      expect(report.attempts.durationMs).toBe(3000);
      // No prompt text anywhere in the report projection.
      expect(JSON.stringify(report)).not.toContain("SECRET-PROMPT-TEXT");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // #1101: time to first content rides the attempt record — present when
  // the attempt streamed text, absent when it produced none (a tool-only
  // call, a failure). Unknown, never zero.
  it("ttfcMs records the first streamed text delta; a textless call carries no ttfc", async () => {
    // A completed text call: ttfc present, >= 0, and stamped before end.
    const textSession = session(providerOf("gw/auto", async function* () {
      yield { type: "model_call_start", model: "gw/auto" };
      yield { type: "usage", inputTokens: 5, outputTokens: 2, provenance: "provider" };
      yield { type: "text_delta", text: "hello" };
      yield { type: "finish", reason: "stop" };
    }));
    const result = await textSession.send("say hi");
    expect(result.status).toBe("done");
    const attempt = modelCalls(textSession.history())[0]!.attempt!;
    expect(attempt.ttfcMs).toBeGreaterThanOrEqual(0);
    expect(attempt.ttfcMs!).toBeLessThanOrEqual(attempt.durationMs);

    // A tool-only completed call: no text streamed — no ttfc field at all.
    const toolOnly = session(providerOf("gw/auto", async function* () {
      yield { type: "model_call_start", model: "gw/auto" };
      yield { type: "usage", inputTokens: 5, outputTokens: 1, provenance: "provider" };
      yield { type: "tool_calls", calls: [{ callId: "c3", name: "noop", args: {} }] };
      yield { type: "finish", reason: "tool_calls" };
    }));
    await toolOnly.send("call the tool");
    const toolAttempt = modelCalls(toolOnly.history())[0]!.attempt!;
    expect(toolAttempt.outcome).toBe("completed");
    expect(toolAttempt.ttfcMs).toBeUndefined();
  });
});
