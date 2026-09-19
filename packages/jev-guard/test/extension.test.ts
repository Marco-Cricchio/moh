/**
 * #786 integration: the full extension `setup` — the onToolCall hook is
 * registered, returns veto for a deny, ask for the middle band, and
 * nothing for a pass; every judgment (including a pass) is appended as a
 * `jev_judgment` event. Fake context, fake fetch: no network.
 */
import { describe, expect, test } from "bun:test";
import { createJevGuardExtension, JEV_GUARD_NAME } from "../src/index";
import type {
  BeforeTurnHook,
  ExtensionDefinition,
  ExtensionSetupContext,
  ToolCallHook,
} from "@moh/extension";

interface FakeCtx {
  events: Array<{ name: string; payload?: unknown }>;
  statuses: (string | null)[];
  toolHooks: ToolCallHook[];
  beforeTurnHooks: BeforeTurnHook[];
  sessionStartHooks: Array<() => void>;
  eventHooks: Array<(e: { event: { type: string; [k: string]: unknown } }) => void>;
  compactionHooks: Array<(ctx: { sections: readonly { id: string }[] }) => unknown>;
  mode: "normal" | "auto-accept" | "yolo";
}

function fakeCtx(mode: FakeCtx["mode"] = "normal"): ExtensionSetupContext & FakeCtx {
  const hooks: Record<string, unknown> = {
    state: {},
    appendToPrompt: () => {},
    appendEvent: (event: { name: string; payload?: unknown }) => (hooks as unknown as FakeCtx).events.push(event),
    setStatus: (text: string | null) => (hooks as unknown as FakeCtx).statuses.push(text),
    onSessionStart: (h: () => void) => (hooks as unknown as FakeCtx).sessionStartHooks.push(h),
    onSessionEnd: () => {},
    beforeTurn: (h: BeforeTurnHook) => (hooks as unknown as FakeCtx).beforeTurnHooks.push(h),
    beforeModelCall: () => {},
    onToolCall: (h: ToolCallHook) => (hooks as unknown as FakeCtx).toolHooks.push(h),
    onCompaction: (h: (ctx: { sections: readonly { id: string }[] }) => unknown) => (hooks as unknown as FakeCtx).compactionHooks.push(h),
    onEvent: (h: (e: { event: { type: string; [k: string]: unknown } }) => void) => (hooks as unknown as FakeCtx).eventHooks.push(h),
    afterTurn: () => {},
  };
  const self = hooks as unknown as ExtensionSetupContext & FakeCtx;
  self.events = [];
  self.statuses = [];
  self.toolHooks = [];
  self.beforeTurnHooks = [];
  self.sessionStartHooks = [];
  self.eventHooks = [];
  self.compactionHooks = [];
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

describe("jev-guard compaction cut (#792)", () => {
  test("the setup registers an onCompaction hook that answers with drops", async () => {
    const ctx = fakeCtx();
    const answers = {
      droppable: { type: "noul", noul: 0.95 },
    };
    const def = createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: (async () => okResponse(answers)) as unknown as typeof fetch,
    });
    await def.setup(ctx);
    expect(ctx.compactionHooks.length).toBe(1);
    const sections = [
      { id: "s0", kind: "tool_result" as const, bytes: 4000, preview: "bun test output…" },
      { id: "s1", kind: "assistant" as const, bytes: 200, preview: "assistant: settled" },
    ];
    const out = (await ctx.compactionHooks[0]!({ sections })) as {
      drop: string[];
      onApplied: (applied: { keptByFloor: boolean; bytesAfter: number }) => void;
    };
    expect(out.drop).toEqual(["s0", "s1"]);
    // The applied-cut callback produces the one aggregate record.
    out.onApplied({ keptByFloor: true, bytesAfter: 0 });
    const judgments = ctx.events.filter((e) => e.name === "jev_judgment");
    expect(judgments.length).toBe(3); // two per-section + one aggregate
    const aggregate = judgments
      .map((e) => e.payload as Record<string, unknown>)
      .find((p) => p.kind === "compaction");
    expect(aggregate).toBeDefined();
    expect((aggregate as { keptByFloor: boolean }).keptByFloor).toBe(true);
    expect((aggregate as { dropped: string[] }).dropped).toEqual(["s0", "s1"]);
    const perSection = judgments
      .map((e) => e.payload as Record<string, unknown>)
      .filter((p) => p.kind === undefined);
    expect(perSection.length).toBe(2);
    expect((perSection[0] as { useCase: string }).useCase).toBe("compact-cut");
  });
});

describe("jev-guard routing (#787)", () => {
  const pool = {
    models: [
      { ref: "a/cheap", price: 1 },
      { ref: "a/mid", price: 10 },
      { ref: "a/big", price: 100 },
    ],
  };
  const answers = (choice: string, confidence: number) => ({
    difficulty: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence },
    needs_context: { type: "noul", noul: 0 },
  });
  const fetchOk = (body: Record<string, unknown>) =>
    (async () => new Response(JSON.stringify({ model: "jev-latest", answers: body, usage: {} }), { status: 200 })) as unknown as typeof fetch;
  const turn = (text: string, index: number, model = "a/cheap") => ({ text, turnIndex: index, model });

  test("no routing option means no beforeTurn hook: zero cost", async () => {
    const ctx = fakeCtx();
    await createJevGuardExtension({ apiKey: "sk-test", fetchImpl: fetchOk(answers("potente", 0.9)) }).setup(ctx);
    expect(ctx.beforeTurnHooks).toHaveLength(0);
  });

  test("two consecutive confident turns switch the model; every judgment is recorded", async () => {
    const ctx = fakeCtx();
    await createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: fetchOk(answers("potente", 0.9)),
      routing: { pool: async () => pool },
      enabled: true,
    }).setup(ctx);
    expect(ctx.beforeTurnHooks).toHaveLength(1);
    const hook = ctx.beforeTurnHooks[0]!;

    expect(await hook(turn("design a module", 1))).toBeUndefined();
    expect(await hook(turn("still designing", 2))).toEqual({ model: "a/big" });

    const judgments = ctx.events.filter((e) => e.name === "jev_judgment");
    expect(judgments).toHaveLength(2);
    expect(judgments[1]!.payload).toMatchObject({ useCase: "routing", decision: "switch", reason: "hysteresis", target: "a/big" });
  });

  test("the router's own switch is not an override; a hand-picked model suspends it", async () => {
    const ctx = fakeCtx();
    await createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: fetchOk(answers("potente", 0.9)),
      routing: { pool: async () => pool },
      enabled: true,
    }).setup(ctx);
    const hook = ctx.beforeTurnHooks[0]!;
    const emit = (event: { type: string } & Record<string, unknown>) => ctx.eventHooks.forEach((h) => h({ event }));

    await hook(turn("design", 1));
    await hook(turn("design more", 2));
    // The switch the router asked for.
    emit({ type: "model_switched", from: "a/cheap", to: "a/big" });
    expect(ctx.events.some((e) => (e.payload as { kind?: string } | undefined)?.kind === "override")).toBe(false);

    // A switch nobody asked for: the user took the wheel.
    emit({ type: "model_switched", from: "a/big", to: "a/handpicked" });
    const notices = ctx.events.filter((e) => (e.payload as { kind?: string } | undefined)?.kind === "override");
    expect(notices).toHaveLength(1);
    expect(await hook(turn("design again", 3, "a/handpicked"))).toBeUndefined();
    expect(ctx.events.filter((e) => e.name === "jev_judgment")).toHaveLength(2);
  });

  test("a single-tier pool is inert, and says so once at session start", async () => {
    const ctx = fakeCtx();
    await createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: fetchOk(answers("potente", 0.9)),
      routing: { pool: async () => ({ models: [{ ref: "a/only", price: 1 }] }) },
      enabled: true,
    }).setup(ctx);

    ctx.sessionStartHooks.forEach((h) => h());
    await Bun.sleep(1);

    const notices = ctx.events.filter((e) => e.name === "jev_routing");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toEqual({ kind: "inert" });
    expect(await ctx.beforeTurnHooks[0]!(turn("anything", 1, "a/only"))).toBeUndefined();
  });

  test("a misconfigured label and an unpriced model are reported once, visibly", async () => {
    const ctx = fakeCtx();
    await createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: fetchOk(answers("bilanciato", 0.9)),
      routing: {
        pool: async () => ({ models: [{ ref: "a/mystery" }, { ref: "a/cheap", price: 1 }, { ref: "a/big", price: 90 }] }),
        labels: { "b/nope": "potente" },
      },
      enabled: true,
    }).setup(ctx);

    ctx.sessionStartHooks.forEach((h) => h());
    await Bun.sleep(1);

    const payloads = ctx.events.filter((e) => e.name === "jev_routing").map((e) => e.payload);
    expect(payloads).toContainEqual({ kind: "ignored-label", ref: "b/nope" });
    expect(payloads).toContainEqual({ kind: "unpriced", count: 1, models: ["a/mystery"] });
  });

  test("a command controls the router and the extension reports the new state", async () => {
    const ctx = fakeCtx();
    await createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: fetchOk(answers("potente", 0.9)),
      routing: { pool: async () => pool },
      enabled: true,
    }).setup(ctx);
    const hook = ctx.beforeTurnHooks[0]!;
    const emit = (event: { type: string } & Record<string, unknown>) => ctx.eventHooks.forEach((h) => h({ event }));

    emit({ type: "extension_control", extension: JEV_GUARD_NAME, payload: { cmd: "off" } });
    expect(ctx.events.at(-1)!.payload).toEqual({ kind: "control", cmd: "off", paused: true, override: false });
    // Paused: no judgment, no call, nothing spent.
    expect(await hook(turn("design", 1))).toBeUndefined();
    expect(ctx.events.filter((e) => e.name === "jev_judgment")).toHaveLength(0);

    emit({ type: "extension_control", extension: JEV_GUARD_NAME, payload: { cmd: "on" } });
    expect(ctx.events.at(-1)!.payload).toMatchObject({ kind: "control", cmd: "on", paused: false });
    await hook(turn("design", 2));
    expect(ctx.events.filter((e) => e.name === "jev_judgment")).toHaveLength(1);

    // An unknown command is reported, never guessed at.
    emit({ type: "extension_control", extension: JEV_GUARD_NAME, payload: { cmd: "banana" } });
    expect(ctx.events.at(-1)!.payload).toEqual({ kind: "unknown-command", cmd: "banana" });
  });

  test("/routing reads the live state, and late calls still answer shape-correctly", async () => {
    const ctx = fakeCtx();
    await createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: fetchOk(answers("potente", 0.9)),
      routing: { pool: async () => pool },
      enabled: true,
    }).setup(ctx);
    const read = ctx.state.routingState as () => Record<string, unknown>;

    // Before the pool resolved there is no assignment — the answer says so
    // rather than waiting for a network round trip inside a keypress.
    expect(read()).toMatchObject({ paused: false, override: false, assignment: null });

    ctx.sessionStartHooks.forEach((h) => h());
    await Bun.sleep(1);
    const state = read();
    expect(state.assignment).toMatchObject({
      targets: { economico: "a/cheap", bilanciato: "a/mid", potente: "a/big" },
    });
    expect(state.streak).toBe(0);
  });

  test("a serving model the router did not pick gets one visible notice, and costs nothing", async () => {
    const ctx = fakeCtx();
    await createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: fetchOk(answers("potente", 0.9)),
      routing: { pool: async () => pool },
      enabled: true,
    }).setup(ctx);
    const hook = ctx.beforeTurnHooks[0]!;

    // Two turns put the router on a/big.
    await hook(turn("design", 1));
    await hook(turn("design more", 2));

    // The user overrides by config (not through a `model_switched` event).
    expect(await hook(turn("design again", 3, "a/handpicked"))).toBeUndefined();
    expect(await hook(turn("design again", 4, "a/handpicked"))).toBeUndefined();
    const notices = ctx.events.filter((e) => (e.payload as { kind?: string } | undefined)?.kind === "mismatch");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({ current: "a/handpicked", expected: "a/big" });
    // No judgment was spent on the mismatched turns.
    expect(ctx.events.filter((e) => e.name === "jev_judgment")).toHaveLength(2);

    // Back on the router's pick: judging resumes normally.
    await hook(turn("design again", 5, "a/big"));
    expect(ctx.events.filter((e) => e.name === "jev_judgment")).toHaveLength(3);
  });

  test("a failed Jev call routes nothing and records nothing", async () => {
    const ctx = fakeCtx();
    await createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
      routing: { pool: async () => pool },
      enabled: true,
    }).setup(ctx);
    const hook = ctx.beforeTurnHooks[0]!;

    expect(await hook(turn("design", 1))).toBeUndefined();
    expect(await hook(turn("design more", 2))).toBeUndefined();
    expect(ctx.events.filter((e) => e.name === "jev_judgment")).toEqual([]);
  });
});
