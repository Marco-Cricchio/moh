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
import { sessionFromConfig } from "../src";
import type { AgentEvent, AgentSession } from "../src";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assemble(overrides: Record<string, unknown> = {}): { session: AgentSession; events: AgentEvent[] } {
  const root = mkdtempSync(join(tmpdir(), "moh-composer-bash-"));
  roots.push(root);
  const events: AgentEvent[] = [];
  const assembled = sessionFromConfig({
    cwd: root,
    home: root,
    config: { provider: "mock" },
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
});
