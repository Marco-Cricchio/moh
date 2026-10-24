/**
 * #1438 characterization: the binding between `ExtensionRuntime` and the
 * session that owns it. Driven through the public surface only — a runtime,
 * an extension's setup context and `createSession` (which binds) — so the
 * pins hold whatever shape the binding has inside.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ExtensionDefinition, ExtensionHost, ExtensionSetupContext } from "@moh/extension";
import { ExtensionRuntime } from "../src/extensions";
import { createSession, MockProvider } from "../src";
import type { AgentEvent } from "../src/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function project(): string {
  const root = tempDir("moh-port-root-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

function runtime(root: string): ExtensionRuntime {
  return new ExtensionRuntime({ mohHome: tempDir("moh-port-home-"), projectRoot: root, consent: () => true });
}

/** Registers a probe extension and returns its setup context. */
async function probe(
  rt: ExtensionRuntime,
  capabilities: readonly string[],
  setup: (ctx: ExtensionSetupContext) => void = () => {},
): Promise<ExtensionSetupContext> {
  const box: { ctx: ExtensionSetupContext | null } = { ctx: null };
  await rt.register({
    name: "probe",
    version: "1",
    apiVersion: "1.15",
    capabilities: [...capabilities],
    setup: (ctx) => {
      box.ctx = ctx;
      setup(ctx);
    },
  } as ExtensionDefinition);
  await rt.ready();
  return box.ctx!;
}

/** A scripted provider that records the tool names of every request. */
function recordingProvider(): { provider: MockProvider; toolNames: string[][] } {
  const provider = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
  const toolNames: string[][] = [];
  const stream = provider.stream.bind(provider);
  provider.stream = (messages, signal, tools, options) => {
    toolNames.push((tools ?? []).map((t) => t.name));
    return stream(messages, signal, tools, options);
  };
  return { provider, toolNames };
}

function echoTool(label: string) {
  return {
    name: "echo",
    description: "echoes its input",
    inputSchema: z.object({}),
    execute: () => `echo:${label}`,
  };
}

function sessionOn(rt: ExtensionRuntime, root: string, extra: { label?: string; denyA?: boolean; provider?: MockProvider } = {}) {
  return createSession({
    provider: extra.provider ?? MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
    cwd: root,
    tools: { echo: echoTool(extra.label ?? "one") },
    extensions: rt,
    permissions: {
      runtimeRules: [
        { tool: "echo", effect: "allow", tier: "runtime" },
        ...(extra.denyA ? [{ tool: "read", path: "src/a.ts", effect: "deny" as const, tier: "runtime" as const }] : []),
      ],
    },
  });
}

const types = (events: readonly AgentEvent[]) => events.map((e) => e.type);

describe("requestTurn across the binding", () => {
  test("without a session, the request is refused with a visible extension_failed", async () => {
    const root = project();
    const rt = runtime(root);
    const events: AgentEvent[] = [];
    rt.onLoadEvent((e) => events.push(e));
    const ctx = await probe(rt, []);
    expect(await ctx.requestTurn("do it")).toBe(false);
    expect(events.filter((e) => e.type === "extension_failed")).toEqual([
      { type: "extension_failed", name: "probe", reason: "request_turn", message: "no turn entry on this session" },
    ]);
  });

  test("with a session bound: blank text is refused by the runtime; a real request runs a synthetic turn in that session", async () => {
    const root = project();
    const rt = runtime(root);
    const ctx = await probe(rt, []);
    const session = sessionOn(rt, root);
    try {
      expect(await ctx.requestTurn("   ")).toBe(false);
      expect(await ctx.requestTurn("please fix")).toBe(true);
      const history = session.history();
      expect(history.filter((e) => e.type === "extension_failed")).toMatchObject([
        { type: "extension_failed", name: "probe", reason: "request_turn", message: "requestTurn requires non-empty text" },
      ]);
      expect(history.filter((e) => e.type === "user_message")).toMatchObject([{ text: "please fix", synthetic: true }]);
    } finally {
      await session.dispose();
    }
  });
});

describe("host seams before any session is bound", () => {
  test("runTool, modelCall and listModels refuse failed, each with one host_refused", async () => {
    const root = project();
    const rt = runtime(root);
    const events: AgentEvent[] = [];
    rt.onLoadEvent((e) => events.push(e));
    const ctx = await probe(rt, ["tool:echo", "endpoint:ep"]);
    const host = ctx.host as Required<ExtensionHost>;
    const message = "no session is bound to this extension runtime";
    expect(await host.runTool("echo", {})).toEqual({ ok: false, reason: "failed", message });
    expect(await host.modelCall({ endpoint: "ep", model: "m", messages: [{ role: "user", content: "hi" }] })).toEqual({ ok: false, reason: "failed", message });
    expect(await host.listModels("ep")).toEqual({ ok: false, reason: "failed", message });
    const refusals = events.filter((e) => e.type === "host_refused").map(({ callId: _callId, ...rest }) => rest);
    expect(refusals).toEqual([
      { type: "host_refused", extension: "probe", op: "run_tool", tool: "echo", reason: "failed" },
      { type: "host_refused", extension: "probe", op: "model_call", reason: "failed", model: "ep/m" },
      { type: "host_refused", extension: "probe", op: "list_models", reason: "failed", model: "ep" },
    ]);
  });
});

describe("the session's path deny", () => {
  test("an extension set up after the session is bound: the session's deny beats the grant", async () => {
    const root = project();
    const rt = runtime(root);
    const session = sessionOn(rt, root, { denyA: true });
    try {
      const ctx = await probe(rt, ["path:src/**"]);
      const result = await (ctx.host as ExtensionHost).readFile("src/a.ts");
      expect(result).toMatchObject({ ok: false, reason: "denied" });
      expect(session.history().filter((e) => e.type === "host_refused")).toMatchObject([{ op: "read", reason: "denied" }]);
    } finally {
      await session.dispose();
    }
  });

  test("an extension set up before the session is bound keeps the deny answer it was built with (none)", async () => {
    // Current behavior, pinned (not endorsed): the file host captures the
    // deny answer when it is built, so a deny bound later never reaches it.
    // Draft issue in the #1438 PR ("path deny captured at setup").
    const root = project();
    const rt = runtime(root);
    const ctx = await probe(rt, ["path:src/**"]);
    const session = sessionOn(rt, root, { denyA: true });
    try {
      const result = await (ctx.host as ExtensionHost).readFile("src/a.ts");
      expect(result.ok).toBe(true);
    } finally {
      await session.dispose();
    }
  });
});

describe("contributed tools across the binding", () => {
  const registerSearch = (ctx: ExtensionSetupContext) => {
    ctx.registerTool?.({ name: "search", description: "searches", execute: () => "results" });
  };

  test("a registration made before the session is held: applied at bind, logged after the load, visible in the first request", async () => {
    const root = project();
    const rt = runtime(root);
    await probe(rt, ["contribute-tool:search"], registerSearch);
    const { provider, toolNames } = recordingProvider();
    const session = sessionOn(rt, root, { provider });
    try {
      expect(session.tools.search).toBeDefined();
      await session.send("hi");
      expect(types(session.history())).toEqual([
        "session_start",
        "session_mode",
        "extension_loaded",
        "tool_contributed",
        "user_message",
        "assistant_delta",
        "model_call",
        "done",
      ]);
      expect(session.history().find((e) => e.type === "tool_contributed")).toMatchObject({ extension: "probe", tool: "search" });
      expect(toolNames[0]).toContain("search");
    } finally {
      await session.dispose();
    }
  });

  test("a registration made after the session is bound: the tool is applied and logs exactly one tool_contributed", async () => {
    // #1598: the record no longer depends on load timing — a file extension
    // loaded in a fresh process registers after the bind, like this probe.
    const root = project();
    const rt = runtime(root);
    const session = sessionOn(rt, root);
    try {
      await probe(rt, ["contribute-tool:search"], registerSearch);
      expect(session.tools.search).toBeDefined();
      await session.send("hi");
      const contributed = session.history().filter((e) => e.type === "tool_contributed");
      expect(contributed).toMatchObject([{ type: "tool_contributed", extension: "probe", tool: "search" }]);
    } finally {
      await session.dispose();
    }
  });

  test("a held registration is logged once at bind, never again by a later registration", async () => {
    const root = project();
    const rt = runtime(root);
    await probe(rt, ["contribute-tool:search"], registerSearch);
    const session = sessionOn(rt, root);
    try {
      await rt.register({
        name: "late",
        version: "1",
        apiVersion: "1.15",
        capabilities: ["contribute-tool:other"],
        setup: (ctx: ExtensionSetupContext) => {
          ctx.registerTool?.({ name: "other", description: "other", execute: () => "x" });
        },
      } as ExtensionDefinition);
      await rt.ready();
      await session.send("hi");
      const contributed = session.history().filter((e) => e.type === "tool_contributed");
      expect(contributed).toMatchObject([
        { extension: "probe", tool: "search" },
        { extension: "late", tool: "other" },
      ]);
    } finally {
      await session.dispose();
    }
  });
});

describe("one runtime, two sessions: the last binding wins", () => {
  test("requestTurn and runTool reach the second session; held tools went to the first only", async () => {
    const root = project();
    const rt = runtime(root);
    const ctx = await probe(rt, ["tool:echo", "contribute-tool:search"], (c) => {
      c.registerTool?.({ name: "search", description: "searches", execute: () => "results" });
    });
    const first = sessionOn(rt, root, { label: "one" });
    const second = sessionOn(rt, root, { label: "two" });
    try {
      expect(first.tools.search).toBeDefined();
      expect(second.tools.search).toBeUndefined();
      expect(await (ctx.host as Required<ExtensionHost>).runTool("echo", {})).toEqual({ ok: true, output: "echo:two" });
      expect(await ctx.requestTurn("from the extension")).toBe(true);
      expect(second.history().filter((e) => e.type === "user_message")).toMatchObject([{ text: "from the extension", synthetic: true }]);
      expect(first.history().filter((e) => e.type === "user_message")).toEqual([]);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
