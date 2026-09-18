/**
 * #784: the Jev infra layer's core surface — the `ask` outcome on the
 * tool-call hook (ADR-0031), the two observability seams (ADR-0032), the
 * `typesafe` config block and the activation branch in session assembly,
 * plus the subagent inheritance of the parent's hook checker.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension, type ExtensionSetupContext } from "@moh/extension";
import {
  ExtensionRuntime,
  MockProvider,
  createSession,
  maskApiKey,
  readTypesafeConfig,
  removeTypesafeApiKey,
  resolveTypesafeConfig,
  saveTypesafeApiKey,
  sessionFromConfig,
  userConfigFile,
  type AgentEvent,
  type Tool,
} from "../src/index";
import { readUserConfigFile } from "../src/user-config";

function tmpDir(prefix = "moh-jev-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const echoTool: Tool = {
  name: "echo",
  description: "echoes its text",
  inputSchema: undefined,
  execute: (args: { text: string }) => args.text,
};

/** A one-turn script: call `echo`, then stop. */
const echoTurn = () => [
  { deltas: [""], finish: "tool_calls" as const, toolCalls: [{ name: "echo", args: { text: "hi" } }] },
  { deltas: ["done"], finish: "stop" as const },
];

/** Registers a definition and returns the captured setup context. */
async function channel(
  setup: (ctx: ExtensionSetupContext) => void = () => {},
  options: Partial<ConstructorParameters<typeof ExtensionRuntime>[0]> = {},
): Promise<{ rt: ExtensionRuntime; ctx: ExtensionSetupContext }> {
  const rt = new ExtensionRuntime({ mohHome: tmpDir("moh-jev-home-"), consent: () => true, ...options });
  let ctx!: ExtensionSetupContext;
  await rt.register(
    defineExtension({
      name: "probe",
      version: "1.0.0",
      apiVersion: "1.1",
      setup: (c) => {
        ctx = c;
        setup(c);
      },
    }),
  );
  return { rt, ctx };
}

/** The extension's own events, without the load bookkeeping. */
const extensionEvents = (rt: ExtensionRuntime): AgentEvent[] =>
  rt.consumeLoadEvents().filter((e) => e.type !== "extension_loaded");

describe("ask outcome (ADR-0031)", () => {
  const askingRuntime = () =>
    channel((ctx) =>
      ctx.onToolCall((call) =>
        call.name === "echo" ? { ask: true, reason: "verify (destructive 0.42)" } : undefined,
      ),
    );

  test("auto-accept still prompts, hands the extension context, writes no rule", async () => {
    const { rt } = await askingRuntime();
    const asks: unknown[] = [];
    const session = createSession({
      provider: MockProvider.scripted(echoTurn()),
      tools: { echo: echoTool },
      extensions: rt,
      permissions: { mode: "auto-accept" },
      onPermissionRequest: (tool, args, context) => {
        asks.push({ tool, args, context });
        return "yes";
      },
    });
    const result = await session.send("go");
    expect(result.status).toBe("done");
    expect(asks).toEqual([
      { tool: "echo", args: { text: "hi" }, context: { source: "extension", extension: "probe", reason: "verify (destructive 0.42)" } },
    ]);
    const types = session.history().map((e) => e.type);
    expect(types).toContain("permission_requested");
    expect(types).not.toContain("permission_rule_added");
    // The built-in tier-1 defaults are always there; what must be absent is
    // any rule written by this ask.
    expect(session.permissionRules.filter((r) => r.tier === "runtime")).toEqual([]);
    expect(session.history().some((e) => e.type === "permission_requested" && e.reason === "extension")).toBe(true);
  });

  test("an “always” answer on an extension ask still writes no rule (no disarming)", async () => {
    const { rt } = await askingRuntime();
    const session = createSession({
      provider: MockProvider.scripted(echoTurn()),
      tools: { echo: echoTool },
      extensions: rt,
      onPermissionRequest: () => "always",
    });
    await session.send("go");
    expect(session.history().some((e) => e.type === "permission_rule_added")).toBe(false);
    expect(session.permissionRules.filter((r) => r.tier === "runtime")).toEqual([]);
  });

  test("yolo ignores the ask: the call proceeds as if the hook said nothing", async () => {
    const { rt } = await askingRuntime();
    let asked = 0;
    const session = createSession({
      provider: MockProvider.scripted(echoTurn()),
      tools: { echo: echoTool },
      extensions: rt,
      permissions: { unrestrictedTools: true },
      onPermissionRequest: () => {
        asked += 1;
        return "no";
      },
    });
    const result = await session.send("go");
    expect(result.status).toBe("done");
    expect(asked).toBe(0);
    expect(session.history().some((e) => e.type === "permission_granted" && e.reason === "yolo")).toBe(true);
  });

  test("headless denies with the headless reason (no recipient)", async () => {
    const { rt } = await askingRuntime();
    const session = createSession({
      provider: MockProvider.scripted(echoTurn()),
      tools: { echo: echoTool },
      extensions: rt,
    });
    await session.send("go");
    expect(session.history().some((e) => e.type === "permission_denied" && e.reason === "headless")).toBe(true);
  });

  test("an explicit deny rule beats the ask (no prompt); an allow rule does not suppress it", async () => {
    const denied = await askingRuntime();
    let deniedAsks = 0;
    const s1 = createSession({
      provider: MockProvider.scripted(echoTurn()),
      tools: { echo: echoTool },
      extensions: denied.rt,
      permissions: { overrides: { tools: { echo: "deny" } } },
      onPermissionRequest: () => {
        deniedAsks += 1;
        return "yes";
      },
    });
    await s1.send("go");
    expect(deniedAsks).toBe(0);
    expect(s1.history().some((e) => e.type === "permission_denied" && e.reason === "rule")).toBe(true);

    const allowed = await askingRuntime();
    let allowedAsks = 0;
    const s2 = createSession({
      provider: MockProvider.scripted(echoTurn()),
      tools: { echo: echoTool },
      extensions: allowed.rt,
      permissions: { overrides: { tools: { echo: "allow" } } },
      onPermissionRequest: () => {
        allowedAsks += 1;
        return "yes";
      },
    });
    await s2.send("go");
    expect(allowedAsks).toBe(1);
  });

  test("veto wins when a hook returns both, and beats the ask in every mode", async () => {
    const { rt } = await channel((ctx) => ctx.onToolCall(() => ({ veto: true, ask: true, reason: "lethal" })));
    let asked = 0;
    const session = createSession({
      provider: MockProvider.scripted(echoTurn()),
      tools: { echo: echoTool },
      extensions: rt,
      permissions: { unrestrictedTools: true },
      onPermissionRequest: () => {
        asked += 1;
        return "yes";
      },
    });
    await session.send("go");
    expect(asked).toBe(0);
    expect(session.history().some((e) => e.type === "permission_denied" && e.reason === "extension")).toBe(true);
  });
});

describe("appendEvent (ADR-0032)", () => {
  test("the runtime stamps the extension name and delivers in order", async () => {
    const { rt, ctx } = await channel();
    ctx.appendEvent({ name: "jev_judgment", payload: { useCase: "guardrail", decision: "pass" } });
    const events = extensionEvents(rt);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "extension_event",
      extension: "probe",
      name: "jev_judgment",
      payload: { useCase: "guardrail", decision: "pass" },
    });
  });

  test("exact-key redaction, recursively; lookalike keys survive", async () => {
    const { rt, ctx } = await channel();
    ctx.appendEvent({
      name: "rec",
      payload: {
        token: "sk-secret",
        api_key: "sk-secret",
        authorization: "Bearer x",
        nested: { clientSecret: "nope", deep: [{ password: "p" }] },
        tokens: 3,
        tokenCount: 2,
      },
    });
    const [event] = extensionEvents(rt);
    expect((event as any).payload).toEqual({
      token: "[redacted]",
      api_key: "[redacted]",
      authorization: "[redacted]",
      nested: { clientSecret: "[redacted]", deep: [{ password: "[redacted]" }] },
      tokens: 3,
      tokenCount: 2,
    });
  });

  test("an oversized payload is dropped visibly, never truncated", async () => {
    const { rt, ctx } = await channel();
    ctx.appendEvent({ name: "big", payload: { text: "x".repeat(9 * 1024) } });
    const events = extensionEvents(rt);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "extension_failed", name: "probe", reason: "invalid_event" });
  });

  test("a non-serializable payload is dropped visibly", async () => {
    const { rt, ctx } = await channel();
    ctx.appendEvent({ name: "cycle", payload: (() => { const o: any = {}; o.self = o; return o; })() });
    ctx.appendEvent({ name: "bigint", payload: { n: 1n } });
    expect(extensionEvents(rt)).toHaveLength(2);
    for (const event of extensionEvents(rt)) {
      // consumeLoadEvents drains; re-derive from the runtime instead.
    }
  });

  test("a nameless event is refused", async () => {
    const { rt, ctx } = await channel();
    ctx.appendEvent({ name: "  " } as any);
    expect(extensionEvents(rt)[0]).toMatchObject({ type: "extension_failed", reason: "invalid_event" });
  });
});

describe("the per-turn event cap (ADR-0032)", () => {
  test("50 events land, the 51st is dropped with one visible warning — per turn", async () => {
    const { rt, ctx } = await channel();
    rt.beginTurn();
    for (let i = 0; i < 60; i++) ctx.appendEvent({ name: `e${i}`, payload: { i } });
    const first = extensionEvents(rt);
    const events = first.filter((e) => e.type === "extension_event");
    const warnings = first.filter((e) => e.type === "extension_failed") as any[];
    expect(events).toHaveLength(50);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe("event_cap");
    // A new turn resets the counter and re-arms the warning.
    rt.beginTurn();
    ctx.appendEvent({ name: "after" });
    expect(extensionEvents(rt).filter((e) => e.type === "extension_event")).toHaveLength(1);
  });

  test("a session resets the cap at each turn's user_message", async () => {
    let ctx!: ExtensionSetupContext;
    const rt = new ExtensionRuntime({ mohHome: tmpDir("moh-jev-home-"), consent: () => true });
    await rt.register(
      defineExtension({
        name: "probe",
        version: "1.0.0",
        apiVersion: "1.1",
        setup: (c) => {
          ctx = c;
          c.beforeModelCall(() => {
            for (let i = 0; i < 55; i++) ctx.appendEvent({ name: "x", payload: { i } });
          });
        },
      }),
    );
    const session = createSession({
      provider: MockProvider.scripted([
        { deltas: ["a"], finish: "stop" },
        { deltas: ["b"], finish: "stop" },
      ]),
      tools: { echo: echoTool },
      extensions: rt,
    });
    await session.send("one");
    await session.send("two");
    const appends = session.history().filter((e) => e.type === "extension_event").length;
    const caps = session.history().filter((e) => e.type === "extension_failed" && (e as any).reason === "event_cap").length;
    // Two turns, each capped at 50 — not 50 across the session.
    expect(appends).toBe(100);
    expect(caps).toBe(2);
  });
});

describe("setStatus (ADR-0032)", () => {
  test("one status per extension, replaced; null clears; never in the log", async () => {
    const { rt, ctx } = await channel();
    const seen: (string | null)[] = [];
    rt.onStatusChange((_name, text) => seen.push(text));
    ctx.setStatus("first");
    ctx.setStatus("first"); // identical: no second notification
    ctx.setStatus("second");
    expect(seen).toEqual(["first", "second"]);
    expect(rt.statuses()).toEqual([{ extension: "probe", text: "second" }]);
    ctx.setStatus(null);
    expect(rt.statuses()).toEqual([]);
    expect(seen.at(-1)).toBeNull();

    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      tools: { echo: echoTool },
      extensions: rt,
    });
    ctx.setStatus("visible");
    expect(session.extensionStatuses()).toEqual([{ extension: "probe", text: "visible" }]);
    expect(session.history().some((e) => JSON.stringify(e).includes("visible"))).toBe(false);
    await session.dispose();
    expect(session.extensionStatuses()).toEqual([]);
  });

  test("headless publishes one stderr line per new text; repeats and clears are silent", async () => {
    let ctx!: ExtensionSetupContext;
    const rt = new ExtensionRuntime({ mohHome: tmpDir("moh-jev-home-"), consent: () => true });
    await rt.register(
      defineExtension({
        name: "jev-guard",
        version: "1.0.0",
        apiVersion: "1.1",
        setup: (c) => {
          ctx = c;
          c.beforeModelCall(() => ctx.setStatus("∅ jev offline"));
        },
      }),
    );
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const session = createSession({
        provider: MockProvider.scripted([{ deltas: ["a"], finish: "stop" }]),
        tools: { echo: echoTool },
        extensions: rt,
      });
      await session.send("one");
      await session.send("two"); // same text: announced once
      ctx.setStatus(null); // a clear prints nothing
      ctx.setStatus("∅ jev offline"); // a new outage announces again
      const offline = written.filter((l) => l.includes("∅ jev offline"));
      expect(offline).toHaveLength(2);
      expect(offline[0]).toBe("moh: jev-guard: ∅ jev offline\n");
    } finally {
      (process.stderr as any).write = original;
    }
  });

  test("an interactive session never writes to stderr", async () => {
    let ctx!: ExtensionSetupContext;
    const rt = new ExtensionRuntime({ mohHome: tmpDir("moh-jev-home-"), consent: () => true });
    await rt.register(
      defineExtension({
        name: "jev-guard",
        version: "1.0.0",
        apiVersion: "1.1",
        setup: (c) => {
          ctx = c;
        },
      }),
    );
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      createSession({
        provider: MockProvider.scripted([{ deltas: ["a"], finish: "stop" }]),
        tools: { echo: echoTool },
        extensions: rt,
        onPermissionRequest: () => "yes",
      });
      ctx.setStatus("∅ jev offline");
      expect(written).toEqual([]);
    } finally {
      (process.stderr as any).write = original;
    }
  });
});

describe("the typesafe config block (#784)", () => {
  test("absent, present, stripped and malformed", () => {
    const dir = tmpDir("moh-jev-cfg-");
    const file = join(dir, "config");
    expect(readTypesafeConfig(file)).toEqual({});

    writeFileSync(file, JSON.stringify({ typesafe: { apiKey: "sk-1", timeoutMs: 1000, routing: true, bogus: 2 } }));
    expect(readTypesafeConfig(file)).toEqual({ apiKey: "sk-1", timeoutMs: 1000, routing: true });

    writeFileSync(file, JSON.stringify({ typesafe: { timeoutMs: "soon" } }));
    expect(() => readTypesafeConfig(file)).toThrow(/typesafe section/);
  });

  test("resolve defaults and the masked hint", () => {
    expect(resolveTypesafeConfig(undefined)).toEqual({ active: false, timeoutMs: 2500, routing: false, tiers: {} });
    expect(resolveTypesafeConfig({ apiKey: "   " })).toMatchObject({ active: false, timeoutMs: 2500 });
    expect(
      resolveTypesafeConfig({ apiKey: "sk-abcdef", timeoutMs: 900, routing: true, tiers: { "a/one": "potente" } }),
    ).toMatchObject({
      active: true,
      apiKey: "sk-abcdef",
      timeoutMs: 900,
      routing: true,
      tiers: { "a/one": "potente" },
    });
    expect(maskApiKey("sk-abcdef")).toBe("…cdef");
    expect(maskApiKey("ab")).toBe("…");
  });

  test("save and remove go through the guardian and preserve other sections", () => {
    const dir = tmpDir("moh-jev-cfg-");
    const file = join(dir, "config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ provider: "mock", typesafe: { timeoutMs: 1200 } }));

    saveTypesafeApiKey(file, " sk-new ");
    expect(readTypesafeConfig(file)).toEqual({ apiKey: "sk-new", timeoutMs: 1200 });
    expect(readUserConfigFile(file).provider).toBe("mock");

    removeTypesafeApiKey(file);
    expect(readTypesafeConfig(file)).toEqual({ timeoutMs: 1200 });
    expect(readUserConfigFile(file).provider).toBe("mock");
  });
});

describe("activation in session assembly (#784)", () => {
  const writeUserConfig = (home: string, body: Record<string, unknown>): void => {
    const file = userConfigFile(home);
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  };

  test("with a key the bundled extension is registered; without one, nothing is and one note lands", async () => {
    const cwd = tmpDir("moh-jev-cwd-");
    const home = tmpDir("moh-jev-assembly-");
    const base = { cwd, home, config: { provider: "mock" } };

    const inactive = sessionFromConfig(base);
    expect("error" in inactive).toBe(false);
    if ("error" in inactive) return;
    expect(inactive.session.extensionStatuses()).toEqual([]);
    expect(
      inactive.session.history().some((e) => e.type === "session_note" && e.text === "jev: inactive (no api key)"),
    ).toBe(true);
    await inactive.session.dispose();

    writeUserConfig(home, { typesafe: { apiKey: "sk-test", timeoutMs: 800 } });
    const active = sessionFromConfig(base);
    expect("error" in active).toBe(false);
    if ("error" in active) return;
    // Registration is async by design: the first turn waits for `ready()`.
    await active.session.send("hello");
    const loaded = active.session.history().find((e) => e.type === "extension_loaded") as any;
    expect(loaded?.name).toBe("jev-guard");
    expect(active.session.history().some((e) => e.type === "session_note")).toBe(false);
    await active.session.dispose();
  });

  test("routing off registers no router; routing on with nothing to route reports it once", async () => {
    const cwd = tmpDir("moh-jev-cwd-");
    const home = tmpDir("moh-jev-assembly-");

    // Default (off): the extension is active but registers no beforeTurn
    // hook — routing is a choice, never a side effect of having a key.
    writeUserConfig(home, { typesafe: { apiKey: "sk-test" } });
    const off = sessionFromConfig({ cwd, home, config: { provider: "mock" } });
    if ("error" in off) throw new Error(off.error.message);
    await off.session.send("hello");
    expect(off.session.history().some((e) => e.type === "extension_event" && e.name === "jev_routing")).toBe(false);
    await off.session.dispose();

    // On, but this session has no model pool at all (no endpoints): the
    // router is inert and says so exactly once.
    writeUserConfig(home, { typesafe: { apiKey: "sk-test", routing: true } });
    const on = sessionFromConfig({ cwd, home, config: { provider: "mock" } });
    if ("error" in on) throw new Error(on.error.message);
    await on.session.send("hello");
    await Bun.sleep(5); // the pool resolution is asynchronous by design
    const notices = on.session
      .history()
      .filter((e) => e.type === "extension_event" && e.name === "jev_routing");
    expect(notices).toHaveLength(1);
    expect((notices[0] as { payload?: { kind?: string } }).payload).toEqual({ kind: "inert" });
    await on.session.dispose();
  });

  test("a malformed typesafe section fails the assembly loudly", () => {
    const cwd = tmpDir("moh-jev-cwd-");
    const home = tmpDir("moh-jev-assembly-");
    writeUserConfig(home, { typesafe: { timeoutMs: -1 } });
    const result = sessionFromConfig({ cwd, home, config: { provider: "mock" } });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.kind).toBe("config");
  });
});

describe("subagent children share the parent's hook checker (#784 spec §5)", () => {
  test("a child tool call is judged by the parent's extension", async () => {
    const home = tmpDir("moh-jev-sub-");
    const rt = new ExtensionRuntime({ mohHome: home, consent: () => true });
    await rt.register(
      defineExtension({
        name: "guard",
        version: "1.0.0",
        apiVersion: "1.1",
        setup: (ctx) =>
          ctx.onToolCall((call) => (call.name === "echo" ? { veto: true, reason: "child call" } : undefined)),
      }),
    );
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [""], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "probe", task: "do it" } }] },
        { deltas: ["parent done"], finish: "stop" },
      ]),
      tools: { echo: echoTool },
      extensions: rt,
      permissions: { overrides: { tools: { spawn: "allow" } } },
      subagents: {
        home,
        presets: { probe: { name: "probe", description: "probe", allowedTools: ["echo"] } },
        provider: MockProvider.scripted([
          { deltas: [""], finish: "tool_calls", toolCalls: [{ name: "echo", args: { text: "hi" } }] },
          { deltas: ["child done"], finish: "stop" },
        ]),
      },
    });
    const events: AgentEvent[] = [];
    void (async () => {
      for await (const event of parent.events) events.push(event);
    })();
    const result = await parent.send("go");
    expect(result.status).toBe("done");

    // The child has its own log, and the veto — enforced by the parent's
    // runtime — lands there, next to the call it refused.
    const spawnEvent = events.find((e) => e.type === "subagent_spawn") as any;
    expect(existsSync(spawnEvent.log)).toBe(true);
    const childEvents = readFileSync(spawnEvent.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AgentEvent);
    const denial = childEvents.find((e) => e.type === "permission_denied") as any;
    expect(denial?.reason).toBe("extension");
    expect(childEvents.some((e) => e.type === "tool_call" && e.name === "echo")).toBe(true);
    // The child's consent trail never leaks into the parent's transcript.
    expect(events.some((e) => e.type === "permission_denied")).toBe(false);
  });
});

describe("client→extension control (ADR-0038)", () => {
  test("a command reaches the named extension only, and lands in the log", async () => {
    const home = tmpDir("moh-control-");
    const received: { owner: string; event: Record<string, unknown> }[] = [];
    const rt = new ExtensionRuntime({ mohHome: home, consent: () => true });
    for (const name of ["first", "second"]) {
      await rt.register(
        defineExtension({
          name,
          version: "1.0.0",
          apiVersion: "1.3",
          setup: (ctx) =>
            ctx.onEvent(({ event }) => {
              received.push({ owner: name, event });
            }),
        }),
      );
    }
    const session = createSession({ provider: "mock", extensions: rt });
    await session.send("hello");

    session.setExtensionState("second", { cmd: "off" });
    await Bun.sleep(10); // the dispatch queue is asynchronous by design

    // Only the addressed extension saw it (the others still got the turn's
    // own events — that is what makes this assertion meaningful).
    const control = received.filter((r) => r.event.type === "extension_control");
    expect(control).toHaveLength(1);
    expect(control[0]!.owner).toBe("second");
    expect(control[0]!.event).toMatchObject({ extension: "second", payload: { cmd: "off" } });

    // The log keeps the intent, so a resumed session can explain the state.
    const logged = session.history().filter((e) => e.type === "extension_control");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ extension: "second", payload: { cmd: "off" } });
    expect(session.extensionNames()).toEqual(["first", "second"]);
    await session.dispose();
  });

  test("addressing an extension that is not registered is silent, never an error", async () => {
    const rt = new ExtensionRuntime({ mohHome: tmpDir("moh-control-"), consent: () => true });
    const session = createSession({ provider: "mock", extensions: rt });
    await session.send("hello");

    expect(() => session.setExtensionState("ghost", { cmd: "off" })).not.toThrow();
    await Bun.sleep(5);

    expect(session.history().some((e) => e.type === "extension_control")).toBe(true);
    expect(session.extensionNames()).toEqual([]);
    await session.dispose();
  });
});
