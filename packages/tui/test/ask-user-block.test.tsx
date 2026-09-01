import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, SessionStore, builtinTools, type AskUserQuestionSet, type Tool } from "@moh/core";
import { AskUserBlock, askUserBlockRows } from "../src/AskUserBlock";
import { AskUserGate } from "../src/ask-user-gate";
import { makeSession } from "../src/factory";
import { projectTurns } from "../src/turns";
import { toolArgSummary } from "../src/permission-gate";
import { Chat } from "../src/Chat";
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

  test("two questions: tab advances between questions; esc navigates back", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(TWO);
    const i = await mount(gate);
    // Q1: down to Postgres, tab to Q2
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\t");
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("2/2");
    // esc → back to Q1, answer state restored
    i.stdin.write("\x1b");
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("1/2");
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\r"); // Postgres again (enter also advances)
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

const LONG_PREVIEW = ["# Verbose style", "", ...Array.from({ length: 30 }, (_, i) => `line-${i} of the verbose essay`)].join("\n");

const PREVIEW_SET = {
  questions: [
    {
      question: "Which reply style?",
      header: "Style",
      options: [
        { label: "concise", description: "short answers", preview: "**Concise**: short answers, no filler." },
        { label: "verbose", description: "long essays", preview: LONG_PREVIEW },
        { label: "plain", description: "no preview here" },
      ],
      suggested: "concise",
    },
  ],
} satisfies AskUserQuestionSet;

describe("ask_user preview side-by-side (#414)", () => {
  /** Mounts the block at an explicit width (side-by-side needs columns). */
  async function mountAt(gate: AskUserGate, width: number) {
    const i = render(<AskUserBlock gate={gate} width={width} />);
    await sleep(30);
    return i;
  }

  test("preview-bearing question renders side-by-side; focused (not selected) option drives the preview", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(PREVIEW_SET);
    const i = await mountAt(gate, 100);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // Bordered preview box beside the option list, showing the focused
    // option's (concise, index 0) content — markdown-bolded text renders.
    await waitForFrame(frame, "Concise");
    expect(frame()).toContain("┌");
    expect(frame()).toContain("short answers, no filler");
    // Descriptions are omitted in the side-by-side left column.
    expect(frame()).not.toContain("long essays");
    // Down to verbose: the preview swaps to its title.
    i.stdin.write("\x1b[B");
    await waitForFrame(frame, "Verbose style");
    // Down to plain (no preview): the box disappears.
    i.stdin.write("\x1b[B");
    await sleep(40);
    expect(frame()).not.toContain("┌");
    gate.resolve({ answers: [{ labels: ["verbose"] }] });
    await pending;
    i.unmount();
  });

  test("preview content truncates with a hidden-lines indicator beyond the budget", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(PREVIEW_SET);
    const i = await mountAt(gate, 100);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    i.stdin.write("\x1b[B"); // verbose — 33 rendered rows vs a 20-row cap
    await waitForFrame(frame, "lines hidden");
    expect(frame()).not.toContain("line-25 of");
    gate.resolve({ answers: [{ labels: ["verbose"] }] });
    await pending;
    i.unmount();
  });

  test("plain questions keep the stacked layout — no preview box", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = await mountAt(gate, 100);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("zero-config, file-based"); // descriptions shown
    expect(frame).not.toContain("┌");
    gate.resolve({ answers: [{ labels: ["SQLite"] }] });
    await pending;
    i.unmount();
  });

  test("askUserBlockRows reserves the tallest preview box's height", () => {
    const plain = askUserBlockRows(QUESTION.questions);
    expect(askUserBlockRows(PREVIEW_SET.questions)).toBe(plain + 23); // min(20, 32 lines) + 3
    expect(askUserBlockRows(QUESTION.questions)).toBe(askUserBlockRows([
      { ...QUESTION.questions[0]!, options: [{ label: "a" }, { label: "b" }, { label: "c", preview: "one line" }] },
    ]) - 4); // short preview: 1 content row + 3 overhead
  });

  test("wiring: the chosen option's preview is echoed to the model in the tool result", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-ask-prev-"));
    const home = mkdtempSync(join(tmpdir(), "moh-ask-prev-h-"));
    const seen: string[] = [];
    const gate = new AskUserGate();
    const { session } = unwrap(makeSession({
      cwd,
      home,
      provider: MockProvider.scripted(script(PREVIEW_SET)),
      tools: askUserTool(seen),
      onAskUser: gate.ask,
    }));
    const i = await mountAt(gate, 100);
    void session.send("pick a style");
    await sleep(200);
    gate.resolve({ answers: [{ labels: ["verbose"] }] });
    await sleep(300);
    expect(seen[0]).toContain("Which reply style?: verbose\n# Verbose style");
    i.unmount();
  });
});

/** Mounts a full Chat (transcript + composer + inline block) wired to a
 * scripted session whose first turn suspends on the ask_user tool. */
async function mountChat(
  gate: AskUserGate,
  set: AskUserQuestionSet,
  opts: { columns: number; rows: number },
) {
  const cwd = mkdtempSync(join(tmpdir(), "moh-ask-chat-"));
  const home = mkdtempSync(join(tmpdir(), "moh-ask-chat-h-"));
  const { session } = unwrap(makeSession({
    cwd,
    home,
    provider: MockProvider.scripted([
      { deltas: [""], finish: "tool_calls" as const, toolCalls: [{ name: "ask_user", args: set }] },
      // Long slow reply keeps the turn pending after the answers return,
      // so the promoted Static projection is observable mid-turn (#413).
      { deltas: Array.from({ length: 20 }, (_, i) => `after-${i} `), deltaDelayMs: 60, finish: "stop" as const },
    ]),
    onAskUser: gate.ask,
    permissionMode: "auto-accept",
  }));
  const element = (extra: Partial<React.ComponentProps<typeof Chat>> = {}) => (
    <Chat
      session={session}
      cwd={cwd}
      mode="dev"
      modelLabel="mock"
      width={opts.columns}
      askGate={gate}
      {...extra}
    />
  );
  const ink = render(element());
  Object.defineProperty(ink.stdout, "columns", { value: opts.columns, configurable: true });
  Object.defineProperty(ink.stdout, "rows", { value: opts.rows, configurable: true });
  ink.rerender(element());
  void session.send("ask me");
  // The session's own ask_user drives the gate — never pre-ask manually.
  const frame = () => stripAnsi(ink.lastFrame() ?? "");
  const first = BIG_SET.questions[0]!.question;
  await waitForFrame(frame, set.questions[0]!.question, { timeoutMs: 4000 });
  await sleep(80); // let ink install the block's useInput handler
  return { ink, session, element };
}

const BIG_SET = {
  questions: [
    {
      question: "First long decision question about deployment strategy?",
      header: "Deploy",
      options: [
        { label: "blue-green", description: "zero downtime, double infra" },
        { label: "canary", description: "gradual rollout, metrics gated" },
        { label: "rolling", description: "simple, brief dip" },
      ],
      suggested: "canary",
    },
    {
      question: "Second long decision question about database choice?",
      header: "DB",
      options: [
        { label: "SQLite", description: "zero-config, file-based" },
        { label: "Postgres", description: "production-grade server" },
      ],
      suggested: "SQLite",
    },
  ],
} satisfies AskUserQuestionSet;

describe("ask_user dynamic resize + Static projection (#413)", () => {
  test("askUserBlockRows: scales with the tallest question screen, never below the summary screen (#413)", () => {
    // Small single-question set: header + question + 2 options + Other + footer + padding.
    expect(askUserBlockRows([{ question: "q", options: [{}, {}] }])).toBe(2 + 5 + 3);
    // Many questions, few options each: the summary screen (1 row/question
    // + header/blank rows) sets the floor, the tallest question screen the
    // ceiling.
    expect(askUserBlockRows([
      { question: "a", options: [{}] },
      { question: "b", options: [{}] },
      { question: "c", options: [{}] },
      { question: "d", options: [{}] },
    ])).toBe(4 + 4 + 3); // summary floor (4 rows + header/blank) beats the question screen
    // One question with a big option list dominates the set.
    expect(askUserBlockRows([
      { question: "a", options: [{}, {}] },
      { question: "b", options: [{}, {}, {}, {}] },
    ])).toBe(12);
  });

  test("while the set is open: block grows with content, frameless, and the volatile transcript compresses", async () => {
    const gate = new AskUserGate();
    // Short terminal: the block's height must eat into the transcript budget.
    const { ink } = await mountChat(gate, BIG_SET, { columns: 100, rows: 16 });
    const open = stripAnsi(ink.lastFrame() ?? "");
    // The block is frameless (#183): no Dialog border anywhere.
    expect(open).not.toContain("╭");
    // One question at a time with its full option set — the block grows
    // with content rather than clipping the questions.
    expect(open).toContain("First long decision question");
    expect(open).toContain("blue-green");
    expect(open).toContain("canary");
    expect(open).toContain("rolling");
    expect(open).toContain("1/2");
    // The pending call stays visible as one compact question row (#413:
    // no longer suppressed) — at 16 rows the transcript budget compressed
    // to 1 row, which transcriptTail gives to the newest block (the ask
    // row itself), so the question appears once: the volatile tool row.
    expect(open.split("First long decision question").length - 1).toBe(1);
    ink.unmount();
  });

  test("small sets stay compact on a tall terminal — transcript keeps its full budget", async () => {
    const gate = new AskUserGate();
    const { ink } = await mountChat(gate, QUESTION, { columns: 100, rows: 40 });
    const open = stripAnsi(ink.lastFrame() ?? "");
    expect(open).toContain("Which database should I use?");
    expect(open).toContain("1/1");
    // Plenty of transcript room: the fake-openai-style long turn is not
    // squeezed — the whole geometry still renders the composer and bars.
    expect(open).toContain("type");
    ink.unmount();
    gate.resolve({ answers: [{ labels: ["SQLite"] }] });
  });

  test("on resolution: compact Static projection — one row per question with answers, unchosen options omitted", async () => {
    const gate = new AskUserGate();
    const { ink } = await mountChat(gate, BIG_SET, { columns: 100, rows: 40 });
    // Answer both questions: Q1 down to canary, advance; Q2 down to Postgres, advance; submit.
    ink.stdin.write("\x1b[B"); // canary
    await sleep(30);
    ink.stdin.write("\r");
    await sleep(30);
    ink.stdin.write("\x1b[B"); // Postgres
    await sleep(30);
    ink.stdin.write("\r");
    await sleep(30);
    ink.stdin.write("\r"); // submit from summary
    await sleep(150);
    expect(gate.current).toBeNull(); // settled
    // The settled projection lands in the frame while the long reply
    // still streams: questions once, answers attached, no unchosen option
    // text (SQLite/rolling/blue-green never render in the settled rows).
    const settled = stripAnsi(ink.lastFrame() ?? "");
    expect(settled).toContain("↳ you: canary");
    expect(settled).toContain("↳ you: Postgres");
    expect(settled.split("First long decision question").length - 1).toBe(1);
    ink.unmount();
  }, 15000);
});
