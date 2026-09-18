/**
 * #786 integration: the full extension `setup` — the onToolCall hook is
 * registered, returns veto for a deny, ask for the middle band, and
 * nothing for a pass; every judgment (including a pass) is appended as a
 * `jev_judgment` event. Fake context, fake fetch: no network.
 */
import { describe, expect, test } from "bun:test";
import { createJevGuardExtension, JEV_GUARD_NAME } from "../src/index";
import type { ExtensionDefinition, ExtensionSetupContext, ToolCallHook } from "@moh/extension";

interface FakeCtx {
  events: Array<{ name: string; payload?: unknown }>;
  statuses: (string | null)[];
  toolHooks: ToolCallHook[];
  eventHooks: Array<(e: { event: { type: string; [k: string]: unknown } }) => void>;
  mode: "normal" | "auto-accept" | "yolo";
}

function fakeCtx(mode: FakeCtx["mode"] = "normal"): ExtensionSetupContext & FakeCtx {
  const hooks: Record<string, unknown> = {
    state: {},
    appendToPrompt: () => {},
    appendEvent: (event: { name: string; payload?: unknown }) => (hooks as unknown as FakeCtx).events.push(event),
    setStatus: (text: string | null) => (hooks as unknown as FakeCtx).statuses.push(text),
    onSessionStart: () => {},
    onSessionEnd: () => {},
    beforeModelCall: () => {},
    onToolCall: (h: ToolCallHook) => (hooks as unknown as FakeCtx).toolHooks.push(h),
    onEvent: (h: (e: { event: { type: string; [k: string]: unknown } }) => void) => (hooks as unknown as FakeCtx).eventHooks.push(h),
    afterTurn: () => {},
  };
  const self = hooks as unknown as ExtensionSetupContext & FakeCtx;
  self.events = [];
  self.statuses = [];
  self.toolHooks = [];
  self.eventHooks = [];
  self.mode = mode;
  return self;
}

const okResponse = (answers: Record<string, unknown>) =>
  new Response(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 400, output_tokens: 30 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const bash = { callId: "c1", name: "bash", args: { command: "bun test" } };
const write = { callId: "c2", name: "write", args: { path: "/x", content: "y" } };

async function runHook(hooks: ToolCallHook[], call: { callId: string; name: string; args: unknown }) {
  for (const h of hooks) return await h(call);
  return undefined;
}

const SAFE_ANSWERS = {
  destructive: { type: "noul", noul: 0.01 },
  in_scope: { type: "noul", noul: 0.99 },
  exfiltration: { type: "noul", noul: 0.01 },
  risk_level: { type: "score", score: 0.1, legend: {}, probabilities: {}, confidence: 0.9 },
};

describe("jev-guard extension setup (#786)", () => {
  test("pass: hook returns nothing, judgment event recorded anyway", async () => {
    const ctx = fakeCtx();
    const def: ExtensionDefinition = createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: (async () => okResponse(SAFE_ANSWERS)) as unknown as typeof fetch,
    });
    await def.setup(ctx);
    expect(ctx.toolHooks).toHaveLength(1);
    const out = await runHook(ctx.toolHooks, bash);
    expect(out ?? undefined).toBeUndefined();
    const judgments = ctx.events.filter((e) => e.name === "jev_judgment");
    expect(judgments).toHaveLength(1);
    expect((judgments[0]!.payload as Record<string, unknown>).useCase).toBe("guardrail");
  });

  test("deny: hook vetoes with the actionable reason; non-bash tools are untouched", async () => {
    const ctx = fakeCtx();
    const answers = { ...SAFE_ANSWERS, destructive: { type: "noul", noul: 0.95 } };
    const def = createJevGuardExtension({ apiKey: "sk-test", fetchImpl: (async () => okResponse(answers)) as unknown as typeof fetch });
    await def.setup(ctx);
    const out = (await runHook(ctx.toolHooks, bash)) ?? {};
    expect(out.veto).toBe(true);
    expect(String(out.reason)).toContain("cleanup");
    expect(await runHook(ctx.toolHooks, write)).toBeUndefined();
  });

  test("ask: hook returns ask with the caso incerto badge", async () => {
    const ctx = fakeCtx();
    const answers = { ...SAFE_ANSWERS, destructive: { type: "noul", noul: 0.5 } };
    const def = createJevGuardExtension({ apiKey: "sk-test", fetchImpl: (async () => okResponse(answers)) as unknown as typeof fetch });
    await def.setup(ctx);
    const out = (await runHook(ctx.toolHooks, bash)) ?? {};
    expect(out.veto).toBeUndefined();
    expect(out.ask).toBe(true);
    expect(String(out.reason)).toContain("Jev: caso incerto");
  });

  test("yolo mode (via session_mode event): middle band no longer asks", async () => {
    const ctx = fakeCtx();
    const answers = { ...SAFE_ANSWERS, destructive: { type: "noul", noul: 0.5 } };
    const def = createJevGuardExtension({ apiKey: "sk-test", fetchImpl: (async () => okResponse(answers)) as unknown as typeof fetch });
    await def.setup(ctx);
    ctx.eventHooks.forEach((h) => h({ event: { type: "session_mode", mode: "yolo" } }));
    const out = await runHook(ctx.toolHooks, bash);
    expect(out ?? undefined).toBeUndefined();
  });

  test("failure: fail-open pass, offline status published once", async () => {
    const ctx = fakeCtx();
    const def = createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    await def.setup(ctx);
    const out = await runHook(ctx.toolHooks, bash);
    expect(out ?? undefined).toBeUndefined();
    expect(ctx.statuses).toEqual(["∅ jev offline"]);
  });
});
