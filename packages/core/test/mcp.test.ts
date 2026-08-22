import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, McpRuntime, MockProvider, type AgentEvent, type DeclaredMcpServer } from "../src/index";
import { McpError } from "../src/mcp";

const SERVER = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");

function stdioServer(mode: string, name = "srv"): DeclaredMcpServer {
  return {
    name,
    scope: "user",
    transport: { type: "stdio", command: process.execPath, args: [SERVER, mode] },
  };
}

function makeRuntime(servers: DeclaredMcpServer[], events: AgentEvent[], opts: Partial<ConstructorParameters<typeof McpRuntime>[0]> = {}): McpRuntime {
  return new McpRuntime({
    servers,
    onEvent: (e) => events.push(e),
    handshakeTimeoutMs: 5_000,
    ...opts,
  });
}

describe("McpRuntime (stdio)", () => {
  test("registers tools as mcp__<server>__<tool> under the standard Tool contract", async () => {
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([stdioServer("ok")], events);
    await runtime.ensureStarted();
    const tools = runtime.tools;
    expect(Object.keys(tools)).toEqual(["mcp__srv__echo"]);
    expect(tools["mcp__srv__echo"]!.description).toContain("Echo");
    const out = await tools["mcp__srv__echo"]!.execute({ text: "hi" }, { signal: new AbortController().signal, cwd: process.cwd(), onProgress: () => {} });
    expect(out).toBe("echo: hi");
    expect(events.map((e) => e.type)).toContain("mcp_server_started");
    await runtime.shutdown();
    expect(events.filter((e) => e.type === "mcp_server_stopped")).toHaveLength(1);
  });

  test("duplicate server names are a startup validation error", () => {
    expect(() => McpRuntime.validate([stdioServer("ok", "dup"), stdioServer("ok", "dup")])).toThrow(/duplicate MCP server name/);
  });

  test("lazy: nothing starts until ensureStarted(); handshake timeout is categorized", async () => {
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([stdioServer("ok")], events);
    expect(runtime.status()[0]!.state).toBe("stopped");
    expect(events).toHaveLength(0);
    await runtime.shutdown();

    const timed = makeRuntime([stdioServer("silent")], events, { handshakeTimeoutMs: 300 });
    await timed.ensureStarted();
    const failure = events.find((e) => e.type === "mcp_server_failed") as Extract<AgentEvent, { type: "mcp_server_failed" }>;
    expect(failure?.reason).toBe("handshake_timeout");
    expect(timed.status()[0]!.state).toBe("failed");
    expect(Object.keys(timed.tools)).toHaveLength(0);
  });

  test("project server asks consent; decline skips it, 'always' persists trust", async () => {
    const events: AgentEvent[] = [];
    const asked: string[] = [];
    const trusted: string[] = [];
    // declined
    const no = makeRuntime([{ name: "p", scope: "project", transport: stdioServer("ok").transport }], events, {
      onConsent: (s) => {
        asked.push(s);
        return "no";
      },
    });
    await no.ensureStarted();
    expect(asked).toEqual(["p"]);
    expect(no.status()[0]!.state).toBe("denied");
    expect(Object.keys(no.tools)).toHaveLength(0);
    expect(events.some((e) => e.type === "permission_requested" && e.tool === "mcp__p")).toBe(true);
    expect(events.some((e) => e.type === "permission_denied" && e.reason === "user")).toBe(true);

    // "always"
    const yes = makeRuntime([{ name: "p", scope: "project", transport: stdioServer("ok").transport }], [], {
      onConsent: () => "always",
      onTrust: (s) => trusted.push(s),
    });
    await yes.ensureStarted();
    expect(trusted).toEqual(["p"]);
    expect(Object.keys(yes.tools)).toEqual(["mcp__p__echo"]);
    await yes.shutdown();
  });

  test("user-declared server never asks; its tools are reported for allow-listing", async () => {
    const trustedTools: string[][] = [];
    const runtime = makeRuntime([stdioServer("ok")], [], { onTrustedTools: (t) => trustedTools.push(t) });
    await runtime.ensureStarted();
    expect(trustedTools).toEqual([["mcp__srv__echo"]]);
    await runtime.shutdown();
  });

  test("headless (no consent callback) denies project servers", async () => {
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([{ name: "p", scope: "project", transport: stdioServer("ok").transport }], events);
    await runtime.ensureStarted();
    expect(runtime.status()[0]!.state).toBe("denied");
    expect(events.some((e) => e.type === "permission_denied" && e.reason === "headless")).toBe(true);
  });

  test("crash makes tools unavailable; manual restart works; no auto-restart", async () => {
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([stdioServer("ok")], events);
    await runtime.ensureStarted();
    const tool = runtime.tools["mcp__srv__echo"]!;
    // boom: the server dies without answering
    let threw: unknown;
    try {
      await tool.execute({ boom: true }, { signal: new AbortController().signal, cwd: process.cwd(), onProgress: () => {} });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(McpError);
    await Bun.sleep(50); // crash event lands asynchronously
    expect(runtime.status()[0]!.state).toBe("crashed");
    expect(events.some((e) => e.type === "mcp_server_failed" && e.reason === "crashed")).toBe(true);
    // tools unavailable, with the restart hint
    await expect(
      runtime.tools["mcp__srv__echo"]!.execute({ text: "x" }, { signal: new AbortController().signal, cwd: process.cwd(), onProgress: () => {} }),
    ).rejects.toThrow(/crashed.*moh mcp restart/);
    // no auto-restart happened
    expect(runtime.status()[0]!.state).toBe("crashed");
    // manual restart recovers
    await runtime.restart("srv");
    expect(runtime.status()[0]!.state).toBe("running");
    const out = await runtime.tools["mcp__srv__echo"]!.execute({ text: "back" }, { signal: new AbortController().signal, cwd: process.cwd(), onProgress: () => {} });
    expect(out).toBe("echo: back");
    await runtime.shutdown();
  });

  test("sampling/roots/elicitation requests are refused cleanly and logged", async () => {
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([stdioServer("refuse")], events);
    await runtime.ensureStarted();
    await Bun.sleep(150);
    const refusals = events.filter((e) => e.type === "mcp_refused") as Extract<AgentEvent, { type: "mcp_refused" }>[];
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ server: "srv", capability: "sampling" });
    // the refusal did not take the server down
    expect(runtime.status()[0]!.state).toBe("running");
    await runtime.shutdown();
  });
});

describe("McpRuntime (HTTP streamable)", () => {
  let base: string;
  let server: ReturnType<typeof Bun.serve>;
  const refusals: string[] = [];
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const msg = (await req.json()) as { id?: number; method?: string; params?: any; error?: unknown };
        if (msg.method === "initialize" && msg.id !== undefined) {
          return Response.json(
            { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-test", version: "0" } } },
            { headers: { "mcp-session-id": "sess-1" } },
          );
        }
        if (msg.method === "tools/list" && msg.id !== undefined) {
          // Streamable HTTP with SSE: server-initiated request first, then
          // the response — moh must refuse the capability and still resolve.
          const body =
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 7001, method: "roots/list", params: {} })}\n\n` +
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "pong tool" }] } })}\n\n`;
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        if (msg.method === "tools/call" && msg.id !== undefined) {
          return Response.json({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `pong ${msg.params?.arguments?.n ?? ""}`.trim() }] } });
        }
        if (msg.error !== undefined && msg.id !== undefined) {
          refusals.push(JSON.stringify({ id: msg.id, error: msg.error }));
          return new Response(null, { status: 202 });
        }
        if (msg.method !== undefined && msg.id === undefined) {
          return new Response(null, { status: 202 }); // notification
        }
        return new Response(null, { status: 404 });
      },
    });
    base = `http://localhost:${server.port}/mcp`;
  });
  afterAll(() => {
    server.stop(true);
  });

  test("registers tools over HTTP, sends the session id, and refuses roots cleanly", async () => {
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([{ name: "web", scope: "user", transport: { type: "http", url: base } }], events);
    await runtime.ensureStarted();
    expect(Object.keys(runtime.tools)).toEqual(["mcp__web__ping"]);
    const out = await runtime.tools["mcp__web__ping"]!.execute({ n: "1" }, { signal: new AbortController().signal, cwd: process.cwd(), onProgress: () => {} });
    expect(out).toBe("pong 1");
    await Bun.sleep(100);
    const refused = events.find((e) => e.type === "mcp_refused") as Extract<AgentEvent, { type: "mcp_refused" }>;
    expect(refused).toMatchObject({ server: "web", capability: "roots" });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("-32601");
    await runtime.shutdown();
  });

  test("unreachable endpoint fails as start_failed", async () => {
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([{ name: "dead", scope: "user", transport: { type: "http", url: "http://127.0.0.1:1/mcp" } }], events);
    await runtime.ensureStarted();
    const failure = events.find((e) => e.type === "mcp_server_failed") as Extract<AgentEvent, { type: "mcp_server_failed" }>;
    expect(failure?.reason).toBe("start_failed");
    expect(runtime.status()[0]!.state).toBe("failed");
  });
});

describe("AgentSession MCP integration", () => {
  const dirs: string[] = [];
  function tmpCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), "moh-mcp-"));
    dirs.push(dir);
    return dir;
  }
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("session-level flow: consent, tool ask with 'always' persisted to moh.json, shutdown at dispose", async () => {
    const cwd = tmpCwd();
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "mcp__srv__echo", args: { text: "x" } }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    const session = createSession({
      provider,
      cwd,
      mcp: {
        servers: [{ name: "srv", scope: "project", transport: { type: "stdio", command: process.execPath, args: [SERVER, "ok"] } }],
        onConsent: () => "yes",
      },
      onPermissionRequest: async () => "always" as const,
    });
    const result = await session.send("use the echo tool");
    expect(result.status).toBe("done");
    const log = session.history();
    expect(log.some((e) => e.type === "mcp_server_started" && (e as any).tools.includes("mcp__srv__echo"))).toBe(true);
    // tool-level consent: asked once, granted, runtime rule added
    expect(log.some((e) => e.type === "permission_requested" && e.tool === "mcp__srv__echo")).toBe(true);
    expect(log.some((e) => e.type === "permission_rule_added" && (e as any).rule.tool === "mcp__srv__echo")).toBe(true);
    // the tool actually ran
    const toolResult = log.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
    expect(toolResult.ok).toBe(true);
    expect(toolResult.output).toBe("echo: x");
    // "always" persisted to moh.json for future sessions
    const persisted = JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8"));
    expect(persisted.permissions.overrides.tools["mcp__srv__echo"]).toBe("allow");
    // session-end shutdown
    await session.dispose();
    expect(session.history().some((e) => e.type === "mcp_server_stopped")).toBe(true);
  });

  test("duplicate server names throw at session creation (startup validation error)", () => {
    const servers = [stdioServer("ok"), stdioServer("ok")];
    expect(() =>
      createSession({
        provider: MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]),
        mcp: { servers },
      }),
    ).toThrow(/duplicate MCP server name/);
  });

  test("headless session (no callbacks) denies project servers without crashing the turn", async () => {
    const provider = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const session = createSession({
      provider,
      mcp: { servers: [{ name: "srv", scope: "project", transport: { type: "stdio", command: process.execPath, args: [SERVER, "ok"] } }] },
    });
    const result = await session.send("hi");
    expect(result.status).toBe("done");
    const log = session.history();
    expect(log.some((e) => e.type === "permission_denied" && (e as any).tool === "mcp__srv" && (e as any).reason === "headless")).toBe(true);
    expect(log.some((e) => e.type === "mcp_server_started")).toBe(false);
  });
});
