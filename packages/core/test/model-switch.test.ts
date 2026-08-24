import { describe, expect, test } from "bun:test";
import { createSession, MockProvider } from "../src/index";
import type { AgentEvent, MohConfig, Provider } from "../src/index";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function scripted(text: string): Provider {
  return MockProvider.scripted([{ deltas: [text], finish: "stop" }]);
}

describe("switchModel (#166)", () => {
  test("switches the active model, appends model_switched, keeps the same session log", async () => {
    const session = createSession({ provider: "mock" });
    await session.send("hi");
    const eventsBefore = session.history().length;
    const result = session.switchModel("echo"); // distinct registered id
    expect(result).toEqual({ ok: true, model: "echo" });
    const events = session.history();
    expect(events.length).toBe(eventsBefore + 1);
    const switched = events[events.length - 1] as Extract<AgentEvent, { type: "model_switched" }>;
    expect(switched.type).toBe("model_switched");
    expect(switched.from).toBe("mock");
    expect(switched.to).toBe("echo");
    // Same session continues: a further turn appends, and no second
    // session_start appears (switching is not a new session).
    await session.send("again");
    expect(session.history().filter((e) => e.type === "session_start").length).toBeLessThanOrEqual(1);
  });

  test("resolves endpoint/model-id refs against the session's endpoint profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-switch-"));
    const file = join(dir, "moh.json");
    const config: MohConfig = {
      provider: "alpha/one",
      endpoints: [
        { name: "alpha", type: "openai-compat", baseUrl: "http://localhost:1/v1", defaultModel: "one" },
        { name: "beta", type: "openai-compat", baseUrl: "http://localhost:2/v1", defaultModel: "two" },
      ],
    };
    writeFileSync(file, JSON.stringify(config));
    const session = createSession({
      provider: "alpha/one",
      endpoints: config.endpoints!,
    });
    expect(session.activeModel).toBe("alpha/one");
    const ok = session.switchModel("beta/two");
    expect(ok).toEqual({ ok: true, model: "beta/two" });
    expect(session.activeModel).toBe("beta/two");
  });

  test("failed refs report an error and keep the current model", () => {
    const session = createSession({ provider: "mock" });
    const result = session.switchModel("no-such-endpoint/model");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no-such-endpoint");
    expect(session.activeModel).toBe("mock");
  });

  test("empty ref is rejected", () => {
    const session = createSession({ provider: "mock" });
    expect(session.switchModel("  ").ok).toBe(false);
  });

  test("no-op switch (same ref) appends no chrome event", () => {
    const session = createSession({
      provider: "alpha/one",
      endpoints: [{ name: "alpha", type: "openai-compat", baseUrl: "http://localhost:1/v1", defaultModel: "one" }],
    });
    const before = session.history().length;
    expect(session.switchModel("alpha/one")).toEqual({ ok: true, model: "alpha/one" });
    expect(session.history().length).toBe(before);
  });

  test("the provider is read once per turn — a switch lands on the next turn", async () => {
    const served: string[] = [];
    const make = (name: string): Provider => ({
      name,
      capabilities: { caching: false, parallelToolCalls: false, multimodal: false },
      stream: async function* () {
        served.push(name);
        yield { type: "text_delta", text: "x" } as never;
        yield { type: "finish", reason: "stop" } as never;
      },
    });
    // Registry with two switchable ids over distinct providers.
    const { ProviderRegistry } = require("../src/provider-registry");
    const registry = new ProviderRegistry()
      .registerProvider("pa", () => make("pa/m"))
      .registerProvider("pb", () => make("pb/m"));
    const session = createSession({ provider: "pa", registry });
    await session.send("first");
    expect(served).toEqual(["pa/m"]);
    expect(session.switchModel("pb").ok).toBe(true);
    await session.send("second");
    expect(served).toEqual(["pa/m", "pb/m"]); // next turn only
    expect(session.activeEndpointType).toBeUndefined(); // registered ids carry no endpoint profile
  });

  test("model_switched survives as chrome in the persisted event order", async () => {
    const session = createSession({ provider: "mock" });
    await session.send("one");
    session.switchModel("echo");
    const types = session.history().map((e) => e.type);
    expect(types).toContain("model_switched");
    expect(types.indexOf("model_switched")).toBeGreaterThan(types.indexOf("done"));
  });
});
