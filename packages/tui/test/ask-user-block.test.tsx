import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, SessionStore, builtinTools, type AskUserQuestionSet, type Tool } from "@moh/core";
import { AskUserBlock, askBlockMinRows, askUserBlockRows } from "../src/AskUserBlock";
import { AskUserGate } from "../src/ask-user-gate";
import { makeSession } from "../src/factory";
import { toolArgSummary } from "../src/permission-gate";
import { Chat } from "../src/Chat";
import { COMPOSER_READY, effectsFlushed, pressCommitted, stripAnsi, unwrap, waitForFrame, waitStep, waitText } from "./helpers";

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
  // The wiring tests mount before the model asks: nothing to wait on yet.
  if (gate.current) await waitText(i, gate.current.questions[0]!.question, "block rendered");
  else await effectsFlushed();
  return i;
}

describe("ask_user inline block (ADR-0019 / #412)", () => {
  test("renders panel with tab-chip row, question, options, recommended chip, Other (#426 layout A)", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = await mount(gate);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Which database should I use?");
    expect(frame).toContain("Database");
    expect(frame).toContain("1/1");
    expect(frame).toContain("SQLite");
    expect(frame).toContain("Postgres");
    expect(frame).toContain("◂"); // suggested chip, visual only (#426)
    expect(frame).toContain("Other"); // always the last option
    expect(frame).toContain("╭"); // bordered panel (layout A, #426)
    gate.resolve({ answers: [{ labels: ["Postgres"] }] });
    await pending; // no unhandled rejection
    i.unmount();
  });

  test("single question: enter → summary; enter on summary submits", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = await mount(gate);
    await pressCommitted(i, "\x1b[B", "key 1"); // down to Postgres
    await pressCommitted(i, "\r", "key 2"); // advance
    await waitText(i, "Review your answers", "summary shown");
    const mid = stripAnsi(i.lastFrame() ?? "");
    expect(mid).toContain("Review your answers");
    expect(mid).toContain("✓ Database     — Postgres"); // #426 summary row: check + padded header — answer
    i.stdin.write("\r"); // submit
    expect(await pending).toEqual({ answers: [{ labels: ["Postgres"] }] });
    expect(gate.current).toBeNull();
    i.unmount();
  });

  test("esc on the first question stays put (nothing to go back to)", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(TWO);
    const i = await mount(gate);
    i.stdin.write("\x1b"); // esc on 1/2
    await sleep(20); // negative assertion: nothing may change
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
    await pressCommitted(i, "\x1b[B", "key 5");
    await pressCommitted(i, "\t", "key 6");
    await waitText(i, "2/2", "second question");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("2/2");
    // esc → back to Q1, answer state restored
    await pressCommitted(i, "\x1b", "key 7");
    await waitText(i, "1/2", "back on the first question");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("1/2");
    await pressCommitted(i, "\x1b[B", "key 8");
    await pressCommitted(i, "\r", "key 9"); // Postgres again (enter also advances)
    await pressCommitted(i, "\x1b[B", "key 10"); // Q2: down to Valkey
    await pressCommitted(i, "\r", "key 11");
    await waitText(i, "Review your answers", "summary shown");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Review your answers");
    i.stdin.write("\r"); // submit
    expect(await pending).toEqual({ answers: [{ labels: ["Postgres"] }, { labels: ["Valkey"] }] });
    i.unmount();
  });

  test("Other: arrows reach it, free text types inline, enter advances", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = await mount(gate);
    // Arrow down past the last option → Other
    await pressCommitted(i, "\x1b[B\x1b[B\x1b[B", "key 13"); // SQLite→Postgres→Redis→Other
    await pressCommitted(i, "Mon", "key 14");
    i.stdin.write("go");
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await waitForFrame(frame, "Mongo");
    i.stdin.write("\x7f"); // backspace
    await waitForFrame(frame, "Mong");
    i.stdin.write("o");
    await waitForFrame(frame, "Mongo");
    await pressCommitted(i, "\r", "key 15"); // advance with the Other answer
    await waitText(i, "Other: Mongo", "Other answer in the summary");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Other: Mongo");
    i.stdin.write("\r"); // submit
    expect(await pending).toEqual({ answers: [{ other: "Mongo" }] });
    i.unmount();
  });

  test("Other empty text on enter: nothing submits", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = await mount(gate);
    await pressCommitted(i, "\x1b[B\x1b[B\x1b[B", "key 17"); // Other
    i.stdin.write("\r"); // empty
    await sleep(20); // negative assertion: nothing may change
    expect(gate.current).not.toBeNull();
    gate.resolve({ answers: [{ other: "fallback" }] });
    expect(await pending).toEqual({ answers: [{ other: "fallback" }] });
    i.unmount();
  });

  test("multiSelect: space toggles, enter confirms, summary shows the list", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(MULTI);
    const i = await mount(gate);
    await pressCommitted(i, " ", "key 19"); // toggle unit
    await waitText(i, "[x]  unit", "unit toggled");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("[x]  unit"); // #426: marker columns, no option numbers in multiSelect
    await pressCommitted(i, "\x1b[B", "key 20"); // down
    await pressCommitted(i, " ", "key 21"); // toggle pty
    await pressCommitted(i, "\r", "key 22"); // confirm selection
    await waitText(i, "✓ Tests        — unit, pty", "multiSelect summary");
    const mid = stripAnsi(i.lastFrame() ?? "");
    expect(mid).toContain("✓ Tests        — unit, pty");
    i.stdin.write("\r"); // submit
    expect(await pending).toEqual({ answers: [{ labels: ["unit", "pty"] }] });
    i.unmount();
  });

  test("cancel from the summary (ctrl+x) resolves cancelled; the turn's tool result is 'cancelled'", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const i = await mount(gate);
    await pressCommitted(i, "\r", "key 24"); // advance to summary
    await waitText(i, "ctrl+x cancel", "summary footer");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("ctrl+x cancel"); // #426 first-question summary footer
    i.stdin.write("\x18"); // ctrl+x — explicit cancel
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
    await waitText(i, "Which database should I use?", "the model's ask_user reached the block");
    expect(gate.current?.questions[0]?.question).toBe("Which database should I use?");
    expect(seen).toEqual([]); // turn suspended on the block

    gate.resolve({ answers: [{ labels: ["Redis"] }] });
    await waitStep(i, () => seen.length > 0, "the model received the answer");
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
    await waitStep({ lastFrame: () => "" }, () => gate.current !== null, "the ask_user call reached the gate");
    gate.resolve({ answers: [{ labels: ["Postgres"] }] });
    await waitStep({ lastFrame: () => "" }, () => seen.length > 0, "the model received the answer");

    const events = store.load();
    const toolCall = events.find((e) => e.type === "tool_call" && e.name === "ask_user");
    if (toolCall?.type !== "tool_call") throw new Error("no ask_user tool_call in the event log");
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === toolCall.callId);
    if (toolResult?.type !== "tool_result") throw new Error("no tool_result for the ask_user call");
    const call = { args: toolCall.args, ok: toolResult.ok, output: toolResult.output };
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
    if (gate.current) await waitText(i, gate.current.questions[0]!.question, "block rendered");
    else await effectsFlushed();
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
    await pressCommitted(i, "\x1b[B", "key 26");
    await waitText(i, "┌", "preview box absent", { absent: true });
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

  test("askUserBlockRows reserves the tallest preview box's height (#426 layout A)", () => {
    const plain = askUserBlockRows(QUESTION.questions, 100);
    // The tallest preview (32 lines) clamps to the 20-row cap; its screen
    // is taller than the stacked plain screen (preview box + borders, no
    // descriptions in side-by-side) — the reservation tracks the formula.
    const preview = askUserBlockRows(PREVIEW_SET.questions, 100);
    expect(preview).toBeGreaterThan(plain);
    // A one-line preview still fits in a shorter screen than the capped one.
    const oneLine = askUserBlockRows([
      { ...QUESTION.questions[0]!, options: [{ preview: undefined }, { preview: undefined }, { preview: "one line" }] },
    ], 100);
    expect(oneLine).toBeLessThan(preview);
  });

  test("code fences inside a preview highlight via the shared renderer", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask({
      questions: [{
        question: "Which snippet?",
        header: "Snippet",
        options: [
          { label: "sync", description: "await in sequence", preview: "```ts\nconst out = await run(a, b);\n```" },
          { label: "parallel", description: "Promise.all" },
        ],
        suggested: "sync",
      }],
    });
    const i = await mountAt(gate, 100);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await waitForFrame(frame, "const out = await run(a, b);");
    expect(frame()).toContain("┌");
    gate.resolve({ answers: [{ labels: ["sync"] }] });
    await pending;
    i.unmount();
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
    await waitText(i, "Which reply style?", "the ask_user call reached the block");
    gate.resolve({ answers: [{ labels: ["verbose"] }] });
    await waitStep(i, () => seen.length > 0, "the model received the answer");
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
  await waitForFrame(frame, set.questions[0]!.question, { timeoutMs: 4000 });
  await effectsFlushed(); // ink installs the block's useInput handler in a passive effect
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
    // #426 layout A panel adds border+divider+chip rows to every screen;
    // assert the ordering properties instead of pinning magic totals.
    const small = askUserBlockRows([{ question: "q", options: [{}, {}] }], 100);
    const manyQ = askUserBlockRows([
      { question: "a", options: [{}] },
      { question: "b", options: [{}] },
      { question: "c", options: [{}] },
      { question: "d", options: [{}] },
    ], 100);
    const bigOptions = askUserBlockRows([
      { question: "a", options: [{}, {}] },
      { question: "b", options: [{}, {}, {}, {}] },
    ], 100);
    expect(small).toBeGreaterThan(0);
    // The summary floor grows with the question count; a big option list
    // dominates the set.
    expect(bigOptions).toBeGreaterThan(small);
    expect(bigOptions).toBeGreaterThan(manyQ);
  });

  test("while the set is open: block grows with content, frameless, and the volatile transcript compresses", async () => {
    const gate = new AskUserGate();
    // Short terminal: the block's height must eat into the transcript budget.
    const { ink } = await mountChat(gate, BIG_SET, { columns: 100, rows: 16 });
    const open = stripAnsi(ink.lastFrame() ?? "");
    // #426 layout A: the block is a bordered panel (a Dialog modal it is
    // not — it renders inline under the composer, inside the chat frame).
    expect(open).toContain("╭");
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
    expect(open).toContain(COMPOSER_READY);
    ink.unmount();
    gate.resolve({ answers: [{ labels: ["SQLite"] }] });
  });

  test("on resolution: compact Static projection — one row per question with answers, unchosen options omitted", async () => {
    const gate = new AskUserGate();
    const { ink } = await mountChat(gate, BIG_SET, { columns: 100, rows: 40 });
    // Answer both questions: Q1 down to canary, advance; Q2 down to Postgres, advance; submit.
    await pressCommitted(ink, "\x1b[B", "key 27"); // canary
    await pressCommitted(ink, "\r", "key 28");
    await pressCommitted(ink, "\x1b[B", "key 29"); // Postgres
    await pressCommitted(ink, "\r", "key 30");
    ink.stdin.write("\r"); // submit from summary
    await waitText(ink, "↳ you: Postgres", "settled projection");
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

describe("ask_user options window (#874)", () => {
  const MANY = {
    questions: [{
      question: "Pick a route among many?",
      header: "Route",
      options: Array.from({ length: 30 }, (_, i) => ({ label: `route-${i}`, description: `route number ${i}` })),
    }],
  } satisfies AskUserQuestionSet;

  test("optionWindow: count-capped window follows the focus, reports hidden rows", async () => {
    const { optionWindow } = await import("../src/AskUserBlock");
    expect(optionWindow(3, 0)).toEqual({ start: 0, count: 3, above: 0, below: 0 });
    expect(optionWindow(30, 0)).toEqual({ start: 0, count: 12, above: 0, below: 18 });
    expect(optionWindow(30, 20)).toEqual({ start: 9, count: 12, above: 9, below: 9 });
    expect(optionWindow(30, 29)).toEqual({ start: 18, count: 12, above: 18, below: 0 });
  });

  test("a 30-option question renders at most 12 option rows with more-markers", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(MANY);
    const i = await mount(gate);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    expect(frame()).toContain("route-0");
    expect(frame()).toContain("↓ 18 more");
    expect(frame()).not.toContain("route-12");
    // Arrow far down: the window scrolls, the focus stays visible.
    for (let n = 0; n < 20; n++) i.stdin.write("\x1b[B");
    await waitText(i, "route-20", "window scrolled to the focus");
    expect(frame()).toContain("route-20");
    expect(frame()).toContain("↑ ");
    expect(frame()).not.toContain("route-8\n");
    gate.resolve({ answers: [{ labels: ["route-20"] }] });
    await pending;
    i.unmount();
  });

  test("long option descriptions truncate at the height cap", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask({
      questions: [{
        question: "Which route?",
        header: "Route",
        options: [{ label: "verbose", description: Array.from({ length: 20 }, (_, i) => `description row ${i}`).join(" ") }],
      }],
    });
    const i = await mount(gate);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("description truncated");
    expect(frame).not.toContain("description row 19");
    gate.resolve({ answers: [{ labels: ["verbose"] }] });
    await pending;
    i.unmount();
  });

  test("askUserBlockRows no longer scales with the option count past the window", () => {
    const few = askUserBlockRows([{ question: "q", options: [{}, {}, {}] }], 100);
    const many = askUserBlockRows(MANY.questions.map((q) => ({ question: q.question, options: q.options.map(() => ({ preview: undefined })) })), 100);
    // The reservation tracks the windowed screen (12 options × ~2 rows
    // with interleave + markers), not the raw option count: 30 options
    // reserve like ~12–13, not 30.
    expect(many).toBeLessThan(40);
    expect(many).toBeGreaterThan(few);
  });

  test("the reservation never understates a real frame (#874)", async () => {
    // The whole point of the budget: Chat subtracts it from the volatile
    // transcript so the region stays under the terminal height. A
    // reservation below the rendered block re-opens the fullscreen path.
    const shapes: Array<{ name: string; set: AskUserQuestionSet; width: number }> = [
      { name: "few options", set: QUESTION, width: 100 },
      { name: "long descriptions", set: {
        questions: [{ question: "Which route?", header: "Route", options: [
          { label: "a", description: Array.from({ length: 20 }, (_, i) => `description row ${i}`).join(" ") },
          { label: "b", description: "short" },
        ] }],
      } as AskUserQuestionSet, width: 100 },
      { name: "many options", set: MANY, width: 100 },
      { name: "many options, narrow", set: MANY, width: 64 },
      { name: "long question", set: {
        questions: [{ question: Array.from({ length: 12 }, (_, i) => `clause ${i}`).join(" "), header: "Long", options: [{ label: "a", description: "x" }, { label: "b", description: "y" }] }],
      } as AskUserQuestionSet, width: 100 },
      { name: "preview", set: PREVIEW_SET, width: 100 },
      { name: "many questions", set: {
        questions: Array.from({ length: 14 }, (_, i) => ({ question: `question ${i}?`, header: `Q${i}`, options: [{ label: "a", description: "x" }] })),
      } as AskUserQuestionSet, width: 100 },
    ];
    for (const shape of shapes) {
      const gate = new AskUserGate();
      const pending = gate.ask(shape.set);
      const i = render(<AskUserBlock gate={gate} width={shape.width} />);
      await waitStep(i, () => stripAnsi(i.lastFrame() ?? "").trim().length > 0, `${shape.name} rendered`);
      // Walk every option (and Other): the tallest screen must still fit.
      let worst = stripAnsi(i.lastFrame() ?? "").split("\n").length;
      for (let n = 0; n < shape.set.questions[0]!.options.length; n++) {
        await pressCommitted(i, "\x1b[B", "key 33");
        worst = Math.max(worst, stripAnsi(i.lastFrame() ?? "").split("\n").length);
      }
      const reserved = askUserBlockRows(shape.set.questions, shape.width);
      expect(`${shape.name}: reserved ${reserved} >= rendered ${worst}`).toBe(`${shape.name}: reserved ${reserved} >= rendered ${worst}`);
      expect(reserved).toBeGreaterThanOrEqual(worst);
      gate.resolve({ answers: [] });
      await pending;
      i.unmount();
    }
  });

  test("a row budget shrinks the block instead of overflowing it (#874)", async () => {
    // Budgets at or above the block's floor are honoured exactly; below it
    // the question must stay answerable and the block wins (Chat never asks
    // for less than askBlockMinRows).
    for (const maxRows of [20, 30, 60]) {
      const gate = new AskUserGate();
      const pending = gate.ask(MANY);
      const i = render(<AskUserBlock gate={gate} width={100} maxRows={maxRows} />);
      await waitText(i, "route-0", `maxRows ${maxRows} rendered`);
      const frame = stripAnsi(i.lastFrame() ?? "");
      expect(frame.split("\n").length).toBeLessThanOrEqual(maxRows);
      expect(frame).toContain("route-0");
      gate.resolve({ answers: [] });
      await pending;
      i.unmount();
    }
  });

  test("askBlockMinRows is the floor Chat must never budget below (#874)", () => {
    const min = askBlockMinRows(MANY.questions, 100);
    expect(askUserBlockRows(MANY.questions, 100, min)).toBe(min);
    // An impossible budget can only reach the floor, never under it.
    expect(askUserBlockRows(MANY.questions, 100, 1)).toBeGreaterThanOrEqual(min);
  });
});

describe("ask_user question is never cut (#1512)", () => {
  /** A question that wraps to several rows, its last word a sentinel. */
  const longQuestion = (words: number) => Array.from({ length: words }, (_, i) => `w${i}`).join(" ") + " FINAL-WORD?";
  const LAYOUTS = [
    { name: "layout A", width: 100, preview: false },
    { name: "layout A side-by-side", width: 100, preview: true },
    { name: "layout C", width: 64, preview: false },
  ] as const;
  const setFor = (words: number, count: number, preview: boolean): AskUserQuestionSet => ({
    questions: [{
      question: longQuestion(words),
      header: "Long",
      options: Array.from({ length: count }, (_, i) => ({
        label: `opt-${i}`,
        description: `option ${i} explained at some length so that it wraps past one row and needs the truncation row`,
        ...(preview ? { preview: `preview ${i}` } : {}),
      })),
    }],
  });

  for (const layout of LAYOUTS) {
    test(`${layout.name}: a tight budget is taken from descriptions and options, the whole question shows`, async () => {
      const maxRows = 18;
      const set = setFor(90, 12, layout.preview);
      // The budget is tight: the natural block does not fit it.
      expect(askUserBlockRows(set.questions, layout.width)).toBeGreaterThan(maxRows);
      const gate = new AskUserGate();
      const pending = gate.ask(set);
      const i = render(<AskUserBlock gate={gate} width={layout.width} maxRows={maxRows} />);
      await waitText(i, "opt-0", `${layout.name} rendered`);
      const frame = () => stripAnsi(i.lastFrame() ?? "");
      expect(frame().split("\n").length).toBeLessThanOrEqual(maxRows);
      expect(frame()).toContain("w0 ");
      expect(frame()).toContain("FINAL-WORD?");
      // Not scrolled and never marked as cut: the options gave the rows.
      expect(frame()).not.toContain("pgup/pgdn");
      expect(frame()).not.toContain("question truncated");
      expect(frame()).toContain("↓ ");
      expect(frame()).not.toContain("opt-11");
      // Walking the options keeps the whole question on screen.
      for (let n = 0; n < 5; n++) await pressCommitted(i, "\x1b[B", `${layout.name} down ${n}`);
      await waitText(i, "opt-5", `${layout.name} window follows the focus`);
      expect(frame()).toContain("FINAL-WORD?");
      expect(frame().split("\n").length).toBeLessThanOrEqual(maxRows);
      gate.resolve({ answers: [] });
      await pending;
      i.unmount();
    });
  }

  for (const layout of LAYOUTS.filter((l) => !l.preview)) {
    test(`${layout.name}: a question taller than the viewport scrolls — every word reachable, options answerable`, async () => {
      const maxRows = 18;
      const words = 400;
      const set = setFor(words, 6, false);
      const gate = new AskUserGate();
      const pending = gate.ask(set);
      const i = render(<AskUserBlock gate={gate} width={layout.width} maxRows={maxRows} />);
      await waitText(i, "pgup/pgdn", `${layout.name} rendered scrolling`);
      const frame = () => stripAnsi(i.lastFrame() ?? "");
      const position = () => {
        const m = /lines (\d+)–(\d+)\/(\d+)/.exec(frame());
        if (!m) throw new Error(`no question position row in:\n${frame()}`);
        return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
      };
      // The question alone is taller than the whole block budget.
      expect(position().total).toBeGreaterThan(maxRows);
      expect(position().start).toBe(1);
      expect(frame()).not.toContain("question truncated");
      const seen = new Set<string>();
      const collect = () => { for (const token of frame().split(/\s+/)) seen.add(token); };
      collect();
      while (position().end < position().total) {
        const before = position().start;
        i.stdin.write("\x1b[6~"); // pgdn
        await waitStep(i, () => position().start > before, `${layout.name} pgdn past line ${before}`);
        expect(frame().split("\n").length).toBeLessThanOrEqual(maxRows);
        expect(frame()).toContain("opt-0");
        collect();
      }
      for (let n = 0; n < words; n++) expect(seen.has(`w${n}`)).toBe(true);
      expect(seen.has("FINAL-WORD?")).toBe(true);
      // pgup walks back to the first line.
      while (position().start > 1) {
        const before = position().start;
        i.stdin.write("\x1b[5~"); // pgup
        await waitStep(i, () => position().start < before, `${layout.name} pgup before line ${before}`);
      }
      expect(frame()).toContain("w0 ");
      // The options stay answerable while the question scrolls.
      await pressCommitted(i, "\x1b[B", `${layout.name} focus opt-1`);
      await pressCommitted(i, "\r", `${layout.name} choose opt-1`);
      await waitText(i, "Review your answers", `${layout.name} summary`);
      i.stdin.write("\r");
      expect(await pending).toEqual({ answers: [{ labels: ["opt-1"] }] });
      i.unmount();
    });
  }

  test("the row model reserves the full question height (no budget)", () => {
    for (const width of [100, 64]) {
      const short = askUserBlockRows(setFor(5, 2, false).questions, width);
      const long = askUserBlockRows(setFor(400, 2, false).questions, width);
      // 400 words wrap to dozens of rows; without a budget all of them count.
      expect(long - short).toBeGreaterThan(15);
    }
  });

  test("askBlockMinRows: a long question floors at one scrolling line plus its position row", () => {
    const set = setFor(400, 6, false);
    const min = askBlockMinRows(set.questions, 100);
    expect(askUserBlockRows(set.questions, 100, min)).toBe(min);
    expect(askUserBlockRows(set.questions, 100, 1)).toBeGreaterThanOrEqual(min);
  });
});
