import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, McpRuntime, MockProvider, sessionFromConfig, type AgentEvent, type DeclaredMcpServer } from "../src/index";
import { projectSlug } from "../src/session-store";
import { McpError, mcpServerEntrySchema } from "../src/mcp";
import { HttpConnection, MCP_MAX_RESPONSE_BYTES, type McpLookup } from "../src/mcp/transport-http";

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

  test("server names cannot contain the reserved MCP tool-name separator", () => {
    expect(() => McpRuntime.validate([stdioServer("ok", "a__b")])).toThrow(/invalid MCP server name "a__b".*reserved/);
  });

  test("stdio servers receive only the minimal environment plus declared overrides", async () => {
    const expected = new Set(["PATH", "HOME", "TMPDIR", "LANG", "TERM", "CUSTOM"]);
    for (const scope of ["user", "project"] as const) {
      const name = `env-${scope}`;
      const runtime = makeRuntime(
        [{ name, scope, transport: { type: "stdio", command: process.execPath, args: [SERVER, "env"], env: { CUSTOM: "present", PATH: "overridden" } } }],
        [],
        scope === "project" ? { onConsent: () => "yes" as const } : {},
      );
      await runtime.ensureStarted();
      const output = await runtime.tools[`mcp__${name}__env`]!.execute({}, { signal: new AbortController().signal, cwd: process.cwd(), onProgress: () => {} });
      const env = JSON.parse(output) as Record<string, string>;
      expect(Object.keys(env).every((key) => expected.has(key))).toBe(true);
      expect(env.CUSTOM).toBe("present");
      expect(env.PATH).toBe("overridden");
      await runtime.shutdown();
    }
  });

  test("a server returning a reserved tool name fails without registering tools", async () => {
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([stdioServer("bad-tool")], events);
    await runtime.ensureStarted();
    expect(runtime.status()[0]!.state).toBe("failed");
    expect(Object.keys(runtime.tools)).toEqual([]);
    const failure = events.find((event) => event.type === "mcp_server_failed") as Extract<AgentEvent, { type: "mcp_server_failed" }>;
    expect(failure.message).toMatch(/srv.*bad__tool.*reserved/);
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

  test("legacy `trusted: true` in a project declaration is ignored: consent is still asked (#352/SEC-01)", async () => {
    const events: AgentEvent[] = [];
    const asked: string[] = [];
    // The repo shipped `trusted: true` inside the project moh.json entry.
    // After #352 the transport field is dead: only moh-recorded user-config
    // trust (DeclaredMcpServer.trusted) can skip consent.
    const runtime = makeRuntime(
      [{ name: "p", scope: "project", transport: { type: "stdio", command: process.execPath, args: [SERVER, "ok"], trusted: true } }],
      events,
      {
        onConsent: (s) => {
          asked.push(s);
          return "no";
        },
      },
    );
    await runtime.ensureStarted();
    expect(asked).toEqual(["p"]);
    expect(runtime.status()[0]!.state).toBe("denied");
    expect(Object.keys(runtime.tools)).toHaveLength(0);
  });

  test("moh-recorded trust (user config `mcpTrust`) skips consent and auto-allows tools (#352)", async () => {
    const events: AgentEvent[] = [];
    const trustedTools: string[][] = [];
    const runtime = makeRuntime([{ name: "p", scope: "project", trusted: true, transport: stdioServer("ok", "p").transport }], events, {
      onConsent: () => {
        throw new Error("consent must not be asked for a trusted project server");
      },
      onTrustedTools: (t) => trustedTools.push(t),
    });
    await runtime.ensureStarted();
    expect(runtime.status()[0]!.state).toBe("running");
    expect(trustedTools).toEqual([["mcp__p__echo"]]);
    await runtime.shutdown();
  });

  test("headless (no consent callback) denies project servers", async () => {
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([{ name: "p", scope: "project", transport: stdioServer("ok").transport }], events);
    await runtime.ensureStarted();
    expect(runtime.status()[0]!.state).toBe("denied");
    expect(events.some((e) => e.type === "permission_denied" && e.reason === "headless")).toBe(true);
  });

  test("restart re-checks consent for an untrusted project server", async () => {
    const events: AgentEvent[] = [];
    const answers: Array<"yes" | "no"> = ["yes", "no"];
    const runtime = makeRuntime([{ name: "p", scope: "project", transport: stdioServer("ok", "p").transport }], events, {
      onConsent: () => answers.shift()!,
    });
    await runtime.ensureStarted();
    expect(runtime.status()[0]!.state).toBe("running");
    await runtime.restart("p");
    expect(runtime.status()[0]!.state).toBe("denied");
    expect(events.filter((event) => event.type === "permission_requested")).toHaveLength(2);
    // Declining a restart leaves the healthy existing server untouched.
    expect(Object.keys(runtime.tools)).toEqual(["mcp__p__echo"]);
  });

  test("headless restart denies an untrusted project server", async () => {
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([{ name: "p", scope: "project", transport: stdioServer("ok", "p").transport }], events);
    await expect(runtime.restart("p")).rejects.toThrow("requires project consent");
    expect(runtime.status()[0]!.state).toBe("denied");
    expect(events.some((event) => event.type === "permission_denied" && event.reason === "headless")).toBe(true);
  });

  test("trusted project servers restart without asking again", async () => {
    const runtime = makeRuntime([{ name: "p", scope: "project", trusted: true, transport: stdioServer("ok", "p").transport }], [], {
      onConsent: () => { throw new Error("trusted server must not ask"); },
    });
    await runtime.ensureStarted();
    await runtime.restart("p");
    expect(runtime.status()[0]!.state).toBe("running");
    await runtime.shutdown();
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

describe("audit-v3 MCP-1: http transport hardening", () => {
  test("the config schema accepts only http(s) URLs", () => {
    const good = { type: "http", url: "https://example.com/mcp" };
    expect(mcpServerEntrySchema.safeParse(good).success).toBe(true);
    expect(mcpServerEntrySchema.safeParse({ type: "http", url: "http://localhost:3000/mcp" }).success).toBe(true);
    for (const url of ["ftp://example.com/mcp", "file:///etc/mcp", "not-a-url", "//example.com/mcp", ""]) {
      const parsed = mcpServerEntrySchema.safeParse({ type: "http", url });
      expect(parsed.success).toBe(false);
    }
  });

  test("a non-http(s) URL fails loudly at runtime, never a silent skip", async () => {
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([{ name: "bad", scope: "user", transport: { type: "http", url: "ftp://example.com/mcp" } }], events);
    await runtime.ensureStarted();
    const failure = events.find((e) => e.type === "mcp_server_failed") as Extract<AgentEvent, { type: "mcp_server_failed" }>;
    expect(failure?.reason).toBe("start_failed");
    expect(failure?.message).toContain("http(s)");
    expect(runtime.status()[0]!.state).toBe("failed");
  });

  test("a response body beyond the byte cap is refused, not buffered unbounded", async () => {
    // One oversized SSE frame: the old drain loop buffered it whole.
    const frame = `event: message\ndata: ${"x".repeat(MCP_MAX_RESPONSE_BYTES + 1024)}\n\n`;
    const s = Bun.serve({ port: 0, fetch: () => new Response(frame, { headers: { "content-type": "text/event-stream" } }) });
    try {
      const events: AgentEvent[] = [];
      const runtime = makeRuntime([{ name: "fat", scope: "user", transport: { type: "http", url: `http://localhost:${s.port}/mcp` } }], events);
      await runtime.ensureStarted();
      const failure = events.find((e) => e.type === "mcp_server_failed") as Extract<AgentEvent, { type: "mcp_server_failed" }>;
      expect(failure?.message).toContain("cap");
      expect(runtime.status()[0]!.state).toBe("failed");
    } finally {
      s.stop(true);
    }
  }, 20_000);

  test("a stdio server that never emits a newline is capped and crashes (#1254)", async () => {
    // 11 MB in one chunk, no newline: past the MCP_MAX_LINE_BYTES cap the
    // connection must end crashed, not keep buffering.
    const oversized: DeclaredMcpServer = {
      name: "firehose",
      scope: "user",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["-e", "process.stdout.write(Buffer.alloc(11 * 1024 * 1024).fill(0x78).toString())"],
      },
    };
    const events: AgentEvent[] = [];
    const runtime = makeRuntime([oversized], events);
    await runtime.ensureStarted();
    // The flood rejects the pending initialize, so start() lands "failed"
    // with the typed cap reason (crash bookkeeping is then a no-op — the
    // same state, not a silent skip). The subprocess itself was killed.
    for (let i = 0; i < 50; i += 1) {
      const state = runtime.status()[0]!.state;
      if (state === "crashed" || state === "failed") break;
      await Bun.sleep(100);
    }
    const failure = events.find((e) => e.type === "mcp_server_failed") as Extract<AgentEvent, { type: "mcp_server_failed" }>;
    expect(failure?.message).toContain("buffer cap");
    await runtime.shutdown();
  }, 20_000);
});

describe("#1254: http transport redirect pinning + per-request timeout", () => {
  test("a cross-origin redirect is refused and the session id is never replayed", async () => {
    const hits: string[] = [];
    const evil = Bun.serve({
      port: 0,
      fetch: (req) => {
        hits.push(req.headers.get("mcp-session-id") ?? "");
        return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      },
    });
    const s = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 302, headers: { location: `http://localhost:${evil.port}/mcp` } }),
    });
    try {
      const events: AgentEvent[] = [];
      const runtime = makeRuntime([{ name: "swivel", scope: "user", transport: { type: "http", url: `http://localhost:${s.port}/mcp` } }], events);
      await runtime.ensureStarted();
      const failure = events.find((e) => e.type === "mcp_server_failed") as Extract<AgentEvent, { type: "mcp_server_failed" }>;
      expect(failure?.message).toContain("cross-origin");
      expect(hits).toHaveLength(0);
      await runtime.shutdown();
    } finally {
      s.stop(true);
      evil.stop(true);
    }
  });

  test("a redirect whose hostname re-resolves to a different address is refused (#697 pattern)", async () => {
    let calls = 0;
    const lookup: McpLookup = async () => {
      calls += 1;
      return calls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "127.0.0.2", family: 4 }];
    };
    const s = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 302, headers: { location: "/" } }),
    });
    try {
      const conn = new HttpConnection({ url: `http://localhost:${s.port}/mcp`, lookup, onRequest: () => {}, onCrash: () => {} });
      try {
        // First dial resolves to 127.0.0.1; the redirect hop re-resolves
        // to 127.0.0.2 and must be refused before it is dialed.
        await expect(conn.request("ping", {}, 30_000)).rejects.toThrow(/re-resolved to a different address/);
        expect(calls).toBe(2);
      } finally {
        await conn.close();
      }
    } finally {
      s.stop(true);
    }
  });

  test("an endpoint slower than the per-request budget fails as a typed timeout", async () => {
    const s = Bun.serve({ port: 0, fetch: () => Bun.sleep(60_000).then(() => new Response()) });
    try {
      // Direct transport: the runtime's own request budgets are shorter,
      // so the per-request abort is observable only at the seam itself.
      const conn = new HttpConnection({ url: `http://localhost:${s.port}/mcp`, onRequest: () => {}, onCrash: () => {} });
      try {
        await expect(conn.request("ping", {}, 30_000)).rejects.toMatchObject({ kind: "timeout" });
      } finally {
        await conn.close();
      }
    } finally {
      s.stop(true);
    }
  }, 20_000);
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

  test("server-level 'always' persists trust in the user config mcpTrust section, keyed by project (#352/SEC-01)", async () => {
    const cwd = tmpCwd();
    const home = join(cwd, "home");
    mkdirSync(join(home, ".moh"), { recursive: true });
    // The project declares the server — with a forged `trusted: true`, which
    // must be ignored: consent is still asked the first time.
    writeFileSync(
      join(cwd, "moh.json"),
      JSON.stringify({ mcpServers: { srv: { type: "stdio", command: process.execPath, args: [SERVER, "ok"], trusted: true } } }),
    );
    const asked: string[] = [];
    const first = sessionFromConfig({
      cwd,
      home,
      provider: MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]),
      consent: { onMcpTrust: (s) => { asked.push(s); return "always"; } },
    });
    if ("error" in first) throw new Error(first.error.message);
    await first.session.send("hi");
    await first.session.dispose();
    expect(asked).toEqual(["srv"]); // the forged flag did not skip consent
    expect(first.session.history().some((e) => e.type === "mcp_server_started")).toBe(true);
    // Trust was persisted to the user config — not to the repo's moh.json.
    const userConfig = JSON.parse(readFileSync(join(home, ".moh", "config"), "utf8"));
    expect(userConfig.mcpTrust[projectSlug(cwd, home)]).toEqual(["srv"]);
    expect(JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8")).mcpServers.srv.trusted).toBe(true); // untouched
    // Next session for the same project: no consent asked, server starts.
    const second = sessionFromConfig({
      cwd,
      home,
      provider: MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]),
      consent: { onMcpTrust: () => { throw new Error("must not ask"); } },
    });
    if ("error" in second) throw new Error(second.error.message);
    await second.session.send("hi");
    expect(second.session.history().some((e) => e.type === "mcp_server_started")).toBe(true);
    await second.session.dispose();
    // A clone with the declared identity recognizes the same consent.
    const clone = tmpCwd();
    mkdirSync(join(clone, ".moh"), { recursive: true });
    writeFileSync(join(clone, ".moh", "project.json"), readFileSync(join(cwd, ".moh", "project.json")));
    writeFileSync(join(clone, "moh.json"), readFileSync(join(cwd, "moh.json")));
    const cloneSession = sessionFromConfig({
      cwd: clone,
      home,
      provider: MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]),
      consent: { onMcpTrust: () => { throw new Error("must not ask clone"); } },
    });
    if ("error" in cloneSession) throw new Error(cloneSession.error.message);
    await cloneSession.session.send("hi");
    await cloneSession.session.dispose();
    // A different project declaring the same server name still asks.
    const other = tmpCwd();
    const otherHome = join(other, "home");
    mkdirSync(join(otherHome, ".moh"), { recursive: true });
    writeFileSync(
      join(other, "moh.json"),
      JSON.stringify({ mcpServers: { srv: { type: "stdio", command: process.execPath, args: [SERVER, "ok"] } } }),
    );
    const otherAsked: string[] = [];
    const third = sessionFromConfig({
      cwd: other,
      home: otherHome,
      provider: MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]),
      consent: { onMcpTrust: (s) => { otherAsked.push(s); return "no"; } },
    });
    if ("error" in third) throw new Error(third.error.message);
    await third.session.send("hi");
    expect(otherAsked).toEqual(["srv"]);
    expect(third.session.history().some((e) => e.type === "mcp_server_started")).toBe(false);
    await third.session.dispose();
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
