import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, SessionStore, builtinTools, type AskUserQuestion, type Tool } from "@moh/core";
import { AskUserModal } from "../src/AskUserModal";
import { AskUserGate } from "../src/ask-user-gate";
import { makeSession } from "../src/factory";
import { projectTurns } from "../src/turns";
import { toolArgSummary } from "../src/permission-gate";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const QUESTION: AskUserQuestion = {
  question: "Which database should I use?",
  options: [
    { label: "SQLite", description: "zero-config, file-based" },
    { label: "Postgres", description: "production-grade server" },
    { label: "Redis", description: "in-memory store" },
  ],
  suggested: "Postgres",
};

/** ask_user built-in wrapped to record what the model receives. */
function askUserTool(seen: string[]): Record<string, Tool> {
  const base = builtinTools();
  return {
    ask_user: {
      ...base.ask_user,
      execute: async (args: any, ctx: any) => {
        const out = await base.ask_user.execute(args, ctx);
        seen.push(out);
        return out;
      },
    },
  };
}

/** Script: one ask_user call, then a closing reply. */
const script = () => [
  {
    deltas: [""],
    finish: "tool_calls" as const,
    toolCalls: [{ name: "ask_user", args: QUESTION }],
  },
  { deltas: ["all set"], finish: "stop" as const },
];

describe("ask_user overlay (issue #70)", () => {
  test("renders question, options, suggested marker, and the free-text affordance", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = render(<AskUserModal gate={gate} compact={false} />);
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Which database should I use?");
    expect(frame).toContain("SQLite");
    expect(frame).toContain("zero-config, file-based");
    expect(frame).toContain("Postgres");
    expect(frame).toContain("← suggested");
    expect(frame).toContain("> 2  Postgres"); // suggested is highlighted by default
    expect(frame).toContain("or type your answer");
    expect(frame).toContain("↑↓/1-4 choose");
    gate.resolve({ choice: "Postgres" });
    await pending; // no unhandled rejection
    i.unmount();
  });

  test("enter picks the highlighted option; esc falls back to the suggested one", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = render(<AskUserModal gate={gate} compact={false} />);
    await sleep(30);
    i.stdin.write("\r"); // enter → suggested (default highlight)
    await sleep(20);
    expect(await pending).toEqual({ choice: "Postgres" });
    expect(gate.current).toBeNull();
    i.unmount();

    const gate2 = new AskUserGate();
    const pending2 = gate2.ask(QUESTION);
    const i2 = render(<AskUserModal gate={gate2} compact={false} />);
    await sleep(30);
    i2.stdin.write("\x1b"); // esc → suggested
    await sleep(20);
    expect(await pending2).toEqual({ choice: "Postgres" });
    i2.unmount();
  });

  test("arrow and number navigation select any option", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = render(<AskUserModal gate={gate} compact={false} />);
    await sleep(30);
    i.stdin.write("\x1b[A"); // up from suggested → SQLite
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("> 1  SQLite");
    i.stdin.write("\x1b[B"); // down → Postgres
    await sleep(20);
    i.stdin.write("\x1b[B"); // down → Redis
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("> 3  Redis");
    i.stdin.write("1"); // direct number → SQLite
    await sleep(20);
    expect(await pending).toEqual({ choice: "SQLite" });
    i.unmount();
  });

  test("typing switches to free text; enter submits the text, not an option", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = render(<AskUserModal gate={gate} compact={false} />);
    await sleep(30);
    i.stdin.write("Mon");
    await sleep(20);
    i.stdin.write("go");
    await sleep(20);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Mongo");
    expect(frame).toContain("enter send"); // text-mode footer
    i.stdin.write("\x7f"); // backspace
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Mong");
    i.stdin.write("o");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(20);
    expect(await pending).toEqual({ text: "Mongo" });
    i.unmount();
  });

  test("empty free text keeps the overlay up (no accidental empty answer)", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = render(<AskUserModal gate={gate} compact={false} />);
    await sleep(30);
    i.stdin.write("x");
    await sleep(20);
    i.stdin.write("\x7f"); // back to empty
    await sleep(20);
    i.stdin.write("\r");
    await sleep(20);
    expect(gate.current).not.toBeNull(); // still up
    gate.resolve({ text: "fallback" }); // settle without the UI
    expect(await pending).toEqual({ text: "fallback" });
    i.unmount();
  });

  test("wiring: factory passes onAskUser to the session — the model's ask_user reaches the overlay", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-ask-"));
    const home = mkdtempSync(join(tmpdir(), "moh-ask-h-"));
    const seen: string[] = [];
    const gate = new AskUserGate();
    const { session } = makeSession({
      cwd,
      home,
      provider: MockProvider.scripted(script()),
      tools: askUserTool(seen),
      onAskUser: gate.ask,
    });
    const i = render(<AskUserModal gate={gate} compact={false} />);
    await sleep(30);
    void session.send("pick one");
    await sleep(200);
    expect(gate.current?.question).toBe("Which database should I use?");
    expect(seen).toEqual([]); // turn suspended on the overlay

    gate.resolve({ choice: "Redis" });
    await sleep(300);
    expect(seen).toEqual(["Redis"]); // the model received the answer
    i.unmount();
  });

  test("replay: the question and the answer render from the event log", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-ask-"));
    const home = mkdtempSync(join(tmpdir(), "moh-ask-h-"));
    const seen: string[] = [];
    const store = SessionStore.create(cwd, home);
    const gate = new AskUserGate();
    const { session } = makeSession({
      cwd,
      home,
      store,
      provider: MockProvider.scripted(script()),
      tools: askUserTool(seen),
      onAskUser: gate.ask,
    });
    void session.send("pick one");
    await sleep(200);
    gate.resolve({ choice: "Postgres" });
    await sleep(300);

    const turns = projectTurns(store.load());
    const call = turns.flatMap((t) => t.toolCalls).find((c) => c.name === "ask_user")!;
    expect(toolArgSummary(call.args)).toBe("Which database should I use?");
    expect(call.ok).toBe(true);
    expect(call.output).toBe("Postgres");
  });
});
