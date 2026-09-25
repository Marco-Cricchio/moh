import { describe, expect, test } from "bun:test";
import { MockProvider, createSession } from "../src/index";
import { contextFitFor } from "../src/context-fit";
import { fallbackIneligibleReason } from "../src/provider-registry";
import type { EndpointProfile, AgentEvent, MohConfig } from "../src/index";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function profile(fields: Partial<EndpointProfile> & { name: string; type: string }): EndpointProfile {
  return { ...fields } as EndpointProfile;
}

/** A scripted provider whose turn reports `inputTokens` measured usage. */
function measured(inputTokens: number, text = "ok"): Provider {
  return MockProvider.scripted([{ deltas: [text], finish: "stop", usage: { inputTokens, outputTokens: 1 } }]);
}
import type { Provider } from "../src/index";

describe("contextFitFor (#948)", () => {
  test("fits when measured tokens leave the 8192 reserve inside the window", () => {
    expect(contextFitFor({ measured: 100_000, window: 131_072 })).toEqual({
      fits: true,
      measured: 100_000,
      window: 131_072,
    });
  });

  test("unfit when measured tokens + 8192 reserve exceed the window", () => {
    const verdict = contextFitFor({ measured: 234_666, window: 131_072 });
    expect(verdict.fits).toBe(false);
    expect(verdict.measured).toBe(234_666);
    expect(verdict.window).toBe(131_072);
  });

  test("exactly at the boundary fits (measured ≤ window − 8192)", () => {
    expect(contextFitFor({ measured: 123_000 - 8192, window: 123_000 }).fits).toBe(true);
    expect(contextFitFor({ measured: 123_000 - 8191, window: 123_000 }).fits).toBe(false);
  });

  test("unknown window (0) abstains: fits", () => {
    expect(contextFitFor({ measured: 999_999, window: 0 })).toEqual({
      fits: true,
      measured: 999_999,
      window: 0,
    });
  });

  test("no measurement abstains: fits", () => {
    expect(contextFitFor({ measured: undefined, window: 131_072 }).fits).toBe(true);
  });
});

describe("switchModel context-fit guard (#948)", () => {
  function config(): MohConfig {
    return {
      provider: "big/big",
      endpoints: [
        { name: "big", type: "openai-compat", baseUrl: "http://localhost:1/v1", defaultModel: "big" },
        { name: "small", type: "openai-compat", baseUrl: "http://localhost:2/v1", defaultModel: "small" },
      ],
    };
  }

  test("a switch to a model whose window cannot hold the measured context is refused, visibly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-fit-"));
    // Catalog-backed endpoint kinds carry windows; use a builtin kind for
    // the target so contextWindowFor can resolve its catalog window. The
    // openrouter catalog declares mistral models with real windows.
    const session = createSession({
      provider: measured(234_666),
      endpoints: [
        { name: "openrouter", type: "openrouter", defaultModel: "mistralai/mistral-nemo" },
      ] as MohConfig["endpoints"],
    });
    await session.send("merge");
    const eventsBefore = session.history().length;
    const activeBefore = session.activeModel;
    const result = session.switchModel("openrouter/mistralai/mistral-nemo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("context");
    // Nothing applied: same model. The log grows by exactly the one
    // switch_refused record — no model_switched.
    expect(session.activeModel).toBe(activeBefore);
    expect(session.history().length).toBe(eventsBefore + 1);
    // Loud: exactly one switch_refused chrome event with the numbers.
    const refused = session.history().filter((e) => e.type === "switch_refused");
    expect(refused.length).toBe(1);
    const evt = refused[0] as Extract<AgentEvent, { type: "switch_refused" }>;
    expect(evt.to).toBe("openrouter/mistralai/mistral-nemo");
    expect(evt.reason).toBe("context_length");
    expect(evt.measured).toBe(234_666);
    expect(evt.window).toBe(131_072);
    // The session continues on the current model.
    void dir;
  });

  test("unknown window and no measurement both abstain — the switch proceeds", async () => {
    const session = createSession({ provider: "mock", endpoints: config().endpoints });
    await session.send("hi"); // measurement exists, but target window unknown
    expect(session.switchModel("small/small").ok).toBe(true);
    const fresh = createSession({
      provider: "mock",
      endpoints: [
        ...config().endpoints!,
        { name: "openrouter", type: "openrouter", defaultModel: "mistralai/mistral-nemo" },
      ],
    });
    // No turn yet: no measurement at all — the guard abstains even against
    // a catalog-backed target.
    expect(fresh.switchModel("openrouter/mistralai/mistral-nemo").ok).toBe(true);
  });

  test("session-level fit check is exported for clients", async () => {
    const session = createSession({
      provider: measured(234_666),
      endpoints: [{ name: "openrouter", type: "openrouter", defaultModel: "mistralai/mistral-nemo" }] as MohConfig["endpoints"],
    });
    await session.send("merge");
    const verdict = session.contextFit("openrouter/mistralai/mistral-nemo");
    expect(verdict).toEqual({ fits: false, measured: 234_666, window: 131_072 });
  });

  test("a fit refusal from an extension's applyModel does not double-report as invalid_model", async () => {
    const session = createSession({
      provider: measured(234_666),
      endpoints: [{ name: "openrouter", type: "openrouter", defaultModel: "mistralai/mistral-nemo" }] as MohConfig["endpoints"],
    });
    await session.send("merge");
    // The loop's refusal event path is covered by the loop tests; here the
    // distinguishing fact: the result expresses the refusal distinctly.
    const result = session.switchModel("openrouter/mistralai/mistral-nemo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("context_length");
  });

  test("integration: a refused switch leaves the session serving on the current model", async () => {
    const session = createSession({
      provider: measured(234_666, "before"),
      endpoints: [{ name: "openrouter", type: "openrouter", defaultModel: "mistralai/mistral-nemo" }] as MohConfig["endpoints"],
    });
    await session.send("merge");
    expect(session.switchModel("openrouter/mistralai/mistral-nemo").ok).toBe(false);
    // The next turn still runs, on the original model, with a real measurement.
    await session.send("again");
    const calls = session.history().filter((e) => e.type === "model_call") as Extract<AgentEvent, { type: "model_call" }>[];
    expect(calls.length).toBe(2);
    expect(calls[1]!.model).toBe("mock");
    expect(calls[1]!.failed).toBeFalsy();
    expect(session.history().filter((e) => e.type === "switch_refused").length).toBe(1);
    expect(session.history().filter((e) => e.type === "model_switched").length).toBe(0);
  });
});

describe("fallbackIneligibleReason context fit (#948)", () => {
  test("a cannot-serve endpoint is an ineligible stop with a fit reason", () => {
    const small = profile({ name: "small", type: "openrouter", defaultModel: "mistralai/mistral-nemo" });
    const reason = fallbackIneligibleReason(small, undefined, { measuredTokens: 234_666 });
    expect(reason).toContain("too small");
  });

  test("unknown window or no measurement: the endpoint stays eligible", () => {
    const local = profile({ name: "local", type: "openai-compat", baseUrl: "http://x/v1", defaultModel: "m" });
    expect(fallbackIneligibleReason(local, undefined, { measuredTokens: 999_999 })).toBeNull();
    const small = profile({ name: "small", type: "openrouter", defaultModel: "mistralai/mistral-nemo" });
    expect(fallbackIneligibleReason(small, undefined)).toBeNull();
    expect(fallbackIneligibleReason(small, undefined, { measuredTokens: undefined })).toBeNull();
  });

  test("a fitting endpoint stays eligible", () => {
    const big = profile({ name: "big", type: "openrouter", defaultModel: "deepseek/deepseek-r1" });
    expect(fallbackIneligibleReason(big, undefined, { measuredTokens: 50_000 })).toBeNull();
  });
});
