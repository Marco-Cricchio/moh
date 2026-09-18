/**
 * ADR-0033 / #787: the `beforeTurn` hook — the turn-start decision point.
 * One dispatch per user send, before the provider is read and before the
 * `user_message` is logged; a returned ref is applied like the manual
 * `/model` switch, an invalid ref is ignored with a visible failure, and
 * hook failures fail open.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension, type ExtensionSetupContext } from "@moh/extension";
import {
  ExtensionRuntime,
  MockProvider,
  createSession,
  type AgentEvent,
  type Provider,
  type Tool,
} from "../src/index";
import { ProviderRegistry } from "../src/provider-registry";

function tmpDir(prefix = "moh-bt-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const echoTool: Tool = {
  name: "echo",
  description: "echoes its text",
  inputSchema: undefined,
  execute: (args: { text: string }) => args.text,
};

/** A provider that records which model actually served each call. */
function recording(served: string[], name: string): Provider {
  return {
    name,
    capabilities: { caching: false, parallelToolCalls: false, multimodal: false },
    stream: async function* () {
      served.push(name);
      yield { type: "text_delta", text: "x" } as never;
      yield { type: "finish", reason: "stop" } as never;
    },
  };
}

/** Two switchable registered ids over distinct providers. */
function twoModels(served: string[]): ProviderRegistry {
  return new ProviderRegistry()
    .registerProvider("pa", () => recording(served, "pa/m"))
    .registerProvider("pb", () => recording(served, "pb/m"));
}

/** Registers one definition and returns the runtime, in registration order. */
async function runtime(
  setup: (ctx: ExtensionSetupContext) => void,
  home = tmpDir(),
): Promise<ExtensionRuntime> {
  const rt = new ExtensionRuntime({ mohHome: home, consent: () => true });
  await rt.register(
    defineExtension({ name: "probe", version: "1.0.0", apiVersion: "1.2", setup }),
  );
  return rt;
}

describe("beforeTurn (ADR-0033)", () => {
  test("a returned ref serves the current turn and appends model_switched before user_message", async () => {
    const served: string[] = [];
    const rt = await runtime((ctx) => ctx.beforeTurn(() => ({ model: "pb" })));
    const session = createSession({ provider: "pa", registry: twoModels(served), extensions: rt });

    await session.send("route me");

    // The ref applies to *this* turn, not the next one.
    expect(served).toEqual(["pb/m"]);
    const types = session.history().map((e) => e.type);
    expect(types).toContain("model_switched");
    expect(types.indexOf("model_switched")).toBeLessThan(types.indexOf("user_message"));
    const switched = session.history().find((e) => e.type === "model_switched") as Extract<
      AgentEvent,
      { type: "model_switched" }
    >;
    // Registered ids keep their own provider name; the switch lands on the
    // provider the ref resolved to.
    expect(switched.from).toBe("pa/m");
    expect(switched.to).toBe("pb/m");
  });

  test("the hook sees the typed text, the 1-based turn index and the active model", async () => {
    const seen: { text: string; turnIndex: number; model: string }[] = [];
    const rt = await runtime((ctx) => ctx.beforeTurn((c) => void seen.push({ ...c })));
    const session = createSession({ provider: "mock", extensions: rt });

    await session.send("first");
    await session.send("second");

    expect(seen).toEqual([
      { text: "first", turnIndex: 1, model: "mock" },
      { text: "second", turnIndex: 2, model: "mock" },
    ]);
  });

  test("an unresolvable ref is ignored: visible failure, turn proceeds on the active model", async () => {
    const rt = await runtime((ctx) => ctx.beforeTurn(() => ({ model: "no-such-endpoint/model" })));
    const session = createSession({ provider: "mock", extensions: rt });

    const result = await session.send("hi");

    expect(result.status).toBe("done");
    expect(session.activeModel).toBe("mock");
    const failed = session.history().find((e) => e.type === "extension_failed") as Extract<
      AgentEvent,
      { type: "extension_failed" }
    >;
    expect(failed.reason).toBe("invalid_model");
    expect(failed.name).toBe("probe");
    expect(failed.message).toContain("no-such-endpoint/model");
    // The turn ran: the message is in the log after the failure.
    const types = session.history().map((e) => e.type);
    expect(types.indexOf("extension_failed")).toBeLessThan(types.indexOf("user_message"));
    expect(types).toContain("done");
  });

  test("a ref equal to the active model is a silent no-op", async () => {
    const rt = await runtime((ctx) => ctx.beforeTurn(() => ({ model: "mock" })));
    const session = createSession({ provider: "mock", extensions: rt });
    const before = session.history().length;

    await session.send("hi");

    expect(session.history().some((e) => e.type === "model_switched")).toBe(false);
    expect(session.history().length).toBeGreaterThan(before);
  });

  test("a throwing hook fails open: one extension_failed, the turn proceeds", async () => {
    const rt = await runtime((ctx) =>
      ctx.beforeTurn(() => {
        throw new Error("boom");
      }),
    );
    const session = createSession({ provider: "mock", extensions: rt });

    const result = await session.send("hi");

    expect(result.status).toBe("done");
    const failed = session.history().find((e) => e.type === "extension_failed") as Extract<
      AgentEvent,
      { type: "extension_failed" }
    >;
    expect(failed.reason).toBe("hook");
    expect(failed.message).toBe("boom");
    expect(session.history().map((e) => e.type)).toContain("done");
  });

  test("the first hook returning a model wins, in registration order", async () => {
    const served: string[] = [];
    const rt = new ExtensionRuntime({ mohHome: tmpDir(), consent: () => true });
    await rt.register(
      defineExtension({
        name: "first",
        version: "1.0.0",
        apiVersion: "1.2",
        setup: (ctx) => ctx.beforeTurn(() => ({ model: "pa" })),
      }),
    );
    await rt.register(
      defineExtension({
        name: "second",
        version: "1.0.0",
        apiVersion: "1.2",
        setup: (ctx) => ctx.beforeTurn(() => ({ model: "pb" })),
      }),
    );
    const session = createSession({ provider: "pb", registry: twoModels(served), extensions: rt });

    await session.send("hi");

    expect(session.activeModel).toBe("pa/m");
    expect(served).toEqual(["pa/m"]);
  });

  test("no runtime means no dispatch: the active model serves the turn", async () => {
    const served: string[] = [];
    const session = createSession({ provider: "pa", registry: twoModels(served) });

    await session.send("hi");

    expect(served).toEqual(["pa/m"]);
    expect(session.history().some((e) => e.type === "model_switched")).toBe(false);
  });

  test("a child turn is routed too, and its switch lands in the child's own log", async () => {
    const home = tmpDir("moh-bt-sub-");
    const served: string[] = [];
    const rt = await runtime(
      (ctx) => ctx.beforeTurn((c) => (c.text === "child task" ? { model: "pb" } : undefined)),
      home,
    );
    const parent = createSession({
      provider: MockProvider.scripted([
        {
          deltas: [""],
          finish: "tool_calls",
          toolCalls: [{ name: "spawn", args: { preset: "probe", task: "child task" } }],
        },
        { deltas: ["parent done"], finish: "stop" },
      ]),
      registry: twoModels(served),
      extensions: rt,
      tools: { echo: echoTool },
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: {
        home,
        presets: { probe: { name: "probe", description: "probe", allowedTools: ["echo"] } },
        provider: "pa",
      },
    });

    const result = await parent.send("go");
    expect(result.status).toBe("done");
    // The parent turn was not routed (the router only answers "child task").
    expect(parent.history().some((e) => e.type === "model_switched")).toBe(false);

    // The child's own log carries the switch.
    const spawn = parent.history().find((e) => e.type === "subagent_spawn") as Extract<
      AgentEvent,
      { type: "subagent_spawn" }
    >;
    const childTypes = readFileSync(spawn.log, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line) as AgentEvent).type);
    expect(childTypes).toContain("model_switched");
  });

  test("a child resolves an endpoint/model-id ref against the parent's profiles", async () => {
    const home = tmpDir("moh-bt-sub-ep-");
    const served: string[] = [];
    const registry = new ProviderRegistry()
      .registerProvider("stub-a", () => recording(served, "alpha/one"))
      .registerProvider("stub-b", () => recording(served, "beta/two"));
    const endpoints = [
      { name: "alpha", type: "stub-a", defaultModel: "one" },
      { name: "beta", type: "stub-b", defaultModel: "two" },
    ];
    const rt = await runtime(
      (ctx) => ctx.beforeTurn((c) => (c.text === "child task" ? { model: "beta/two" } : undefined)),
      home,
    );
    const parent = createSession({
      provider: MockProvider.scripted([
        {
          deltas: [""],
          finish: "tool_calls",
          toolCalls: [{ name: "spawn", args: { preset: "probe", task: "child task" } }],
        },
        { deltas: ["parent done"], finish: "stop" },
      ]),
      registry,
      endpoints,
      extensions: rt,
      tools: { echo: echoTool },
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: {
        home,
        presets: { probe: { name: "probe", description: "probe", allowedTools: ["echo"] } },
        provider: "alpha/one",
      },
    });

    await parent.send("go");

    const spawn = parent.history().find((e) => e.type === "subagent_spawn") as Extract<
      AgentEvent,
      { type: "subagent_spawn" }
    >;
    const child = readFileSync(spawn.log, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as AgentEvent);
    const switched = child.find((e) => e.type === "model_switched") as Extract<
      AgentEvent,
      { type: "model_switched" }
    >;
    expect(switched.to).toBe("beta/two");
    // The child was served by the routed endpoint, not by its own default.
    expect(served).toEqual(["beta/two"]);
  });
});
