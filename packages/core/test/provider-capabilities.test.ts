/**
 * #1441 (characterization): the optional members the core reads off a
 * `Provider` — `selected`, `serving`, `baseUrl`, `beginTurn`, `health` —
 * keep their runtime value checks: a custom provider may put another type in
 * any of them and the core falls back instead of trusting the shape.
 */
import { describe, expect, test } from "bun:test";
import { createSession, MockProvider, type AgentEvent, type Provider } from "../src/index";
import { selectedModelOf, servingModelOf } from "../src/model-pair";
import { createRoute, Endpoint, type RouteTarget } from "../src/route";
import type { Message, StreamEvent } from "../src/types";

/** A custom provider carrying arbitrary extra members. */
function custom(name: string, extra: Record<string, unknown>, log?: string[]): Provider {
  return {
    name,
    ...extra,
    async *stream(): AsyncGenerator<StreamEvent> {
      log?.push("stream");
      yield { type: "model_call_start", model: name };
      yield { type: "text_delta", text: "x" };
      yield { type: "finish", reason: "stop" };
    },
  } as unknown as Provider;
}

function started(provider: Provider) {
  const session = createSession({ provider, tools: {} });
  void (async () => {
    for await (const _ of session.events) void _;
  })();
  return session;
}

const modelCalls = (events: AgentEvent[]) =>
  events.filter((e) => e.type === "model_call") as Extract<AgentEvent, { type: "model_call" }>[];

describe("selected / serving: value checks stay (#1441)", () => {
  test("non-string, non-undefined values fall back to the provider name", () => {
    for (const value of [42, {}, null, true]) {
      const provider = custom("my/custom", { selected: value, serving: value });
      expect(selectedModelOf(provider)).toBe("my/custom");
      expect(servingModelOf(provider)).toBe("my/custom");
    }
  });

  test("string values are read as the selection and the serving stop", () => {
    const provider = custom("my/custom", { selected: "a/m", serving: "b/m" });
    expect(selectedModelOf(provider)).toBe("a/m");
    expect(servingModelOf(provider)).toBe("b/m");
  });
});

describe("baseUrl: endpoint identity fallback (#1441)", () => {
  test("a provider's own baseUrl is the sanitized endpoint identity when none is announced", async () => {
    const s = started(custom("gw/auto", { baseUrl: "https://user:pw@api.example.com/v1?key=SECRET#frag" }));
    expect((await s.send("go")).status).toBe("done");
    const [event] = modelCalls(s.history());
    expect(event!.attempt!.endpoint).toEqual({ kind: "gw", baseUrl: "https://api.example.com/v1" });
    expect(JSON.stringify(event)).not.toContain("SECRET");
  });

  test("no baseUrl, or one that is not a string, yields the kind alone", async () => {
    for (const extra of [{}, { baseUrl: 42 }]) {
      const s = started(custom("gw/auto", extra));
      await s.send("go");
      expect(modelCalls(s.history())[0]!.attempt!.endpoint).toEqual({ kind: "gw" });
    }
  });
});

describe("beginTurn: called by the loop at the turn start (#1441)", () => {
  test("a function member is called once per user send, before the provider streams", async () => {
    const log: string[] = [];
    const s = started(custom("p/m", { beginTurn: () => void log.push("beginTurn") }, log));
    await s.send("one");
    await s.send("two");
    expect(log).toEqual(["beginTurn", "stream", "beginTurn", "stream"]);
  });

  test("a member that is not a function is ignored", async () => {
    const log: string[] = [];
    const s = started(custom("p/m", { beginTurn: "not-a-function" }, log));
    expect((await s.send("one")).status).toBe("done");
    expect(log).toEqual(["stream"]);
  });
});

describe("health: endpointCooldowns (#1441)", () => {
  test("a route in cooldown reports ref and kind only, without the deadline", async () => {
    const target = (name: string): RouteTarget => ({
      endpoint: new Endpoint({ name, kind: "mock" }),
      modelId: `model-${name}`,
    });
    const providers = new Map<string, Provider>([
      ["a", MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "quota_exhausted", message: "quota" } }])],
      ["b", MockProvider.scripted([{ deltas: ["served"], finish: "stop" }])],
    ]);
    const route = createRoute({
      target: target("a"),
      fallbacks: [target("b")],
      retries: 0,
      now: () => 0,
      createStream: (t) => (messages: Message[], signal: AbortSignal) => providers.get(t.endpoint.name)!.stream(messages, signal),
    });
    const s = started(route);
    expect((await s.send("go")).status).toBe("done");
    expect(s.endpointCooldowns).toEqual([{ ref: "a/model-a", kind: "quota_exhausted" }]);
  });

  test("a provider's own health() is mapped to ref and kind", () => {
    const s = started(custom("p/m", { health: () => [{ ref: "x/m", kind: "rate_limited", until: 99 }] }));
    expect(s.endpointCooldowns).toEqual([{ ref: "x/m", kind: "rate_limited" }]);
  });

  test("a health member that is not a function, or a plain provider, reports nothing", () => {
    expect(started(custom("p/m", { health: [1, 2] })).endpointCooldowns).toEqual([]);
    expect(started(custom("p/m", {})).endpointCooldowns).toEqual([]);
  });
});
