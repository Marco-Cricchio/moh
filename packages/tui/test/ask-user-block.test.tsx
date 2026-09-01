import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, SessionStore, builtinTools, type AskUserQuestionSet, type Tool } from "@moh/core";
import { AskUserBlock } from "../src/AskUserBlock";
import { AskUserGate } from "../src/ask-user-gate";
import { makeSession } from "../src/factory";
import { projectTurns } from "../src/turns";
import { toolArgSummary } from "../src/permission-gate";
import { stripAnsi, unwrap, waitForFrame } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const QUESTION: AskUserQuestionSet = {
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
};

const TWO = {
  questions: [
    ...QUESTION.questions,
    {
      question: "And the cache?",
      header: "Cache",
      options: [
        { label: "in-process", description: "no extra service" },
        { label: "Valkey", description: "shared, persistent" },
      ],
      suggested: "Valkey",
    },
  ],
} satisfies AskUserQuestionSet;

const MULTI = {
  questions: [
    {
      question: "Which tests?",
      header: "Tests",
      multiSelect: true,
      options: [
        { label: "unit", description: "fast" },
        { label: "pty", description: "slow tail" },
        { label: "e2e", description: "slowest" },
      ],
    },
  ],
} satisfies AskUserQuestionSet;

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
const script = (args: unknown) => [
  {
    deltas: [""],
    finish: "tool_calls" as const,
    toolCalls: [{ name: "ask_user", args }],
  },
  { deltas: ["all set"], finish: "stop" as const },
];

/** Renders the inline block and drains a tick so ink installs input. */
async function mount(gate: AskUserGate) {
  const i = render(<AskUserBlock gate={gate} />);
  await sleep(30);
  return i;
}

describe("ask_user inline block (ADR-0019 / #412)", () => {
  test("renders header chip, question, options, recommended chip, Other — no dialog border", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = await mount(gate);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Which database should I use?");
    expect(frame).toContain("Database");
    expect(frame).toContain("1/1");
    expect(frame).toContain("SQLite");
    expect(frame).toContain("Postgres");
    expect(frame).toContain("recommended"); // visual chip, not "← suggested"
    expect(frame).toContain("Other"); // always the last option
    expect(frame).not.toContain("╭"); // no Dialog border — inline, not modal
    gate.resolve({ answers: [{ labels: ["Postgres"] }] });
    await pending; // no unhandled rejection
    i.unmount();
  });

  test("single question: enter → summary; enter on summary submits", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = await mount(gate);
    i.stdin.write("\x1b[B"); // down to Postgres
    await sleep(20);
    i.stdin.write("\r"); // advance
    await sleep(20);
    const mid = stripAnsi(i.lastFrame() ?? "");
    expect(mid).toContain("Review your answers");
    expect(mid).toContain("Database: Postgres");
    i.stdin.write("\r"); // submit
    await sleep(20);
    expect(await pending).toEqual({ answers: [{ labels: ["Postgres"] }] });
    expect(gate.current).toBeNull();
    i.unmount();
  });

  test("esc on the first question stays put (nothing to go back to)", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(TWO);
    const i = await mount(gate);
    i.stdin.write("\x1b"); // esc on 1/2
    await sleep(20);
    expect(gate.current).not.toBeNull(); // still up, not cancelled
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("1/2");
    gate.resolve({ answers: [{ labels: ["SQLite"] }, { labels: ["Valkey"] }] });
    await pending;
    i.unmount();
  });

  test("two questions: tab between questions is arrow-driven; esc navigates back", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(TWO);
    const i = await mount(gate);
    // Q1: down to Postgres, enter
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("2/2");
    // esc → back to Q1, answer is restored (Postgres focused reset to first)
    i.stdin.write("\x1b");
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("1/2");
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\r"); // Postgres again
    await sleep(20);
    i.stdin.write("\x1b[B"); // Q2: down to Valkey
    await sleep(20);
    i.stdin.write("\r");
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Review your answers");
    i.stdin.write("\r"); // submit
    await sleep(20);
    expect(await pending).toEqual({ answers: [{ labels: ["Postgres"] }, { labels: ["Valkey"] }] });
    i.unmount();
  });

  test("Other: arrows reach it, free text types inline, enter advances", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = await mount(gate);
    // Arrow down past the last option → Other
    i.stdin.write("\x1b[B\x1b[B\x1b[B"); // SQLite→Postgres→Redis→Other
    await sleep(20);
    i.stdin.write("Mon");
    await sleep(20);
    i.stdin.write("go");
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await waitForFrame(frame, "Mongo");
    i.stdin.write("\x7f"); // backspace
    await waitForFrame(frame, "Mong");
    i.stdin.write("o");
    await waitForFrame(frame, "Mongo");
    i.stdin.write("\r"); // advance with the Other answer
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Other: Mongo");
    i.stdin.write("\r"); // submit
    await sleep(20);
    expect(await pending).toEqual({ answers: [{ other: "Mongo" }] });
    i.unmount();
  });

  test("Other empty text on enter: nothing submits", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = await mount(gate);
    i.stdin.write("\x1b[B\x1b[B\x1b[B"); // Other
    await sleep(20);
    i.stdin.write("\r"); // empty
    await sleep(20);
    expect(gate.current).not.toBeNull();
    gate.resolve({ answers: [{ other: "fallback" }] });
    expect(await pending).toEqual({ answers: [{ other: "fallback" }] });
    i.unmount();
  });

  test("multiSelect: space toggles, enter confirms, summary shows the list", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(MULTI);
    const i = await mount(gate);
    i.stdin.write(" "); // toggle unit
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("[x] 1 unit");
    i.stdin.write("\x1b[B"); // down
    await sleep(30);
    i.stdin.write(" "); // toggle pty
    await sleep(30);
    i.stdin.write("\r"); // confirm selection
    await sleep(30);
    const mid = stripAnsi(i.lastFrame() ?? "");
    expect(mid).toContain("Tests: unit, pty");
    i.stdin.write("\r"); // submit
    await sleep(20);
    expect(await pending).toEqual({ answers: [{ labels: ["unit", "pty"] }] });
    i.unmount();
  });

  test("cancel from the summary (ctrl+x) resolves cancelled; the turn's tool result is 'cancelled'", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = await mount(gate);
    i.stdin.write("\r"); // advance to summary
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("ctrl+x cancel");
    i.stdin.write("\x18"); // ctrl+x — explicit cancel
    await sleep(20);
    expect(await pending).toEqual({ answers: [], cancelled: true });
    expect(gate.current).toBeNull();
    i.unmount();
  });

  test("wiring: factory passes onAskUser — the model's ask_user reaches the block; the model receives the answer", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-ask-"));
    const home = mkdtempSync(join(tmpdir(), "moh-ask-h-"));
    const seen: string[] = [];
    const gate = new AskUserGate();
    const { session } = unwrap(makeSession({
      cwd,
      home,
      provider: MockProvider.scripted(script(QUESTION)),
      tools: askUserTool(seen),
      onAskUser: gate.ask,
    }));
    const i = await mount(gate);
    void session.send("pick one");
    await sleep(200);
    expect(gate.current?.questions[0]?.question).toBe("Which database should I use?");
    expect(seen).toEqual([]); // turn suspended on the block

    gate.resolve({ answers: [{ labels: ["Redis"] }] });
    await sleep(300);
    expect(seen).toEqual(["Which database should I use?: Redis"]);
    i.unmount();
  });

  test("replay: the question and the answer render from the event log", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-ask-"));
    const home = mkdtempSync(join(tmpdir(), "moh-ask-h-"));
    const seen: string[] = [];
    const store = SessionStore.create(cwd, home);
    const gate = new AskUserGate();
    const { session } = unwrap(makeSession({
      cwd,
      home,
      store,
      provider: MockProvider.scripted(script(QUESTION)),
      tools: askUserTool(seen),
      onAskUser: gate.ask,
    }));
    void session.send("pick one");
    await sleep(200);
    gate.resolve({ answers: [{ labels: ["Postgres"] }] });
    await sleep(300);

    const turns = projectTurns(store.load());
    const call = turns.flatMap((t) => t.toolCalls).find((c) => c.name === "ask_user")!;
    expect(toolArgSummary(call.args)).toBe("Which database should I use?");
    expect(call.ok).toBe(true);
    expect(call.output).toBe("Which database should I use?: Postgres");
  });
});
