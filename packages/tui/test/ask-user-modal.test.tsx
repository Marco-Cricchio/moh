import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, SessionStore, builtinTools, type AskUserQuestionSet, type Tool } from "@moh/core";
import { AskUserModal } from "../src/AskUserModal";
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

describe("ask_user question set (ADR-0019 / #411, transitional modal)", () => {
  test("overlapping ask rejects instead of silently answering (#68)", async () => {
    const gate = new AskUserGate();
    const first = gate.ask(QUESTION);
    await expect(gate.ask(QUESTION)).rejects.toThrow("ask_user: a question set is already pending");
    gate.resolve({ answers: [{ labels: ["Postgres"] }] });
    expect(await first).toEqual({ answers: [{ labels: ["Postgres"] }] });
  });

  test("renders header chip, question, options, suggested marker, free-text affordance", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = render(<AskUserModal gate={gate} />);
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Which database should I use?");
    expect(frame).toContain("Database (1/1)");
    expect(frame).toContain("SQLite");
    expect(frame).toContain("← suggested");
    expect(frame).toContain("or type your answer");
    gate.resolve({ answers: [{ labels: ["Postgres"] }] });
    await pending; // no unhandled rejection
    i.unmount();
  });

  test("strips terminal controls from the question and option text", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask({
      questions: [
        {
          question: "Question\u001b[2K",
          header: "Safe",
          suggested: "safe\u001b[2K",
          options: [{ label: "safe\u001b[2K", description: "description\u009b2K" }, { label: "b", description: "d" }],
        },
      ],
    });
    const i = render(<AskUserModal gate={gate} />);
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Question");
    expect(frame).toContain("safe");
    expect(frame).toContain("description");
    expect(frame).not.toContain("[2K");
    gate.resolve({ answers: [{ labels: ["safe\u001b[2K"] }] });
    await pending;
    i.unmount();
  });

  test("enter picks the focused option; esc cancels the whole set", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = render(<AskUserModal gate={gate} />);
    await sleep(30);
    i.stdin.write("\x1b[B"); // down to Postgres (focus starts at option 1)
    await sleep(20);
    i.stdin.write("\r");
    await sleep(20);
    expect(await pending).toEqual({ answers: [{ labels: ["Postgres"] }] });
    expect(gate.current).toBeNull();
    i.unmount();

    const gate2 = new AskUserGate();
    const pending2 = gate2.ask(QUESTION);
    const i2 = render(<AskUserModal gate={gate2} />);
    await sleep(30);
    i2.stdin.write("\x1b"); // esc → cancel the set (no more esc=suggested)
    await sleep(20);
    expect(await pending2).toEqual({ answers: [], cancelled: true });
    i2.unmount();
  });

  test("multi-question set: answers collected one question at a time, all before the turn resumes", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(TWO);
    const i = render(<AskUserModal gate={gate} />);
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Database (1/2)");
    i.stdin.write("\r"); // SQLite
    await sleep(20);
    const mid = stripAnsi(i.lastFrame() ?? "");
    expect(mid).toContain("Cache (2/2)");
    expect(mid).toContain("And the cache?");
    expect(gate.current).not.toBeNull(); // turn still held
    i.stdin.write("\x1b[B"); // down to Valkey
    await sleep(20);
    i.stdin.write("\r");
    await sleep(20);
    expect(await pending).toEqual({ answers: [{ labels: ["SQLite"] }, { labels: ["Valkey"] }] });
    i.unmount();
  });

  test("typing switches to free text; enter submits an 'Other' answer", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = render(<AskUserModal gate={gate} />);
    await sleep(30); // deliberate: Ink's input handler is not frame-observable
    i.stdin.write("Mon");
    await sleep(20); // deliberate: the text input re-registers after a keystroke
    i.stdin.write("go");
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await waitForFrame(frame, "Mongo");
    expect(frame()).toContain("enter send"); // text-mode footer
    i.stdin.write("\x7f"); // backspace
    await waitForFrame(frame, "Mong");
    i.stdin.write("o");
    await waitForFrame(frame, "Mongo");
    i.stdin.write("\r");
    expect(await pending).toEqual({ answers: [{ other: "Mongo" }] });
    i.unmount();
  });

  test("empty free text keeps the overlay up (no accidental empty answer)", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = render(<AskUserModal gate={gate} />);
    await sleep(30);
    i.stdin.write("x");
    await sleep(20);
    i.stdin.write("\x7f"); // back to empty
    await sleep(20);
    i.stdin.write("\r");
    await sleep(20);
    expect(gate.current).not.toBeNull(); // still up
    gate.resolve({ answers: [{ other: "fallback" }] }); // settle without the UI
    expect(await pending).toEqual({ answers: [{ other: "fallback" }] });
    i.unmount();
  });

  test("wiring: factory passes onAskUser to the session — the model's ask_user reaches the overlay", async () => {
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
    const i = render(<AskUserModal gate={gate} />);
    await sleep(30);
    void session.send("pick one");
    await sleep(200);
    expect(gate.current?.questions[0]?.question).toBe("Which database should I use?");
    expect(seen).toEqual([]); // turn suspended on the overlay

    gate.resolve({ answers: [{ labels: ["Redis"] }] });
    await sleep(300);
    expect(seen).toEqual(["Which database should I use?: Redis"]); // the model received the answer
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
