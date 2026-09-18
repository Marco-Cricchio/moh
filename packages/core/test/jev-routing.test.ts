/**
 * #787 end to end: the bundled routing use case inside a real session —
 * two confident turns on the same tier move the session to that tier's
 * model, the judgment lands in the log, and the switch rides the existing
 * `model_switched` chrome. Fake fetch, injected pool: no network.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Route } from "../src/route";
import { ExtensionRuntime, createSession, defaultRegistry, resolveProviderRef, type AgentEvent, type Provider } from "../src/index";
import { ProviderRegistry } from "../src/provider-registry";
import { createJevGuardExtension } from "@moh/jev-guard";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "moh-jevr-"));
}

/** A provider that records which model served each call. */
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

const choice = (name: string, confidence: number) =>
  (async () =>
    new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: {
          difficulty: { type: "choice", choice: name, probabilities: { [name]: confidence }, confidence },
          needs_context: { type: "noul", noul: 0 },
        },
        usage: { input_tokens: 40, output_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

async function routingSession(
  fetchImpl: typeof fetch,
  models: { ref: string; price?: number }[],
  served: string[],
) {
  const rt = new ExtensionRuntime({ mohHome: tmpDir(), consent: () => true });
  await rt.register(
    createJevGuardExtension({ apiKey: "sk-test", fetchImpl, routing: { pool: async () => ({ models }) } }),
  );
  const registry = new ProviderRegistry()
    .registerProvider("pa", () => recording(served, "pa/m"))
    .registerProvider("pb", () => recording(served, "pb/m"));
  return createSession({ provider: "pa", registry, extensions: rt });
}

const models = [
  { ref: "pa", price: 1 },
  { ref: "pb", price: 100 },
];

describe("Jev routing in a session (#787)", () => {
  test("two consecutive confident turns switch the model, and the switch serves that same turn", async () => {
    const served: string[] = [];
    const session = await routingSession(choice("potente", 0.9), models, served);

    await session.send("hard task one");
    await session.send("hard task two");
    // Applied at the start of the second turn — the switch takes effect
    // for that same turn (that is what beforeTurn buys).
    expect(served).toEqual(["pa/m", "pb/m"]);
    expect(session.activeModel).toBe("pb/m");

    // Replay keeps the judgments (one per judged turn) and the switch.
    const events = session.history();
    const judgments = events.filter((e) => e.type === "extension_event" && e.name === "jev_judgment");
    expect(judgments).toHaveLength(2);
    expect((judgments[1] as { payload: { useCase: string } }).payload.useCase).toBe("routing");
    expect(events.filter((e) => e.type === "model_switched")).toHaveLength(1);
    const switchedAt = events.findIndex((e) => e.type === "model_switched");
    const secondTurn = events.map((e) => e.type).lastIndexOf("user_message");
    expect(switchedAt).toBeLessThan(secondTurn);
    await session.dispose();
  });

  test("a router pick lands on a route with its fallback chain intact", async () => {
    // The router names one ref; the ref resolves through the same path the
    // manual switch uses, so the endpoint's own fallback stops survive and
    // Jev is never involved in a fallback (the router is transparent to it).
    const endpoints = [
      { name: "pa", type: "openai", defaultModel: "m" },
      { name: "pb", type: "openai", defaultModel: "m" },
      { name: "pc", type: "openai", defaultModel: "m" },
    ];
    const route = resolveProviderRef("pb/m", defaultRegistry.freeze(), endpoints) as Route;
    expect(route.chain).toEqual(["pb/m", "pa/m", "pc/m"]);
    expect(route.chain[0]).toBe("pb/m");
  });

  test("a client command pauses the router, releases it, and is answered with its state", async () => {
    const served: string[] = [];
    const session = await routingSession(choice("potente", 0.9), models, served);

    // One judged turn (streak 1) — and the command channel reports it.
    await session.send("hard task one");
    const reported = session.extensionState("jev-guard", "routingState");
    expect(typeof reported).toBe("function");
    const state = (reported as () => Record<string, unknown>)();
    expect(state).toMatchObject({ paused: false, override: false, streak: 1, streakTier: "potente" });
    expect((state.assignment as { targets: Record<string, string> }).targets).toMatchObject({
      economico: "pa",
      potente: "pb",
    });

    // `/routing off`: paused for the session — the next turn is judged by
    // nobody, and the model does not move.
    session.setExtensionState("jev-guard", { cmd: "off" });
    await Bun.sleep(5);
    const judgedBefore = session.history().filter((e) => e.type === "extension_event" && e.name === "jev_judgment").length;
    await session.send("hard task two");
    expect(served).toEqual(["pa/m", "pa/m"]);
    expect(session.history().filter((e) => e.type === "extension_event" && e.name === "jev_judgment")).toHaveLength(judgedBefore);
    expect(session.history().some((e) => e.type === "model_switched")).toBe(false);

    // The command left its trace, so a replayed session explains the pause.
    const control = session.history().filter((e) => e.type === "extension_control");
    expect(control).toHaveLength(1);
    expect(control[0]).toMatchObject({ extension: "jev-guard", payload: { cmd: "off" } });

    // `/routing on`: judging resumes, and the hysteresis restarts from zero.
    session.setExtensionState("jev-guard", { cmd: "on" });
    await Bun.sleep(5);
    await session.send("hard task three");
    await session.send("hard task four");
    expect(session.activeModel).toBe("pb/m");
    await session.dispose();
  });

  test("low confidence keeps the current model and still records the turn", async () => {
    const served: string[] = [];
    const session = await routingSession(choice("potente", 0.4), models, served);

    await session.send("one");
    await session.send("two");

    expect(served).toEqual(["pa/m", "pa/m"]);
    expect(session.history().filter((e) => e.type === "model_switched")).toEqual([]);
    const judged = session
      .history()
      .filter((e) => e.type === "extension_event" && e.name === "jev_judgment") as Extract<
      AgentEvent,
      { type: "extension_event" }
    >[];
    expect((judged[1]!.payload as { reason: string }).reason).toBe("low-confidence");
    await session.dispose();
  });
});
