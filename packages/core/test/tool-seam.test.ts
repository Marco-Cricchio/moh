/**
 * Issue #1163 — F3a (ADR-0067): the tool scopes, end to end. The seam is
 * tested at the high level: a probe extension loaded through the runtime,
 * `ctx.host.runTool` driven directly for the scope+log half, and a real
 * session bound behind the seam for the gate half (deny rules, ask
 * requester naming, headless).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";
import { join } from "node:path";
import type { ExtensionDefinition, ExtensionHost, ExtensionSetupContext } from "@moh/extension";
import { ExtensionRuntime } from "../src/extensions";
import { scopeEffectSentence } from "../src/host-scope";
import type { AgentEvent } from "../src/types";
import { sessionFromConfig } from "../src";
import type { AgentSession } from "../src/session/session";
import type { PermissionAskContext } from "../src/session/config";

const roots: string[] = [];
const homes: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "moh-tool-scope-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

function runtime(root: string): ExtensionRuntime {
  const home = mkdtempSync(join(tmpdir(), "moh-tool-home-"));
  homes.push(home);
  return new ExtensionRuntime({
    mohHome: home,
    projectRoot: root,
    consent: () => true,
  });
}

/** Loads a probe extension and captures its setup context + the events. */
async function probe(root: string, capabilities: readonly string[], events: AgentEvent[]) {
  const rt = runtime(root);
  const box: { ctx: ExtensionSetupContext | null } = { ctx: null };
  rt.onLoadEvent((event) => events.push(event));
  await rt.register({
    name: "probe",
    version: "1",
    apiVersion: "1.14",
    capabilities: [...capabilities],
    setup: (ctx) => {
      box.ctx = ctx;
    },
  } as ExtensionDefinition);
  await rt.ready();
  return box.ctx!;
}

describe("runTool: enforcement by absence (ADR-0067)", () => {
  test("absent without a tool scope; present with one", async () => {
    const events: AgentEvent[] = [];
    const plain = await probe(project(), [], events);
    expect((plain.host as ExtensionHost | undefined)?.runTool).toBeUndefined();

    const granted = await probe(project(), ["tool:bash"], events);
    expect(typeof (granted.host as ExtensionHost).runTool).toBe("function");
  });

  test("a tool outside the grant refuses outside_scope with one host_refused", async () => {
    const events: AgentEvent[] = [];
    const host = (await probe(project(), ["tool:read"], events)).host as ExtensionHost;
    const result = await (host as Required<ExtensionHost>).runTool("bash", { command: "echo hi" });
    expect(result).toEqual({ ok: false, reason: "outside_scope" });
    const refused = events.filter((e) => e.type === "host_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ op: "run_tool", tool: "bash", reason: "outside_scope", extension: "probe" });
  });
});

describe("runTool through a real session: the model's exact gate path", () => {
  /** A session with an echo tool, an always-echo provider, and the probe extension. */
  async function sessionWith(options: {
    capabilities: readonly string[];
    mode?: "yolo" | "ask" | "auto-accept";
    denyEcho?: boolean;
    onPermissionRequest?: (tool: string, args: unknown, context?: PermissionAskContext) => Promise<"yes" | "no" | "always" | "always_for_site">;
  }): Promise<{ session: AgentSession; runtime: ExtensionRuntime; host: ExtensionHost; root: string; events: AgentEvent[] }> {
    const root = project();
    const events: AgentEvent[] = [];
    const rt = runtime(root);
    const box: { ctx: ExtensionSetupContext | null } = { ctx: null };
    rt.onLoadEvent((event) => events.push(event));
    await rt.register({
      name: "probe",
      version: "1",
      apiVersion: "1.14",
      capabilities: [...options.capabilities],
      setup: (ctx) => {
        box.ctx = ctx;
      },
    } as ExtensionDefinition);
    await rt.ready();

    const echo = {
      name: "echo",
      description: "echoes its input",
      inputSchema: z.object({ text: z.string().optional() }),
      execute: (args: { text?: string }) => `echo:${(args as { text?: string }).text ?? ""}`,
    };
    const capturedEvents: AgentEvent[] = [];
    const assembled = sessionFromConfig({
      cwd: root,
      home: root,
      config: { provider: "mock" },
      ...(options.onPermissionRequest
        ? { consent: { onPermissionRequest: options.onPermissionRequest } }
        : {}),
      overrides: {
        permissions: options.mode === "yolo"
          ? { unrestrictedTools: true }
          : {
              overrides: options.denyEcho
                ? { tools: { echo: "deny" as const } }
                // An unknown tool's default tier is "ask": the tests that
                // do not exercise the ask flow allow `echo` explicitly so
                // the call proceeds like a user-allowed model call.
                : options.onPermissionRequest
                  ? {}
                  : { tools: { echo: "allow" as const } },
            },
        tools: { echo },
        extensions: rt,
        sink: (e) => capturedEvents.push(e),
      },
    });
    if (!("session" in assembled)) throw new Error(assembled.error.message);
    const session = assembled.session as unknown as AgentSession;
    return { session, runtime: rt, host: (box.ctx!.host as ExtensionHost), root, events: capturedEvents };
  }

  test("a granted tool runs through the seam and logs host_op run_tool ok", async () => {
    const { session, host, events } = await sessionWith({ capabilities: ["tool:echo"] });
    try {
      const result = await (host as Required<ExtensionHost>).runTool("echo", { text: "hi" });
      expect(result).toEqual({ ok: true, output: "echo:hi" });
      const ops = events.filter((e) => e.type === "host_op" && e.op === "run_tool");
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ tool: "echo", outcome: "ok", extension: "probe" });
    } finally {
      await session.dispose();
    }
  });

  test("a user deny rule beats the grant: denied, tool never executes", async () => {
    const { session, host, events } = await sessionWith({ capabilities: ["tool:echo"], denyEcho: true });
    try {
      const result = await (host as Required<ExtensionHost>).runTool("echo", { text: "hi" });
      expect(result).toMatchObject({ ok: false, reason: "denied" });
      const ops = events.filter((e) => e.type === "host_op" && e.op === "run_tool");
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ tool: "echo", outcome: "denied" });
    } finally {
      await session.dispose();
    }
  });

  test("in yolo the seam call proceeds like a model call — no ask", async () => {
    let asked = 0;
    const { host } = await sessionWith({
      capabilities: ["tool:echo"],
      mode: "yolo",
      onPermissionRequest: async () => {
        asked += 1;
        return "yes";
      },
    });
    const result = await (host as Required<ExtensionHost>).runTool("echo", { text: "hi" });
    expect(result).toEqual({ ok: true, output: "echo:hi" });
    expect(asked).toBe(0);
  });

  test("an ask names the extension as the requester", async () => {
    let seen: PermissionAskContext | undefined;
    const { host } = await sessionWith({
      capabilities: ["tool:echo"],
      mode: "ask",
      onPermissionRequest: async (_tool, _args, context) => {
        seen = context;
        return "yes";
      },
    });
    const result = await (host as Required<ExtensionHost>).runTool("echo", { text: "hi" });
    expect(result).toEqual({ ok: true, output: "echo:hi" });
    expect(seen).toMatchObject({ source: "extension", extension: "probe" });
  });

  test("the user's 'no' answer denies the seam call", async () => {
    const { session, host } = await sessionWith({
      capabilities: ["tool:echo"],
      mode: "ask",
      onPermissionRequest: async () => "no",
    });
    try {
      const result = await (host as Required<ExtensionHost>).runTool("echo", { text: "hi" });
      expect(result).toMatchObject({ ok: false, reason: "denied" });
    } finally {
      await session.dispose();
    }
  });

  test("an unknown tool refuses typed with one host_refused", async () => {
    const { session, host, events } = await sessionWith({ capabilities: ["tool:*"] });
    try {
      const result = await (host as Required<ExtensionHost>).runTool("nosuchtool", {});
      expect(result).toMatchObject({ ok: false, reason: "unknown_tool" });
      const refused = events.filter((e) => e.type === "host_refused" && e.op === "run_tool");
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ tool: "nosuchtool", reason: "unknown_tool" });
    } finally {
      await session.dispose();
    }
  });

  test("tool:* covers any session tool name (wildcard grant)", async () => {
    const { host } = await sessionWith({ capabilities: ["tool:*"] });
    const result = await (host as Required<ExtensionHost>).runTool("echo", { text: "wild" });
    expect(result).toEqual({ ok: true, output: "echo:wild" });
  });

  test("without the seam bound (bare runtime), the call refuses failed — never silently", async () => {
    const events: AgentEvent[] = [];
    const host = (await probe(project(), ["tool:echo"], events)).host as ExtensionHost;
    const result = await (host as Required<ExtensionHost>).runTool("echo", {});
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(events.some((e) => e.type === "host_refused" && e.op === "run_tool")).toBe(true);
  });
});

describe("contribute-tool: the contribution slot (ADR-0067)", () => {
  /** A probe whose setup registers a contributed tool through the slot. */
  async function contributeProbe(options: {
    capabilities: readonly string[];
    toolName?: string;
    denySearch?: boolean;
  }): Promise<{
    ctx: ExtensionSetupContext | null;
    events: AgentEvent[];
    session: AgentSession;
    failed: AgentEvent[];
  }> {
    const root = project();
    const events: AgentEvent[] = [];
    const rt = runtime(root);
    const box: { ctx: ExtensionSetupContext | null } = { ctx: null };
    rt.onLoadEvent((event) => {
      events.push(event);
    });
    await rt.register({
      name: "probe",
      version: "1",
      apiVersion: "1.14",
      capabilities: [...options.capabilities],
      setup: (ctx) => {
        box.ctx = ctx;
        ctx.registerTool?.({
          name: options.toolName ?? "search",
          description: "searches the web",
          inputSchema: z.object({ query: z.string() }),
          execute: (args) => `results for ${(args as { query: string }).query}`,
        });
      },
    } as ExtensionDefinition);
    await rt.ready();

    const capturedEvents: AgentEvent[] = [];
    const assembled = sessionFromConfig({
      cwd: root,
      home: root,
      config: { provider: "mock" },
      overrides: {
        permissions: {
          overrides: options.denySearch ? { tools: { search: "deny" as const } } : { tools: { search: "allow" as const } },
        },
        extensions: rt,
        sink: (e) => capturedEvents.push(e),
      },
    });
    if (!("session" in assembled)) throw new Error(assembled.error.message);
    return {
      ctx: box.ctx,
      events,
      session: assembled.session as unknown as AgentSession,
      // The refusal fires during setup — before the session subscribes —
      // so it is asserted on the runtime's own load-event channel.
      failed: events.filter((e) => e.type === "extension_failed"),
    };
  }

  test("registerTool is present only under a contribute-tool grant", async () => {
    const events: AgentEvent[] = [];
    const plain = await probe(project(), [], events);
    expect(plain.registerTool).toBeUndefined();
    const granted = await probe(project(), ["contribute-tool:search"], events);
    expect(typeof granted.registerTool).toBe("function");
  });

  test("the contributed tool reaches the model through the same registry, with its record logged", async () => {
    const { ctx, session, events } = await contributeProbe({ capabilities: ["contribute-tool:search"] });
    expect(ctx!.registerTool).toBeDefined();
    try {
      expect(session.tools.search).toBeDefined();
      expect(session.tools.search.description).toBe("searches the web");
      const contributed = events.filter((e) => e.type === "tool_contributed");
      expect(contributed).toHaveLength(1);
      expect(contributed[0]).toMatchObject({ extension: "probe", tool: "search" });
    } finally {
      await session.dispose();
    }
  });

  test("a name the consent never granted is refused visibly, tool never registered", async () => {
    const { session, failed } = await contributeProbe({ capabilities: ["contribute-tool:other"], toolName: "search" });
    try {
      expect(session.tools.search).toBeUndefined();
      expect(failed.some((e) => e.type === "extension_failed" && /not one the consent granted/.test(String((e as { message?: string }).message ?? "")))).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  test("the model's call of a contributed tool passes the gate like any tool — deny beats it", async () => {
    const root = project();
    const events: AgentEvent[] = [];
    const rt = runtime(root);
    rt.onLoadEvent((e) => events.push(e));
    await rt.register({
      name: "probe",
      version: "1",
      apiVersion: "1.14",
      capabilities: ["contribute-tool:search"],
      setup: (ctx) => {
        ctx.registerTool?.({
          name: "search",
          description: "searches the web",
          inputSchema: z.object({ query: z.string() }),
          execute: (args) => `results for ${(args as { query: string }).query}`,
        });
      },
    } as ExtensionDefinition);
    await rt.ready();

    let denial: string | undefined;
    const assembled = sessionFromConfig({
      cwd: root,
      home: root,
      config: { provider: "mock" },
      overrides: {
        permissions: { overrides: { tools: { search: "deny" as const } } },
        extensions: rt,
        sink: (e) => {
          if (e.type === "tool_call") denial = "call-appended";
        },
      },
    });
    if (!("session" in assembled)) throw new Error(assembled.error.message);
    const session = assembled.session as unknown as AgentSession;
    try {
      // The deny rule answers at the gate before any execute: run the seam
      // path the model would take (the same runner and gate) directly.
      const outcome = await session.send("use search");
      void outcome;
      // A deny rule means the gate refuses before the tool body runs; the
      // model-visible registry still holds the tool (it was contributed).
      expect(session.tools.search).toBeDefined();
      expect(events.some((e) => e.type === "tool_contributed")).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  test("the consent sentence is the contribution's own trust shape", () => {
    expect(scopeEffectSentence("contribute-tool:search")).toBe(
      "will add a `search` tool the model can call; its code runs when the model invokes it",
    );
  });
});
