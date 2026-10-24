/**
 * ADR-0076 — the composer `!` door: `AgentSession.runBash` routes one
 * user-invoked command through the same ToolRunner the model uses (same
 * gate, same rules), appends a real tool_call/tool_result pair, and
 * carries its fixed 120s timeout independent of the bash tool config.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, builtinTools, createSession, sessionFromConfig } from "../src";
import type { AgentEvent, AgentSession, PermissionAskContext } from "../src";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assemble(
  overrides: Record<string, unknown> = {},
  consent?: { onPermissionRequest: (tool: string, args: unknown, context?: PermissionAskContext) => "yes" | "always" | "no" },
): { session: AgentSession; events: AgentEvent[] } {
  const root = mkdtempSync(join(tmpdir(), "moh-composer-bash-"));
  roots.push(root);
  const events: AgentEvent[] = [];
  const assembled = sessionFromConfig({
    cwd: root,
    home: root,
    config: { provider: "mock" },
    ...(consent ? { consent } : {}),
    overrides: {
      permissions: { overrides: { tools: { bash: "allow" as const } } },
      sink: (e: AgentEvent) => events.push(e),
      ...overrides,
    },
  });
  if (!("session" in assembled)) throw new Error(assembled.error.message);
  return { session: assembled.session as unknown as AgentSession, events };
}

describe("AgentSession.runBash (ADR-0076)", () => {
  test("runs the command and appends a real tool_call/tool_result pair", async () => {
    const { session, events } = assemble();
    const result = await session.runBash("echo composer-bang");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("composer-bang");
    const calls = events.filter((e) => e.type === "tool_call");
    const results = events.filter((e) => e.type === "tool_result");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "bash", args: { command: "echo composer-bang" } });
    expect(results[0]).toMatchObject({ ok: true, callId: calls[0]!.callId });
  });

  test("the fixed 120s timeout is stamped on the tool_call", async () => {
    const { session, events } = assemble();
    await session.runBash("true");
    const call = events.find((e) => e.type === "tool_call");
    expect(call && "timeoutMs" in call ? call.timeoutMs : undefined).toBe(120_000);
  });

  test("the tool_call carries the user-source marker (ADR-0076)", async () => {
    const { session, events } = assemble();
    await session.runBash("echo hi");
    const call = events.find((e) => e.type === "tool_call");
    expect(call && "source" in call ? call.source : undefined).toBe("user");
  });

  test("a failing command reports ok:false without throwing", async () => {
    const { session } = assemble();
    const result = await session.runBash("exit 3");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("exit code 3");
  });

  test("a bash deny rule refuses through the same gate", async () => {
    const { session, events } = assemble({
      permissions: { overrides: { tools: { bash: "deny" as const } } },
    });
    const result = await session.runBash("echo nope");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("permission denied");
    expect(events.some((e) => e.type === "permission_denied")).toBe(true);
  });

  // #1507: the `source: "user"` ask context reaches the consent callback,
  // and an "always" answer there is a one-time allow — no rule is written,
  // so the next identical command is asked again.
  test("the ask carries source: user and an \"always\" answer records no rule (#1507)", async () => {
    const contexts: (PermissionAskContext | undefined)[] = [];
    const { session, events } = assemble({ permissions: {} }, {
      onPermissionRequest: (_tool, _args, context) => {
        contexts.push(context);
        return "always";
      },
    });
    const first = await session.runBash("echo one");
    const second = await session.runBash("echo one");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.source).toBe("user");
    expect(contexts[1]?.source).toBe("user");
    expect(events.filter((e) => e.type === "permission_requested")).toHaveLength(2);
    expect(events.some((e) => e.type === "permission_rule_added")).toBe(false);
  });
});

describe("model-initiated bash keeps the full ask (#1507)", () => {
  test("no ask context, and \"always\" records the runtime rule", async () => {
    const contexts: (PermissionAskContext | undefined)[] = [];
    const call = { deltas: [], finish: "tool_calls" as const, toolCalls: [{ name: "bash", args: { command: "echo one" } }] };
    const session = createSession({
      provider: MockProvider.scripted([call, { deltas: ["a"], finish: "stop" }, call, { deltas: ["b"], finish: "stop" }]),
      tools: builtinTools(),
      permissions: { mode: "normal" },
      onPermissionRequest: (_tool, _args, context) => {
        contexts.push(context);
        return "always";
      },
    });
    await session.send("run it");
    await session.send("run it again");
    expect(contexts).toEqual([undefined]); // the second call matched the rule
    const added = session.history().filter((e) => e.type === "permission_rule_added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ rule: { tool: "bash", effect: "allow", tier: "runtime" } });
  });
});
