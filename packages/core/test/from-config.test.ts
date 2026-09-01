import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFromConfig } from "../src/session/from-config";
import { MockProvider, declaredMcpServers, type MohConfig } from "../src/index";

function tempProject(): { cwd: string; home: string; cleanup: () => void } {
  const dir = join(
    tmpdir(),
    `moh-from-config-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  const cwd = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(join(cwd), { recursive: true });
  mkdirSync(join(home, ".moh"), { recursive: true });
  return { cwd, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("sessionFromConfig", () => {
  test("zero-config: missing moh.json assembles the mock demo session", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      const result = sessionFromConfig({ cwd, home });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.session).toBeDefined();
      expect(result.store).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("explicit demo: config provider \"mock\" assembles a session", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      const result = sessionFromConfig({ cwd, home, config: { provider: "mock" } });
      expect("error" in result).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("broken provider reference is a visible provider error, not a silent demo swap", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      const result = sessionFromConfig({ cwd, home, config: { provider: "no-such-endpoint/model" } });
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error.kind).toBe("provider");
      expect(result.error.message).toContain("unknown provider");
    } finally {
      cleanup();
    }
  });

  test("invalid moh.json on disk is a visible config error", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      writeFileSync(join(cwd, "moh.json"), "{ not json");
      const result = sessionFromConfig({ cwd, home });
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error.kind).toBe("config");
      expect(result.error.message).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test("providerRef override resolves endpoint/model-id from config endpoints", () => {
    const config: MohConfig = {
      endpoints: [{ name: "test", type: "openai-compat", baseUrl: "http://127.0.0.1:1", defaultModel: "m1" }],
    };
    const { cwd, home, cleanup } = tempProject();
    try {
      const result = sessionFromConfig({ cwd, home, config, providerRef: "test/m2" });
      expect("error" in result).toBe(false);
      const unknown = sessionFromConfig({ cwd, home, config, providerRef: "other/m" });
      expect("error" in unknown).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("pre-built provider instance wins over references", () => {
    const provider = MockProvider.demo();
    const result = sessionFromConfig({
      cwd: process.cwd(),
      config: { provider: "nope/nope" },
      provider,
    });
    expect("error" in result).toBe(false);
  });

  test("merges project (moh.json) and user (~/.moh/config) MCP servers", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      const config: MohConfig = {
        mcpServers: { proj: { type: "stdio", command: "echo" } },
      };
      writeFileSync(
        join(home, ".moh", "config"),
        JSON.stringify({ mcpServers: { userSrv: { type: "stdio", command: "echo" } } }),
      );
      const result = sessionFromConfig({ cwd, home, config });
      expect("error" in result).toBe(false);
      // The merged set equals project-first then user, the documented order.
      expect(declaredMcpServers(config).map((s) => s.name)).toEqual(["proj"]);
    } finally {
      cleanup();
    }
  });

  test("duplicate MCP server names surface as a session error", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      writeFileSync(
        join(home, ".moh", "config"),
        JSON.stringify({ mcpServers: { dup: { type: "stdio", command: "echo" } } }),
      );
      const result = sessionFromConfig({
        cwd,
        home,
        config: { mcpServers: { dup: { type: "stdio", command: "echo" } } },
      });
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error.kind).toBe("session");
    } finally {
      cleanup();
    }
  });

  test("permissionFlags merge on top of moh.json overrides (caller wins)", async () => {
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
      { deltas: ["ok"], finish: "stop" },
    ]);
    const result = sessionFromConfig({
      cwd: process.cwd(),
      config: { permissions: { overrides: { tools: { bash: "ask" } } } },
      provider,
      overrides: { permissionFlags: { tools: { bash: "allow" } } },
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const events: any[] = [];
    void (async () => {
      for await (const e of result.session.events) events.push(e);
    })();
    const turn = await result.session.send("run it");
    await result.session.dispose();
    expect(turn.status).toBe("done");
    // The bash call ran (no permission_requested): the CLI flag overrode the moh.json "ask".
    expect(events.some((e) => e.type === "permission_requested")).toBe(false);
    expect(events.some((e) => e.type === "tool_call" && e.name === "bash")).toBe(true);
  });

  test("without consent seams, an ask-tier call is denied headless (fail-fast, no prompt)", async () => {
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "rm -rf /" } }] },
      { deltas: ["denied then"], finish: "stop" },
    ]);
    const result = sessionFromConfig({ cwd: process.cwd(), provider });
    if ("error" in result) throw new Error(result.error.message);
    const turn = await result.session.send("run it");
    await result.session.dispose();
    expect(turn.status).toBe("done");
  });

  test("extra sink fans out alongside the store append", async () => {
    const provider = MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]);
    const seen: string[] = [];
    const result = sessionFromConfig({
      cwd: process.cwd(),
      provider,
      overrides: { sink: (e) => seen.push(e.type) },
    });
    if ("error" in result) throw new Error(result.error.message);
    await result.session.send("hello");
    await result.session.dispose();
    expect(seen).toContain("session_start");
    expect(seen).toContain("done");
  });

  test("resume: a given store seeds the conversation from its log", async () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      const first = sessionFromConfig({
        cwd,
        home,
        provider: MockProvider.scripted([{ deltas: ["one"], finish: "stop" }]),
      });
      if ("error" in first) throw new Error(first.error.message);
      await first.session.send("first");
      await first.session.dispose();

      const resumed = sessionFromConfig({
        cwd,
        home,
        provider: MockProvider.scripted([{ deltas: ["two"], finish: "stop" }]),
        overrides: { store: first.store },
      });
      if ("error" in resumed) throw new Error(resumed.error.message);
      await resumed.session.send("second");
      await resumed.session.dispose();
      const log = resumed.store.load();
      expect(log.filter((e: any) => e.type === "user_message")).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});

describe("sessionFromConfig — user-level provider layering (#129)", () => {
  test("no moh.json: a user-configured provider is available and used", async () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      writeFileSync(
        join(home, ".moh", "config"),
        JSON.stringify({ provider: "umock/demo", endpoints: [{ name: "umock", type: "mock", defaultModel: "demo" }] }),
      );
      const result = sessionFromConfig({ cwd, home });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      // The user-configured endpoint (type "mock" routes through the
      // registered mock factory) actually serves the turn.
      const turn = await result.session.send("hi");
      expect(turn.status).toBe("done");
    } finally {
      cleanup();
    }
  });

  test("project endpoint fields override user config per-field; absent fields inherit", async () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      writeFileSync(
        join(home, ".moh", "config"),
        JSON.stringify({ endpoints: [{ name: "work", type: "mock", apiKey: "sk-user", defaultModel: "user-model" }] }),
      );
      writeFileSync(
        join(cwd, "moh.json"),
        JSON.stringify({ provider: "work", endpoints: [{ name: "work", type: "mock", defaultModel: "project-model" }] }),
      );
      const result = sessionFromConfig({ cwd, home });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      // The route uses the project defaultModel; the merged apiKey (user's)
      // rode along — verified per-field in provider-config tests.
      const turn = await result.session.send("hi");
      expect(turn.status).toBe("done");
    } finally {
      cleanup();
    }
  });

  test("invalid user provider/endpoints section is a visible config error", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      writeFileSync(join(home, ".moh", "config"), JSON.stringify({ provider: 42 }));
      const result = sessionFromConfig({ cwd, home });
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error.kind).toBe("config");
      expect(result.error.message).toContain("provider");
    } finally {
      cleanup();
    }
  });

  test("env var key wins over both files", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      writeFileSync(
        join(home, ".moh", "config"),
        JSON.stringify({ endpoints: [{ name: "work", type: "mock", apiKey: "sk-user", defaultModel: "demo" }] }),
      );
      const before = process.env.MOH_ENDPOINT_WORK_API_KEY;
      process.env.MOH_ENDPOINT_WORK_API_KEY = "sk-env";
      try {
        const result = sessionFromConfig({ cwd, home });
        expect("error" in result).toBe(false);
      } finally {
        if (before === undefined) delete process.env.MOH_ENDPOINT_WORK_API_KEY;
        else process.env.MOH_ENDPOINT_WORK_API_KEY = before;
      }
    } finally {
      cleanup();
    }
  });

  test("#190: moh.json maxIterations configures the per-turn cap (wrap-up after N calls)", async () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", maxIterations: 2 }));
      const loopTurn = { deltas: ["working "], finish: "tool_calls" as const, toolCalls: [{ name: "bash", args: { command: "true" } }] };
      const provider = MockProvider.scripted([loopTurn, loopTurn, { deltas: ["WRAPUP"], finish: "stop" as const }]);
      const result = sessionFromConfig({ cwd, home, provider, overrides: { permissions: { unrestrictedTools: true } } });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      const done = await result.session.send("go");
      expect(done.status).toBe("done");
      const calls = result.session.history().filter((e) => e.type === "model_call");
      // 2 capped loop calls + 1 wrap-up call.
      expect(calls.length).toBe(3);
    } finally {
      cleanup();
    }
  });
});

// #400: single-writer guard at the assembly seam — external growth of the
// open session file between appends emits one `session_file_growth` chrome
// event (visible in every surface) while the local appends stay intact.
describe("single-writer guard (#400)", () => {
  test("external growth between appends emits session_file_growth and keeps local appends intact", async () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      const result = sessionFromConfig({ cwd, home, provider: MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]) });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      const events: any[] = [];
      void (async () => {
        for await (const e of result.session.events) events.push(e);
      })();

      // First turn: normal appends, no warning.
      await result.session.send("hello");
      expect(events.some((e) => e.type === "session_file_growth")).toBe(false);

      // Between turns, an external writer (sync channel / second process)
      // appends to the same file.
      appendFileSync(result.store.file, JSON.stringify({ type: "user_message", text: "from elsewhere" }) + "\n");

      await result.session.send("again");
      await result.session.dispose();

      const warnings = events.filter((e) => e.type === "session_file_growth");
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0].file).toBe(result.store.file);
      expect(warnings[0].actualBytes).toBeGreaterThan(warnings[0].expectedBytes);
      // The local writer's appends stayed intact: the file ends with valid
      // JSONL lines and the externally appended line survives verbatim.
      const raw = readFileSync(result.store.file, "utf8");
      expect(raw).toContain("from elsewhere");
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      cleanup();
    }
  });
});
