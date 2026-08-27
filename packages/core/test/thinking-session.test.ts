import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, setThinkingPreference } from "../src/index";
import { resolveEndpointThinking } from "../src/thinking-preferences";
import type { AgentEvent, Message, Provider, StreamEvent, StreamOptions } from "../src/types";

/**
 * #242: the session wires endpoint-scoped thinking preferences into every
 * model call (decision 8): preference honored per call against the live
 * provider ref, never remapped, effective immediately after a persisted
 * change; models without a map (or custom refs) send nothing.
 */

/** A provider that records the stream options it received, mirroring the
 * mock's effective-level announcement. */
function recordingProvider(name: string, seen: StreamOptions[]): Provider {
  return {
    name,
    async *stream(_messages: Message[], _signal: AbortSignal, _tools, options?: StreamOptions): AsyncIterable<StreamEvent> {
      seen.push(options ?? ({} as StreamOptions));
      yield { type: "model_call_start", model: name, ...(options?.thinking ? { thinkingLevel: options.thinking.level } : {}) };
      yield { type: "text_delta", text: "ok" };
      yield { type: "finish", reason: "stop" };
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
    },
  };
}

const ENDPOINTS = [{ name: "ep", type: "anthropic", model: "claude-fable-5" }];

function tmpMohHome(): string {
  const home = mkdtempSync(join(tmpdir(), "moh-think-"));
  mkdirSync(join(home, ".moh"), { recursive: true });
  return join(home, ".moh");
}

function drain(session: { events: AsyncIterable<AgentEvent> }) {
  void (async () => {
    for await (const _ of session.events) void _;
  })();
}

describe("resolveEndpointThinking (#242)", () => {
  test("honors a supported preference; no preference → model default (never a remap)", () => {
    const home = tmpMohHome();
    const file = join(home, "config");
    // fable offers off (disable), xhigh, max — not medium.
    expect(resolveEndpointThinking("ep/claude-fable-5", ENDPOINTS, file)).toBeUndefined();
    setThinkingPreference(file, "ep", "xhigh");
    expect(resolveEndpointThinking("ep/claude-fable-5", ENDPOINTS, file)).toEqual({ level: "xhigh" });
    // An unoffered preference falls to the provider default, not a remap.
    setThinkingPreference(file, "ep", "medium");
    expect(resolveEndpointThinking("ep/claude-fable-5", ENDPOINTS, file)).toBeUndefined();
    // An explicitly-disabled level stays selectable (it means "off").
    setThinkingPreference(file, "ep", "off");
    expect(resolveEndpointThinking("ep/claude-fable-5", ENDPOINTS, file)).toEqual({ level: "off" });
  });

  test("models without a map and non-endpoint refs send nothing", () => {
    const home = tmpMohHome();
    const file = join(home, "config");
    setThinkingPreference(file, "ep", "xhigh");
    expect(resolveEndpointThinking("ep/claude-haiku-4-5", ENDPOINTS, file)).toBeUndefined(); // no map
    expect(resolveEndpointThinking("ep/missing-model", ENDPOINTS, file)).toBeUndefined();
    expect(resolveEndpointThinking("mock", ENDPOINTS, file)).toBeUndefined();
    expect(resolveEndpointThinking("ep/claude-fable-5", [], file)).toBeUndefined(); // unknown endpoint
  });
});

describe("session thinking wiring (#242)", () => {
  test("calls receive the endpoint preference; a persisted change is effective on the next call", async () => {
    const home = tmpMohHome();
    const file = join(home, "config");
    const seen: StreamOptions[] = [];
    const session = createSession({
      provider: recordingProvider("ep/claude-fable-5", seen),
      endpoints: ENDPOINTS,
      mohHome: home,
      memory: { enabled: false },
    });
    drain(session);
    await session.send("one");
    expect(seen[0]?.thinking).toBeUndefined(); // medium unsupported → nothing sent

    setThinkingPreference(file, "ep", "max");
    await session.send("two");
    expect(seen[1]?.thinking).toEqual({ level: "max" });
    // The audit records the effective level actually sent (#239 decision 9).
    const calls = session.history().filter((e) => e.type === "model_call");
    expect(calls.at(-1)).toMatchObject({ model: "ep/claude-fable-5", thinkingLevel: "max" });
    expect(calls[0]).not.toHaveProperty("thinkingLevel");
  });

  test("an explicit session thinking config wins over endpoint preferences", async () => {
    const home = tmpMohHome();
    setThinkingPreference(join(home, "config"), "ep", "max");
    const seen: StreamOptions[] = [];
    const session = createSession({
      provider: recordingProvider("ep/claude-fable-5", seen),
      endpoints: ENDPOINTS,
      mohHome: home,
      thinking: { level: "off" },
      memory: { enabled: false },
    });
    drain(session);
    await session.send("one");
    expect(seen[0]?.thinking).toEqual({ level: "off" });
  });

  test("a dynamic thinking getter is consulted per call", async () => {
    const seen: StreamOptions[] = [];
    let level: "low" | "high" | undefined = "low";
    const session = createSession({
      provider: recordingProvider("ep/claude-fable-5", seen),
      endpoints: ENDPOINTS,
      mohHome: tmpMohHome(),
      thinking: () => (level ? { level } : undefined),
      memory: { enabled: false },
    });
    drain(session);
    await session.send("one");
    level = undefined;
    await session.send("two");
    level = "high";
    await session.send("three");
    expect(seen.map((o) => o.thinking?.level)).toEqual(["low", undefined, "high"]);
  });
});
