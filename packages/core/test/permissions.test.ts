import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PermissionResolver,
  DEFAULT_TOOL_PERMISSIONS,
  RuleError,
  formatRule,
  overridesFromFlags,
  parseRule,
  runtimeRulesFromEvents,
  type PermissionRule,
} from "../src/permissions";
import { createSession, MockProvider, type AgentEvent } from "../src/index";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "moh-perm-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("PermissionResolver: most-specific-wins across 3 tiers", () => {
  test("builtin defaults: read allow, bash ask", () => {
    const r = new PermissionResolver({ defaults: DEFAULT_TOOL_PERMISSIONS, cwd: root });
    expect(r.resolve("read", { path: "src/x.ts" })).toBe("allow");
    expect(r.resolve("bash", { command: "ls" })).toBe("ask");
    expect(r.resolve("write", { path: "src/x.ts" })).toBe("ask");
  });

  test("moh.json override allows bash [git,status] — git status allowed, git push still ask", () => {
    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: { bashAllow: [["git", "status"]] },
      cwd: root,
    });
    expect(r.resolve("bash", { command: "git status" })).toBe("allow");
    expect(r.resolve("bash", { command: "git status --short" })).toBe("allow");
    expect(r.resolve("bash", { command: "git push" })).toBe("ask");
  });

  test("runtime deny [git,push] beats config allow [git] (token prefix covers git push)", () => {
    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: { bashAllow: [["git"]] },
      cwd: root,
    });
    r.addRuntimeRule({ tier: "runtime", tool: "bash", effect: "deny", tokens: ["git", "push"] });
    expect(r.resolve("bash", { command: "git push" })).toBe("deny");
    expect(r.resolve("bash", { command: "git status" })).toBe("allow");
  });

  test("config tool-level allow beats builtin ask; longer token rule beats shorter", () => {
    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: { bashAllow: [["git"], ["git", "status"]] },
      cwd: root,
    });
    r.addRuntimeRule({ tier: "runtime", tool: "bash", effect: "deny", tokens: ["git", "status", "--hard"] });
    expect(r.resolve("bash", { command: "git status" })).toBe("allow");
    expect(r.resolve("bash", { command: "git status --hard" })).toBe("deny");
    expect(r.resolve("bash", { command: "git log" })).toBe("allow");
  });

  test("config tool-level deny/allow for named tools", () => {
    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: { tools: { fetch: "allow", read: "deny" } },
      cwd: root,
    });
    expect(r.resolve("fetch", { url: "https://x" })).toBe("allow");
    expect(r.resolve("read", { path: "a" })).toBe("deny");
  });
});

describe("PermissionResolver: bash compound commands", () => {
  test("every segment must be covered by an allow rule", () => {
    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: { bashAllow: [["git"]] },
      cwd: root,
    });
    expect(r.resolve("bash", { command: "git status && git log" })).toBe("allow");
    expect(r.resolve("bash", { command: "git status; rm -rf /" })).toBe("ask");
    expect(r.resolve("bash", { command: "git status | grep foo" })).toBe("ask");
  });

  test("deny on any segment denies the whole command", () => {
    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: { bashAllow: [["git"], ["rm"]] },
      cwd: root,
    });
    r.addRuntimeRule({ tier: "runtime", tool: "bash", effect: "deny", tokens: ["rm"] });
    expect(r.resolve("bash", { command: "git status && rm -rf x" })).toBe("deny");
  });

  test("quotes-aware tokenization", () => {
    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: { bashAllow: [["echo"]] },
      cwd: root,
    });
    expect(r.resolve("bash", { command: 'echo "hello world"' })).toBe("allow");
    expect(r.resolve("bash", { command: 'echo "a ; b"' })).toBe("allow"); // ; inside quotes is not a separator
    expect(r.resolve("bash", { command: "echo 'x' || ls" })).toBe("ask");
  });

  test("|| splits segments too", () => {
    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: { bashAllow: [["git"], ["ls"]] },
      cwd: root,
    });
    expect(r.resolve("bash", { command: "git status || ls" })).toBe("allow");
  });
});

describe("PermissionResolver: path rules", () => {
  test("path globs anchored to project root via realpath (symlinks resolved)", () => {
    mkdirSync(join(root, "real"));
    const link = join(root, "link");
    Bun.spawnSync(["ln", "-s", join(root, "real"), link]);
    writeFileSync(join(root, "real", "f.txt"), "x");
    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: { pathAllow: ["real/**"] },
      cwd: root,
    });
    // Symlinked path resolves back under the real root and matches the glob.
    expect(r.resolve("write", { path: join("link", "f.txt") })).toBe("allow");
    // Absolute path through the symlink also matches after realpath.
    expect(r.resolve("write", { path: join(root, "link", "f.txt") })).toBe("allow");
    // Root-anchored: files not covered by the glob still ask.
    expect(r.resolve("write", { path: "other/f.txt" })).toBe("ask");
  });

  test("out-of-root paths always ask and are never persistable", () => {
    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: { pathAllow: ["**"] },
      cwd: root,
    });
    expect(r.resolve("write", { path: "../outside.txt" })).toBe("ask");
    expect(r.resolve("write", { path: "/etc/passwd" })).toBe("ask");
    expect(r.persistable("write", { path: "../outside.txt" })).toBe(false);
    expect(r.persistable("write", { path: "inside.txt" })).toBe(true);
  });

  test("path deny beats path allow", () => {
    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: { pathAllow: ["src/**"], pathDeny: ["src/secret.ts"] },
      cwd: root,
    });
    expect(r.resolve("write", { path: "src/a.ts" })).toBe("allow");
    expect(r.resolve("write", { path: "src/secret.ts" })).toBe("deny");
  });
});

describe("runtime rules persisted as events and restored on replay", () => {
  test("runtimeRulesFromEvents rebuilds resolver state from a permission_rule_added log", () => {
    const rules: PermissionRule[] = [
      { tier: "runtime", tool: "bash", effect: "allow", tokens: ["bun", "test"] },
      { tier: "runtime", tool: "write", effect: "allow", path: "src/**" },
    ];
    const events: AgentEvent[] = rules.map((rule) => ({ type: "permission_rule_added", rule }) as AgentEvent);
    const restored = runtimeRulesFromEvents(events);
    expect(restored).toEqual(rules);

    const r = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      runtimeRules: restored,
      cwd: root,
    });
    expect(r.resolve("bash", { command: "bun test foo.test.ts" })).toBe("allow");
    expect(r.resolve("write", { path: "src/x.ts" })).toBe("allow");
    expect(r.resolve("write", { path: "docs/x.md" })).toBe("ask");
  });
});

describe("AgentSession permission integration", () => {
  function tool(name: string) {
    return {
      name,
      description: name,
      inputSchema: undefined,
      async execute() {
        return `${name} ok`;
      },
    };
  }

  test("ask + auto-accept mode proceeds and logs granted with reason auto_accept", async () => {
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "ls" } }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    const session = createSession({
      provider,
      tools: { bash: tool("bash") },
      cwd: root,
      permissions: { mode: "auto-accept" },
    });
    const result = await session.send("go");
    expect(result.status).toBe("done");
    const log = session.history();
    expect(log.map((e) => e.type)).toContain("permission_granted");
    const granted = log.find((e) => e.type === "permission_granted") as any;
    const call = log.find((e) => e.type === "tool_call") as any;
    expect(granted.callId).toBe(call.callId);
    expect(granted.reason).toBe("auto_accept");
    expect(log.find((e) => e.type === "tool_result")!).toMatchObject({ ok: true });
  });

  test("session_mode event appended at start; bypass only via explicit flag", async () => {
    const mk = (permissions: any) =>
      createSession({
        provider: MockProvider.scripted([{ deltas: ["x"], finish: "stop" }]),
        permissions,
      });
    const s1 = mk({});
    const s2 = mk({ mode: "auto-accept" });
    const s3 = mk({ bypassPermissions: true });
    // mode: "bypass" without the flag is not honored
    const s4 = mk({ mode: "bypass" as any });

    const modeOf = (s: ReturnType<typeof mk>) =>
      (s.history().find((e) => e.type === "session_mode") as any)?.mode;
    expect(modeOf(s1)).toBe("normal");
    expect(modeOf(s2)).toBe("auto-accept");
    expect(modeOf(s3)).toBe("bypass");
    expect(modeOf(s4)).toBe("normal");
  });

  test("bypass mode proceeds past ask, granted with reason bypass", async () => {
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "ls" } }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    const session = createSession({
      provider,
      tools: { bash: tool("bash") },
      cwd: root,
      permissions: { bypassPermissions: true },
    });
    await session.send("go");
    const granted = session.history().find((e) => e.type === "permission_granted") as any;
    expect(granted.reason).toBe("bypass");
  });

  test("ask flow with callback: yes grants, no denies with structured failure", async () => {
    const grant = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "ls" } }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    const s1 = createSession({
      provider: grant,
      tools: { bash: tool("bash") },
      cwd: root,
      onPermissionRequest: async () => "yes" as const,
    });
    await s1.send("go");
    const log1 = s1.history();
    const req = log1.find((e) => e.type === "permission_requested") as any;
    const call = log1.find((e) => e.type === "tool_call") as any;
    expect(req).toMatchObject({ callId: call.callId, tool: "bash" });
    expect(log1.find((e) => e.type === "permission_granted")).toBeTruthy();
    expect((log1.find((e) => e.type === "tool_result") as any).ok).toBe(true);

    const deny = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "ls" } }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    const s2 = createSession({
      provider: deny,
      tools: { bash: tool("bash") },
      cwd: root,
      onPermissionRequest: async () => "no" as const,
    });
    await s2.send("go");
    const log2 = s2.history();
    const denied = log2.find((e) => e.type === "permission_denied") as any;
    expect(denied.callId).toBe((log2.find((e) => e.type === "tool_call") as any).callId);
    const tr = log2.find((e) => e.type === "tool_result") as any;
    expect(tr.ok).toBe(false);
    expect(tr.output).toBe("permission denied: bash requires user consent");
  });

  test("'always' stores a runtime rule + permission_rule_added event; second identical call runs without asking", async () => {
    let asks = 0;
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "git status" } }] },
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "git status" } }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    const session = createSession({
      provider,
      tools: { bash: tool("bash") },
      cwd: root,
      onPermissionRequest: async () => {
        asks += 1;
        return "always" as const;
      },
    });
    await session.send("go");
    expect(asks).toBe(1); // second identical call was allowed by the stored rule
    const log = session.history();
    const ruleEvents = log.filter((e) => e.type === "permission_rule_added") as any[];
    expect(ruleEvents.length).toBe(1);
    expect(ruleEvents[0]!.rule).toMatchObject({ tier: "runtime", tool: "bash", effect: "allow", tokens: ["git", "status"] });
    expect(log.filter((e) => e.type === "permission_requested").length).toBe(1);
    expect(log.filter((e) => e.type === "permission_granted").length).toBe(1);
    // Both tool results ok.
    expect(log.filter((e) => e.type === "tool_result").every((e: any) => e.ok)).toBe(true);
  });

  test("'always' on out-of-root write never persists a rule — asks again next time", async () => {
    let asks = 0;
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "write", args: { path: "../outside.txt", content: "x" } }] },
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "write", args: { path: "../outside.txt", content: "y" } }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    const session = createSession({
      provider,
      tools: { write: tool("write") },
      cwd: root,
      onPermissionRequest: async () => {
        asks += 1;
        return "always" as const;
      },
    });
    await session.send("go");
    expect(asks).toBe(2);
    expect(session.history().some((e) => e.type === "permission_rule_added")).toBe(false);
  });

  test("headless: unpermitted tool fails fast with a structured denial the model sees", async () => {
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "ls" } }] },
      { deltas: ["recovered"], finish: "stop" },
    ]);
    const session = createSession({
      provider,
      tools: { bash: tool("bash") },
      cwd: root,
      // no onPermissionRequest → headless
    });
    const result = await session.send("go");
    expect(result.status).toBe("done"); // turn continues, the model sees the failed result
    const log = session.history();
    const denied = log.find((e) => e.type === "permission_denied") as any;
    expect(denied.reason).toBe("headless");
    const tr = log.find((e) => e.type === "tool_result") as any;
    expect(tr.ok).toBe(false);
    expect(tr.output).toBe("permission denied: bash requires user consent (headless mode)");
  });

  test("deny from rules produces the same structured denial (no callback round-trip)", async () => {
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "rm -rf x" } }] },
      { deltas: ["done"], finish: "stop" },
    ]);
    let asked = false;
    const session = createSession({
      provider,
      tools: { bash: tool("bash") },
      cwd: root,
      permissions: { overrides: { bashDeny: [["rm"]] } },
      onPermissionRequest: async () => {
        asked = true;
        return "yes" as const;
      },
    });
    await session.send("go");
    expect(asked).toBe(false);
    const log = session.history();
    const tr = log.find((e) => e.type === "tool_result") as any;
    expect(tr.ok).toBe(false);
    expect(tr.output).toBe("permission denied: bash denied by permission rule");
    expect(log.some((e) => e.type === "permission_requested")).toBe(false);
    expect((log.find((e) => e.type === "permission_denied") as any).reason).toBe("rule");
  });
});

describe("canonical rule grammar: parseRule / formatRule (ADR-0007)", () => {
  test("plain tool rules become tool-level rules", () => {
    expect(parseRule("bash", "allow")).toEqual({ tier: "config", tool: "bash", effect: "allow" });
    expect(parseRule("fetch", "deny")).toEqual({ tier: "config", tool: "fetch", effect: "deny" });
  });

  test("bash rules become token prefixes", () => {
    expect(parseRule("bash:git status", "allow")).toEqual({
      tier: "config", tool: "bash", effect: "allow", tokens: ["git", "status"],
    });
    expect(parseRule('bash:echo "a && b"', "deny")).toEqual({
      tier: "config", tool: "bash", effect: "deny", tokens: ["echo", "a && b"],
    });
  });

  test("path rules become path-glob rules scoped to the tool", () => {
    expect(parseRule("write:src/**", "allow")).toEqual({ tier: "config", tool: "write", effect: "allow", path: "src/**" });
    expect(parseRule("edit:docs/*.md", "deny")).toEqual({ tier: "config", tool: "edit", effect: "deny", path: "docs/*.md" });
  });

  test("invalid rules are rejected", () => {
    expect(() => parseRule("", "allow")).toThrow(RuleError);
    expect(() => parseRule("bash:git status && rm -rf /", "allow")).toThrow(/single command prefix/);
    expect(() => parseRule("write:", "allow")).toThrow(RuleError);
    expect(() => parseRule("fetch:", "allow")).toThrow(RuleError);
    expect(() => parseRule(":src/**", "allow")).toThrow(/missing tool/);
    expect(() => parseRule("bash:", "allow")).toThrow(RuleError); // empty prefix: no tokens
  });

  test("formatRule renders the canonical terse form", () => {
    expect(formatRule({ tier: "runtime", tool: "bash", effect: "allow" })).toBe("bash");
    expect(formatRule({ tier: "runtime", tool: "bash", effect: "allow", tokens: ["git", "status"] })).toBe("bash:git status");
    expect(formatRule({ tier: "config", tool: "*", effect: "deny", path: "secrets/**" })).toBe("*:secrets/**");
  });

  test("round-trip: parseRule(formatRule(rule)) deep-equals the original", () => {
    const corpus: PermissionRule[] = [
      { tier: "builtin", tool: "read", effect: "allow" },
      { tier: "config", tool: "bash", effect: "deny" },
      { tier: "runtime", tool: "bash", effect: "allow", tokens: ["git"] },
      { tier: "runtime", tool: "bash", effect: "allow", tokens: ["git", "status"] },
      { tier: "runtime", tool: "bash", effect: "allow", tokens: ["git", "status", "--short"] },
      { tier: "config", tool: "bash", effect: "deny", tokens: ["rm"] },
      { tier: "runtime", tool: "bash", effect: "allow", tokens: ["echo", "a && b"] },
      { tier: "runtime", tool: "bash", effect: "allow", tokens: ["echo", "it's"] },
      { tier: "config", tool: "*", effect: "allow", path: "src/**" },
      { tier: "config", tool: "*", effect: "deny", path: "docs/*.md" },
      { tier: "runtime", tool: "*", effect: "allow", path: "package.json" },
      { tier: "runtime", tool: "write", effect: "allow", path: "src/x.ts" },
      { tier: "config", tool: "fetch", effect: "deny" },
    ];
    for (const rule of corpus) {
      expect(parseRule(formatRule(rule), rule.effect, rule.tier)).toEqual(rule);
    }
  });
});

describe("overridesFromFlags (CLI seam over the core grammar)", () => {
  test("multiple flags accumulate", () => {
    const overrides = overridesFromFlags(["bash", "bash:git status"], ["write:secrets/**"]);
    expect(overrides.tools).toEqual({ bash: "allow" });
    expect(overrides.bashAllow).toEqual([["git", "status"]]);
    expect(overrides.pathDeny).toEqual(["secrets/**"]);
  });
});
