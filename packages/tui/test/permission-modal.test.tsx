import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, SessionStore, type AgentSession, type Tool } from "@moh/core";
import { Chat } from "../src/Chat";
import { PermissionModal } from "../src/PermissionModal";
import { PermissionGate } from "../src/permission-gate";
import { makeSession } from "../src/factory";
import { stripAnsi, unwrap } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recordingBashTool(calls: string[]): Record<string, Tool> {
  return {
    bash: {
      name: "bash",
      description: "run a command",
      inputSchema: undefined,
      execute: async (args: any) => {
        calls.push(args.command as string);
        return "done";
      },
    },
  };
}

/** A four-turn script: tool→stop, tool→stop (the modal path, twice). */
const script = () => [
  { deltas: [""], finish: "tool_calls" as const, toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
  { deltas: ["ok one"], finish: "stop" as const },
  { deltas: [""], finish: "tool_calls" as const, toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
  { deltas: ["ok two"], finish: "stop" as const },
];

function Harness({ session, gate }: { session: AgentSession; gate: PermissionGate }) {
  return (
    <Box flexDirection="column">
      <Chat session={session} mode="dev" modelLabel="mock" />
      <PermissionModal gate={gate} mode="dev" />
    </Box>
  );
}

describe("permission modal (issue #33)", () => {
  test("blocks, shows full command detail, y allows the call", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-perm-"));
    const home = mkdtempSync(join(tmpdir(), "moh-perm-h-"));
    const store = SessionStore.create(cwd, home);
    const gate = new PermissionGate();
    const calls: string[] = [];
    const { session } = unwrap(makeSession({
      cwd,
      home,
      store,
      provider: MockProvider.scripted(script()),
      tools: recordingBashTool(calls),
      onPermissionRequest: gate.ask,
    }));
    const i = render(<Harness session={session} gate={gate} />);
    await sleep(30);
    i.stdin.write("go");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(150);

    // Blocked: the turn is suspended on the modal with full detail.
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("permission");
    expect(frame).toContain("command: echo hi");
    expect(frame).toContain("writes the session rule: bash:echo hi");
    expect(calls).toEqual([]); // still blocked

    i.stdin.write("y");
    await sleep(300);
    expect(calls).toEqual(["echo hi"]);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("ok one");
    i.unmount();
  });

  test("“a” (always) writes a runtime rule, restorable on replay", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-perm-"));
    const home = mkdtempSync(join(tmpdir(), "moh-perm-h-"));
    const store = SessionStore.create(cwd, home);
    const gate = new PermissionGate();
    const calls: string[] = [];
    const { session } = unwrap(makeSession({
      cwd,
      home,
      store,
      provider: MockProvider.scripted(script()),
      tools: recordingBashTool(calls),
      onPermissionRequest: gate.ask,
    }));
    const i = render(<Harness session={session} gate={gate} />);
    await sleep(30);
    i.stdin.write("first");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(150);
    i.stdin.write("a"); // always → runtime rule + allow
    await sleep(300);
    expect(calls).toEqual(["echo hi"]);
    expect(store.load().some((e) => e.type === "permission_rule_added")).toBe(true);
    i.unmount();

    // Replay: a resumed session restores the runtime rule from the log and
    // the same command runs without asking again.
    const gate2 = new PermissionGate();
    const resumed = unwrap(makeSession({
      cwd,
      home,
      store,
      provider: MockProvider.scripted(script().slice(2)),
      tools: recordingBashTool(calls),
      onPermissionRequest: gate2.ask,
      resumeEvents: store.load(),
    }));
    expect(
      resumed.session.permissionRules.some((r) => r.tool === "bash" && r.effect === "allow"),
    ).toBe(true);

    const i2 = render(<Harness session={resumed.session} gate={gate2} />);
    await sleep(30);
    i2.stdin.write("again");
    await sleep(20);
    i2.stdin.write("\r");
    await sleep(400);
    expect(gate2.current).toBeNull(); // never asked
    expect(calls).toEqual(["echo hi", "echo hi"]);
    expect(stripAnsi(i2.lastFrame() ?? "")).toContain("ok two");
    i2.unmount();
  });

  test("n (deny) produces a structured denial the model sees", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-perm-"));
    const home = mkdtempSync(join(tmpdir(), "moh-perm-h-"));
    const gate = new PermissionGate();
    const calls: string[] = [];
    const { session, store } = unwrap(makeSession({
      cwd,
      home,
      provider: MockProvider.scripted(script()),
      tools: recordingBashTool(calls),
      onPermissionRequest: gate.ask,
    }));
    const i = render(<Harness session={session} gate={gate} />);
    await sleep(30);
    i.stdin.write("go");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(150);
    i.stdin.write("n");
    await sleep(300);
    expect(calls).toEqual([]);
    expect(store.load().some((e) => e.type === "permission_denied")).toBe(true);
    i.unmount();
  });
});
