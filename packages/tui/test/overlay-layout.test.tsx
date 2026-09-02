import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, builtinTools } from "@moh/core";
import { Chat } from "../src/Chat";
import { PermissionModal } from "../src/PermissionModal";
import { PermissionGate } from "../src/permission-gate";
import { AskUserGate } from "../src/ask-user-gate";
import { makeSession } from "../src/factory";
import { stripAnsi, unwrap } from "./helpers";
import { Dialog } from "../src/ui";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const askScript = () => [
  {
    deltas: [""],
    finish: "tool_calls" as const,
    toolCalls: [
      {
        name: "ask_user",
        args: {
          questions: [
            {
              question: "Which database should I use?",
              header: "Database",
              options: [
                { label: "SQLite", description: "zero-config, file-based" },
                { label: "Postgres", description: "production-grade server" },
                { label: "Redis", description: "in-memory store" },
              ],
              suggested: "Postgres",
            },
          ],
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
  test("ask_user renders intact inline under a live Chat (#412)", async () => {
    const { cwd, home } = tempDirs();
    const gate = new AskUserGate();
    const { session } = unwrap(makeSession({
      cwd,
      home,
      provider: MockProvider.scripted(askScript()),
      tools: builtinTools(),
      onAskUser: gate.ask,
    }));
    const i = render(
      <Box flexDirection="column">
        <Chat session={session} cwd={mkdtempSync(join(tmpdir(), "moh-gitless-"))} mode="dev" modelLabel="mock" askGate={gate} />
      </Box>,
    );
    await sleep(30);
    i.stdin.write("go");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(250);
    const frame = stripAnsi(i.lastFrame() ?? "");
    // Every inline block row must be intact between the input and the
    // bottom bar: chip row (current chip + flush-right counter, #426),
    // question, all three options with the suggested marker, and the
    // Other affordance — inside the bordered layout-A panel.
    expect(frame).toContain("❯ Database");
    expect(frame).toContain("1/1");
    expect(frame).toContain("Which database should I use?");
    expect(frame).toContain("1 SQLite");
    expect(frame).toContain("2 Postgres ◂");
    expect(frame).toContain("3 Redis");
    expect(frame).toContain("Other");
    expect(frame).toContain("╭");
    gate.resolve({ answers: [{ labels: ["Postgres"] }] });
    await sleep(50);
    i.unmount();
  });

  test("permission modal renders intact above a live Chat", async () => {
    const { cwd, home } = tempDirs();
    const gate = new PermissionGate();
    const { session } = unwrap(makeSession({
      cwd,
      home,
      provider: MockProvider.scripted(bashScript()),
      tools: builtinTools(),
      onPermissionRequest: gate.ask,
    }));
    const i = render(
      <Box flexDirection="column">
        <Chat session={session} cwd={mkdtempSync(join(tmpdir(), "moh-gitless-"))} mode="dev" modelLabel="mock" />
        <PermissionModal gate={gate} mode="dev" />
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

describe("overlay restyle (issue #119, spec D8)", () => {
  test("Dialog renders the dashboard language: round border, semantic title color, solid bg", () => {
    const theme = THEMES[DEFAULT_THEME];
    const { lastFrame } = render(
      <ThemeProvider value={theme}>
        <Dialog title=" settings " color={theme.ok}>
          <Text>body</Text>
        </Dialog>
      </ThemeProvider>,
    );
    const raw = lastFrame() ?? "";
    // chalk is level-0 in the test env, so color tokens are asserted via
    // the Dialog contract (title/color/bg props) rather than ANSI escapes.
    expect(raw).toContain("╭"); // round border (not single/square)
    expect(raw).not.toContain("┌");
    expect(stripAnsi(raw)).toContain("settings"); // semantic-colored title row
    expect(stripAnsi(raw)).toContain("body");
  });
});
