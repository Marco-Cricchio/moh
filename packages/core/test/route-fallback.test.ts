import { describe, expect, test } from "bun:test";
import { createSession, MockProvider, type Provider } from "../src/index";
import { createRoute, Endpoint, envApiKey } from "../src/route";
import { classifyStatus, disambiguate429, normalizeProviderError } from "../src/provider-errors";
import { ProviderError } from "../src/types";
import type { Message, StreamEvent } from "../src/types";
import type { RouteTarget } from "../src/route";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mockEndpoint(name: string, capabilities?: Partial<{ caching: boolean; parallelToolCalls: boolean; multimodal: boolean }>) {
  return new Endpoint({ name, kind: "mock", capabilities });
}

function mockTarget(name: string): RouteTarget {
  return { endpoint: mockEndpoint(name), modelId: `model-${name}` };
}

function mockStreamOf(turns: Parameters<typeof MockProvider.scripted>[0], signal?: AbortSignal) {
  const provider = MockProvider.scripted(turns);
  return (messages: Message[], s: AbortSignal) => provider.stream(messages, s ?? signal);
}

describe("error taxonomy normalization", () => {
  test("429 body disambiguation: rate hints, quota hints, ambiguous -> rate_limited", () => {
    expect(disambiguate429("rate limit exceeded, retry after 1s")).toBe("rate_limited");
    expect(disambiguate429("You exceeded your current quota, please check your plan and billing details")).toBe("quota_exhausted");
    expect(disambiguate429("insufficient_quota: monthly limit reached")).toBe("quota_exhausted");
    expect(disambiguate429("")).toBe("rate_limited");
    expect(disambiguate429("something went wrong")).toBe("rate_limited");
    // body mentions both: rate hints win
    expect(disambiguate429("rate limit; quota may also apply")).toBe("rate_limited");
  });

  test("status classification across the 9 kinds", () => {
    expect(classifyStatus(401, "", "")).toBe("auth");
    expect(classifyStatus(429, "too many requests", "")).toBe("rate_limited");
    expect(classifyStatus(429, "billing quota exceeded", "")).toBe("quota_exhausted");
    expect(classifyStatus(529, "", "")).toBe("overloaded");
    expect(classifyStatus(503, "", "")).toBe("overloaded");
    expect(classifyStatus(400, "maximum context window is 200000 tokens, however you requested 300000", "")).toBe("context_length");
    expect(classifyStatus(400, "invalid parameter", "")).toBe("invalid_request");
    expect(classifyStatus(403, "request blocked by content policy", "")).toBe("content_filtered");
    expect(classifyStatus(403, "forbidden", "")).toBe("auth");
  });

  test("normalizeProviderError maps thrown values and aborted signals", () => {
    const signal = AbortSignal.abort();
    expect(normalizeProviderError(new Error("boom"), signal).kind).toBe("aborted");
    expect(normalizeProviderError(new TypeError("fetch failed")).kind).toBe("network");
    expect(normalizeProviderError(new Error("AbortError") ).kind).toBe("invalid_request");
    const apiErr = Object.assign(new Error("429 too many requests"), {
      statusCode: 429,
      responseBody: "rate limit exceeded",
    });
    expect(normalizeProviderError(apiErr).kind).toBe("rate_limited");
    expect(normalizeProviderError(new ProviderError("auth", "bad key")).kind).toBe("auth");
  });
});

describe("Endpoint", () => {
  test("credentials via MOH_ENDPOINT_<NAME>_API_KEY env vars", () => {
    expect(envApiKey("anthropic-work", { MOH_ENDPOINT_ANTHROPIC_WORK_API_KEY: "sk-1" })).toBe("sk-1");
    expect(envApiKey("my.endpoint!x", { MOH_ENDPOINT_MY_ENDPOINT_X_API_KEY: "sk-2" })).toBe("sk-2");
    expect(envApiKey("missing", {})).toBeUndefined();
  });

  test("inline key beats env; capabilities default", () => {
    const ep = new Endpoint({ name: "ep", kind: "anthropic", apiKey: "inline" });
    expect(ep.apiKey).toBe("inline");
    expect(ep.capabilities).toEqual({ caching: false, parallelToolCalls: true, multimodal: true });
  });
});

describe("Route fallback chains", () => {
  function routeWith(
    providers: Provider[],
    opts: { retries?: number; fallbacks?: number } = {},
  ) {
    const targets: RouteTarget[] = providers.map((p, i) => ({ endpoint: mockEndpoint(`ep${i}`), modelId: `m${i}` }));
    const streams = providers.map((p) => (m: Message[], s: AbortSignal) => p.stream(m, s));
    let idx = 0;
    const route = createRoute({
      target: targets[0]!,
      fallbacks: opts.fallbacks === undefined ? targets.slice(1) : targets.slice(1, 1 + opts.fallbacks),
      retries: opts.retries ?? 0,
      retryBackoffMs: 0,
      createStream: () => {
        const stream = streams[idx]!;
        idx += 1;
        return stream;
      },
    });
    return { route, attempts: () => idx };
  }

  test("quota_exhausted on primary falls back immediately; events from both attempts stay", async () => {
    const primary = MockProvider.scripted([
      { deltas: ["par"], finish: "stop", error: { kind: "quota_exhausted", message: "billing", afterDeltas: 1 } },
    ]);
    const secondary = MockProvider.scripted([{ deltas: ["tial ", "recovery"], finish: "stop" }]);
    const { route } = routeWith([primary, secondary]);
    const events: StreamEvent[] = [];
    for await (const e of route.stream([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], new AbortController().signal)) {
      events.push(e);
    }
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("partial recovery"); // primary's emitted delta stays, fallback restarts single-shot
    // ADR-0012: the stop is announced — visible downstream, never silent.
    expect(events).toContainEqual({ type: "fallback", from: "ep0/m0", to: "ep1/m1", reason: "quota_exhausted" });
    expect(events).toContainEqual({ type: "route_serving", selected: "ep0/m0", previous: "ep0/m0", serving: "ep1/m1" });
  });
  test("uses the successful fallback for later calls and probes selected once per new turn", async () => {
    let clock = 0;
    const targets = [mockTarget("a"), mockTarget("b"), mockTarget("c")];
    const calls: string[] = [];
    const scripted = new Map<string, Provider>([
      ["a", MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "quota_exhausted", message: "quota" } }, { deltas: ["recovered"], finish: "stop" }])],
      ["b", MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "quota_exhausted", message: "quota" } }])],
      ["c", MockProvider.scripted([{ deltas: ["served"], finish: "stop" }])],
    ]);
    const route = createRoute({
      target: targets[0]!, fallbacks: targets.slice(1), retries: 0, now: () => clock,
      createStream: (target) => {
        calls.push(target.endpoint.name);
        const provider = scripted.get(target.endpoint.name)!;
        return (messages, signal) => provider.stream(messages, signal);
      },
    });
    const message: Message[] = [{ role: "user", parts: [{ kind: "text", text: "hi" }] }];
    for await (const _ of route.stream(message, new AbortController().signal)) { /* first call reaches c */ }
    expect(calls).toEqual(["a", "b", "c"]);
    for await (const _ of route.stream(message, new AbortController().signal)) { /* same turn skips a and b */ }
    expect(calls).toEqual(["a", "b", "c", "c"]);
    clock = 15 * 60_000;
    route.beginTurn();
    for await (const _ of route.stream(message, new AbortController().signal)) { /* recovery probes a */ }
    expect(calls).toEqual(["a", "b", "c", "c", "a"]);
    expect(route.serving).toBe("a/model-a");
  });

  test("a failed recovery probe resumes the serving target without probing other fallbacks", async () => {
    let clock = 0;
    const targets = [mockTarget("a"), mockTarget("b"), mockTarget("c")];
    const calls: string[] = [];
    const providers = new Map<string, Provider>([
      ["a", MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "quota_exhausted", message: "quota" } }])],
      ["b", MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "quota_exhausted", message: "quota" } }])],
      ["c", MockProvider.scripted([{ deltas: ["served"], finish: "stop" }])],
    ]);
    const route = createRoute({
      target: targets[0]!, fallbacks: targets.slice(1), retries: 0, now: () => clock,
      createStream: (target) => {
        calls.push(target.endpoint.name);
        const provider = providers.get(target.endpoint.name)!;
        return (messages, signal) => provider.stream(messages, signal);
      },
    });
    const message: Message[] = [{ role: "user", parts: [{ kind: "text", text: "hi" }] }];
    for await (const _ of route.stream(message, new AbortController().signal)) { /* c becomes serving */ }
    clock = 15 * 60_000;
    route.beginTurn();
    for await (const _ of route.stream(message, new AbortController().signal)) { /* a probe then c */ }
    expect(calls).toEqual(["a", "b", "c", "a", "c"]);
  });

  test("AgentSession keeps the serving fallback after tool execution", async () => {
    const targets = [mockTarget("a"), mockTarget("b")];
    const calls: string[] = [];
    const providers = new Map<string, Provider>([
      ["a", MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "quota_exhausted", message: "quota" } }])],
      ["b", MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "probe", args: {} }] },
        { deltas: ["done"], finish: "stop" },
      ])],
    ]);
    const route = createRoute({
      target: targets[0]!, fallbacks: [targets[1]!], retries: 0,
      createStream: (target) => {
        calls.push(target.endpoint.name);
        const provider = providers.get(target.endpoint.name)!;
        return (messages, signal, tools, options) => provider.stream(messages, signal, tools, options);
      },
    });
    const session = createSession({
      provider: route,
      tools: { probe: { name: "probe", description: "probe", inputSchema: undefined, async execute() { return "ok"; } } },
      permissions: { mode: "auto-accept" },
    });
    await session.send("go");
    expect(calls).toEqual(["a", "b", "b"]);
    expect(session.selectedModel).toBe("a/model-a");
    expect(session.servingModel).toBe("b/model-b");
  });

  test("rate_limited retries then falls back after retries exhausted", async () => {
    const primary = MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "rate_limited", message: "429" } }]);
    const secondary = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const attempts = [primary, primary, secondary]; // 1 retry on primary, then fallback
    const targets = [
      { endpoint: mockEndpoint("a"), modelId: "ma" },
      { endpoint: mockEndpoint("b"), modelId: "mb" },
    ];
    let idx = 0;
    const route = createRoute({
      target: targets[0]!,
      fallbacks: [targets[1]!],
      retries: 1,
      retryBackoffMs: 0,
      createStream: () => {
        const p = attempts[idx]!;
        idx += 1;
        return (m, s) => p.stream(m, s);
      },
    });
    const events: StreamEvent[] = [];
    for await (const e of route.stream([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], new AbortController().signal)) {
      events.push(e);
    }
    expect(idx).toBe(3);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("ok");
  });

  test("non-fallback errors (auth) propagate to the caller", async () => {
    const primary = MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "auth", message: "bad key" } }]);
    const { route } = routeWith([primary]);
    try {
      for await (const _ of route.stream([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], new AbortController().signal)) {
        // consume
      }
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe("auth");
    }
  });

  test("route metadata: ref and chain", () => {
    const { route } = routeWith([MockProvider.scripted([{ deltas: ["x"], finish: "stop" }])]);
    expect(route.ref).toBe("ep0/m0");
    expect(route.chain).toEqual(["ep0/m0"]);
  });

  test("MockProvider cassettes drive deterministic fallback chains (no API keys)", async () => {
    const cassettePrimary = join(tmpdir(), `moh-cassette-primary-${Date.now()}.json`);
    const cassetteSecondary = join(tmpdir(), `moh-cassette-secondary-${Date.now()}.json`);
    writeFileSync(
      cassettePrimary,
      JSON.stringify([{ deltas: ["quota "], finish: "stop", error: { kind: "quota_exhausted", message: "billing hard limit", afterDeltas: 1 } }]),
    );
    writeFileSync(cassetteSecondary, JSON.stringify([{ deltas: ["recovered"], finish: "stop" }]));
    const targets = [
      { endpoint: mockEndpoint("primary"), modelId: "m1" },
      { endpoint: mockEndpoint("secondary"), modelId: "m2" },
    ];
    let idx = 0;
    const route = createRoute({
      target: targets[0]!,
      fallbacks: [targets[1]!],
      retries: 0,
      createStream: () => {
        const provider = idx === 0 ? MockProvider.cassette(cassettePrimary) : MockProvider.cassette(cassetteSecondary);
        idx += 1;
        return (m, s) => provider.stream(m, s);
      },
    });
    const events: StreamEvent[] = [];
    for await (const e of route.stream([{ role: "user", parts: [{ kind: "text", text: "hi" }] }], new AbortController().signal)) {
      events.push(e);
    }
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("quota recovered");
  });
});

describe("public API surface", () => {
  test("no AI SDK types/functions leak into @moh/core public API", async () => {
    const mod: Record<string, unknown> = await import("../src/index");
    // AI SDK symbols only — moh's own anthropic auth grant (ANTHROPIC_*,
    // buildAnthropicAuthorizeUrl, ...) is public API and must not match.
    const leaked = Object.keys(mod).filter((k) => /streamText|LanguageModel|aiSdk|^create(Anthropic|OpenAI|Google)/.test(k));
    expect(leaked).toEqual([]);
  });
});

describe("capability downgrades", () => {
  test("parallelToolCalls=false runs tool calls sequentially", async () => {
    const order: string[] = [];
    const mkTool = (name: string, ms: number): any => ({
      name,
      description: name,
      inputSchema: undefined,
      async execute() {
        order.push(`start:${name}`);
        await Bun.sleep(ms);
        order.push(`end:${name}`);
        return name;
      },
    });
    // fast tool starts first; without the downgrade slow would still be running
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "slow", args: {} }, { name: "fast", args: {} }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    const session = createSession({
      provider: {
        name: "no-parallel",
        capabilities: { caching: false, parallelToolCalls: false, multimodal: false },
        stream: (m, s) => provider.stream(m, s),
      },
      tools: { slow: mkTool("slow", 30), fast: mkTool("fast", 5) },
      permissions: { mode: "auto-accept" },
    });
    const result = await session.send("go");
    expect(result.status).toBe("done");
    expect(order).toEqual(["start:slow", "end:slow", "start:fast", "end:fast"]);
  });

  test("default capabilities keep parallel execution", async () => {
    const order: string[] = [];
    const mkTool = (name: string, ms: number) => ({
      name,
      description: name,
      inputSchema: undefined,
      async execute() {
        order.push(`start:${name}`);
        await Bun.sleep(ms);
        order.push(`end:${name}`);
        return name;
      },
    });
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "slow", args: {} }, { name: "fast", args: {} }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    const session = createSession({
      provider,
      tools: { slow: mkTool("slow", 30), fast: mkTool("fast", 5) },
      permissions: { mode: "auto-accept" },
    });
    const result = await session.send("go");
    expect(result.status).toBe("done");
    expect(order[0]).toBe("start:slow");
    expect(order[1]).toBe("start:fast"); // overlapping
  });
});

describe("fallback target invalid_request cooldown (#506)", () => {
  function quotaInvalidRoute(clock: { value: number }) {
    const targets = [mockTarget("a"), mockTarget("b")];
    const calls: string[] = [];
    const providers = new Map<string, Provider>([
      ["a", MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "quota_exhausted", message: "quota" } }])],
      ["b", MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "invalid_request", message: "messages.content.type is invalid" } }])],
    ]);
    const route = createRoute({
      target: targets[0]!, fallbacks: targets.slice(1), retries: 0, now: () => clock.value,
      createStream: (target) => {
        calls.push(target.endpoint.name);
        const provider = providers.get(target.endpoint.name)!;
        return (messages, signal) => provider.stream(messages, signal);
      },
    });
    return { route, calls };
  }

  test("a fallback target that fails invalid_request is not re-probed next turn", async () => {
    const clock = { value: 0 };
    const { route, calls } = quotaInvalidRoute(clock);
    const message: Message[] = [{ role: "user", parts: [{ kind: "text", text: "hi" }] }];
    // Turn 1: quota on a -> fallback to b -> invalid_request throws.
    try {
      for await (const _ of route.stream(message, new AbortController().signal)) { /* consume */ }
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe("invalid_request");
      expect((err as ProviderError).message).toContain("b/model-b");
    }
    expect(calls).toEqual(["a", "b"]);
    // Turn 2 without beginTurn: b is cooled down, a (quota, also cooled down)
    // is skipped too — the route throws rather than re-probing b.
    try {
      for await (const _ of route.stream(message, new AbortController().signal)) { /* consume */ }
      expect.unreachable();
    } catch (err) {
      expect((err as ProviderError).kind).toBe("quota_exhausted");
    }
    expect(calls).toEqual(["a", "b", "a"]);
    // After the 15-minute cooldown, b becomes viable again.
    clock.value = 15 * 60_000;
    route.beginTurn();
    try {
      for await (const _ of route.stream(message, new AbortController().signal)) { /* consume */ }
      expect.unreachable();
    } catch {
      // both fail again — the point is that b was re-probed
    }
    expect(calls).toEqual(["a", "b", "a", "a", "b"]);
  });

  test("invalid_request on the user-selected target is not cooled down", async () => {
    const clock = { value: 0 };
    const targets = [mockTarget("solo")];
    let calls = 0;
    const provider = MockProvider.scripted([
      { deltas: [], finish: "stop", error: { kind: "invalid_request", message: "bad shape" } },
      { deltas: [], finish: "stop", error: { kind: "invalid_request", message: "bad shape" } },
    ]);
    const route = createRoute({
      target: targets[0]!, retries: 0, now: () => clock.value,
      createStream: () => {
        calls += 1;
        return (messages, signal) => provider.stream(messages, signal);
      },
    });
    const message: Message[] = [{ role: "user", parts: [{ kind: "text", text: "hi" }] }];
    for (let turn = 0; turn < 2; turn++) {
      try {
        for await (const _ of route.stream(message, new AbortController().signal)) { /* consume */ }
        expect.unreachable();
      } catch (err) {
        expect((err as ProviderError).kind).toBe("invalid_request");
      }
    }
    expect(calls).toBe(2); // probed every turn, no cooldown on the selected target
  });
});

describe("billing-error normalization (z.ai code 1113)", () => {
  test("insufficient balance with HTTP 400 maps to quota_exhausted, not invalid_request", () => {
    expect(
      classifyStatus(400, '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}', ""),
    ).toBe("quota_exhausted");
  });
  test("SDK retry wrapper without statusCode still sniffs the cause", () => {
    const wrapped = new Error("Failed after 3 attempts. Last error: AI_APICallError: Insufficient balance or no resource package. Please recharge.");
    expect(normalizeProviderError(wrapped).kind).toBe("quota_exhausted");
  });
  test("'usage limit' classifies as quota_exhausted (#506)", () => {
    expect(classifyStatus(0, "", "Failed after 3 attempts. Last error: AI_APICallError: The usage limit has been reached")).toBe("quota_exhausted");
    expect(normalizeProviderError(new Error("Failed after 3 attempts. Last error: AI_APICallError: The usage limit has been reached")).kind).toBe("quota_exhausted");
  });
});
