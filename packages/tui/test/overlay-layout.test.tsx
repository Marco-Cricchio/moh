import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, builtinTools } from "@moh/core";
import { Chat } from "../src/Chat";
import { PermissionModal } from "../src/PermissionModal";
import { PermissionGate } from "../src/permission-gate";
import { AskUserModal } from "../src/AskUserModal";
import { AskUserGate } from "../src/ask-user-gate";
import { makeSession } from "../src/factory";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const askScript = () => [
  {
    deltas: [""],
    finish: "tool_calls" as const,
    toolCalls: [
      {
        name: "ask_user",
        args: {
          question: "Which database should I use?",
          options: [
            { label: "SQLite", description: "zero-config, file-based" },
            { label: "Postgres", description: "production-grade server" },
            { label: "Redis", description: "in-memory store" },
          ],
          suggested: "Postgres",
        },
      },
    ],
  },
  { deltas: ["all set"], finish: "stop" as const },
];

const bashScript = () => [
  { deltas: [""], finish: "tool_calls" as const, toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
  { deltas: ["ok"], finish: "stop" as const },
];

function tempDirs() {
  return {
    cwd: mkdtempSync(join(tmpdir(), "moh-ovl-")),
    home: mkdtempSync(join(tmpdir(), "moh-ovl-h-")),
  };
}

/**
 * Overlay layout integrity (issue #70 follow-up): ink never constrains the
 * root node's height, so a `height="100%"` child is unresolvable and, in
 * that combination, Yoga collapses the layout of siblings rendered after
 * it — exactly where the TUI mounts its modal overlays. These tests pin
 * the real call-site pattern (Chat + overlay as siblings) so a percent
 * height can't sneak back in and corrupt overlay frames.
 */
describe("overlay layout integrity over Chat", () => {
  test("ask_user overlay renders intact above a live Chat", async () => {
    const { cwd, home } = tempDirs();
    const gate = new AskUserGate();
    const { session } = makeSession({
      cwd,
      home,
      provider: MockProvider.scripted(askScript()),
      tools: builtinTools(),
      onAskUser: gate.ask,
    });
    const i = render(
      <Box flexDirection="column">
        <Chat session={session} mode="dev" modelLabel="mock" />
        <AskUserModal gate={gate} compact={false} />
      </Box>,
    );
    await sleep(30);
    i.stdin.write("go");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(250);
    const frame = stripAnsi(i.lastFrame() ?? "");
    // Every overlay row must be intact: question, all three options, the
    // suggested marker, and the free-text affordance.
    expect(frame).toContain("Which database should I use?");
    expect(frame).toContain("1  SQLite  zero-config, file-based");
    expect(frame).toContain("2  Postgres  ← suggested");
    expect(frame).toContain("3  Redis  in-memory store");
    expect(frame).toContain("or type your answer");
    gate.resolve({ choice: "Postgres" });
    await sleep(50);
    i.unmount();
  });

  test("permission modal renders intact above a live Chat", async () => {
    const { cwd, home } = tempDirs();
    const gate = new PermissionGate();
    const { session } = makeSession({
      cwd,
      home,
      provider: MockProvider.scripted(bashScript()),
      tools: builtinTools(),
      onPermissionRequest: gate.ask,
    });
    const i = render(
      <Box flexDirection="column">
        <Chat session={session} mode="dev" modelLabel="mock" />
        <PermissionModal gate={gate} mode="dev" compact={false} />
      </Box>,
    );
    await sleep(30);
    i.stdin.write("go");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(250);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("A tool call needs your approval:");
    expect(frame).toContain("command: echo hi");
    gate.resolve("no");
    await sleep(50);
    i.unmount();
  });
});
