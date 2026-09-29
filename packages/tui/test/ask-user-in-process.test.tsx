import "./faketty/ci-mask";
import { describe, expect, test } from "bun:test";
import React, { useReducer, useSyncExternalStore } from "react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, SessionStore, builtinTools, type AskUserQuestionSet } from "@moh/core";
import { AskUserBlock } from "../src/AskUserBlock";
import { AskUserGate } from "../src/ask-user-gate";
import { Chat } from "../src/Chat";
import { createSession } from "@moh/core";
import { renderOnFakeTty } from "./faketty/render";

const CLEAR = "\x1b[2J\x1b[3J\x1b[H";
const FAST_REVEAL = { tickMs: 5, charsPerTick: 400, catchupChars: 4000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const QUESTION: AskUserQuestionSet = {
  questions: [{
    question: "Which route should the deployment use?",
    header: "Route",
    options: [
      { label: "local", description: "run locally" },
      { label: "staging", description: "use the staging service" },
      { label: "production", description: "use the production service" },
    ],
  }],
};

const TALL_QUESTION: AskUserQuestionSet = {
  questions: [{
    question: "tall box question — choose a route with enough explanation to exceed a small viewport",
    header: "Route",
    options: Array.from({ length: 4 }, (_, i) => ({
      label: `route-${i}`,
      description: `option ${i} description `.repeat(30),
    })),
  }],
};

function GateHost({ gate, chatProps }: { gate: AskUserGate; chatProps: Record<string, unknown> }) {
  const [, force] = useReducer((value: number) => value + 1, 0);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  React.useEffect(() => gate.subscribe(force), [gate]);
  return <Chat {...(chatProps as any)} blocked={gate.current !== null} askGate={gate} />;
}

function chatSession(turns: Parameters<typeof MockProvider.scripted>[0], gate: AskUserGate, long = false) {
  const cwd = mkdtempSync(join(tmpdir(), "moh-ask-in-process-"));
  const home = mkdtempSync(join(tmpdir(), "moh-ask-in-process-h-"));
  const store = SessionStore.create(cwd, home);
  const session = createSession({
    provider: MockProvider.scripted(turns),
    tools: builtinTools(),
    permissions: { mode: "auto-accept" },
    onAskUser: gate.ask,
    sink: (event) => store.append(event),
  });
  return { cwd, session, long };
}

function history(term: ReturnType<typeof renderOnFakeTty>): string {
  return [...term.screen.scrollback(), ...term.screen.lines()].join("\n");
}

async function waitFor(term: ReturnType<typeof renderOnFakeTty>, needle: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!history(term).includes(needle) && Date.now() < deadline) await sleep(20);
  expect(history(term)).toContain(needle);
}

describe("ask-user in-process interaction gate (T7 / #1060)", () => {
  test("failed validation retry leaves arrows and typing responsive (pty ask-user-invalid-then-valid)", async () => {
    const gate = new AskUserGate();
    const invalid = { questions: [{ question: "invalid", header: "Route", options: [{ label: "only", description: "one" }] }] };
    const { cwd, session } = chatSession([
      { deltas: [""], finish: "tool_calls", toolCalls: [{ name: "ask_user", args: invalid }] },
      { deltas: [""], finish: "tool_calls", toolCalls: [{ name: "ask_user", args: QUESTION }] },
      { deltas: ["done"], finish: "stop" },
    ], gate);
    const term = renderOnFakeTty(<GateHost gate={gate} chatProps={{ session, cwd, mode: "dev", modelLabel: "mock", width: 100, reveal: FAST_REVEAL }} />, { cols: 100, rows: 24 });
    term.write("ask"); await sleep(20); term.write("\r");
    await waitFor(term, "Which route");
    const before = history(term);
    term.write("\x1b[B\x1b[Axy");
    await sleep(80);
    const after = history(term);
    expect(after).not.toBe(before);
    expect(after).toContain("xy");
    expect(gate.current).not.toBeNull();
    gate.resolve({ answers: [{ labels: ["staging"] }] });
    await term.unmount();
  });

  test("arrows move the selection and the process remains alive (pty ask-user-large-turn)", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(QUESTION);
    const cwd = mkdtempSync(join(tmpdir(), "moh-ask-large-turn-"));
    const session = createSession({ provider: MockProvider.scripted([{ deltas: ["idle"], finish: "stop" }]), sink: () => {} });
    const term = renderOnFakeTty(<GateHost gate={gate} chatProps={{ session, cwd, mode: "dev", modelLabel: "mock", width: 120, reveal: FAST_REVEAL }} />, { cols: 120, rows: 40 });
    await waitFor(term, "Which route");
    const first = history(term);
    term.write("\x1b[B"); await sleep(30);
    const second = history(term);
    term.write("\x1b[B"); await sleep(30);
    const third = history(term);
    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
    expect(gate.current).not.toBeNull();
    gate.resolve({ answers: [{ labels: ["production"] }] });
    await pending;
    await term.unmount();
  });

  test("oversized gate stays idle without wipe while keys are pressed (pty #622; wipe overlap carried by T5)", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask(TALL_QUESTION);
    const term = renderOnFakeTty(<GateHost gate={gate} chatProps={{ session: createSession({ provider: MockProvider.scripted([{ deltas: ["idle"], finish: "stop" }]), sink: () => {} }), cwd: mkdtempSync(join(tmpdir(), "moh-ask-idle-")), mode: "dev", modelLabel: "mock", width: 100, reveal: FAST_REVEAL }} />, { cols: 100, rows: 20 });
    await waitFor(term, "tall box question");
    await term.settle();
    const before = term.rawBytes().length;
    term.write("\x1b[B\x1b[B\x1b[A");
    await term.settle();
    const churn = term.rawBytes().toString("utf8").slice(before).split(CLEAR).length - 1;
    expect(churn).toBe(0);
    expect(history(term)).toContain("route-1");
    gate.resolve({ answers: [], cancelled: true });
    await pending;
    await term.unmount();
  });

  test("a tall gate over a long transcript remains answerable (pty #874)", async () => {
    const gate = new AskUserGate();
    const longText = Array.from({ length: 30 }, (_, i) => `transcript paragraph ${i} `.repeat(20)).join("\n\n");
    const { cwd, session } = chatSession([{ deltas: [longText], finish: "stop" }], gate);
    const term = renderOnFakeTty(<GateHost gate={gate} chatProps={{ session, cwd, mode: "dev", modelLabel: "mock", width: 100, reveal: FAST_REVEAL }} />, { cols: 100, rows: 20 });
    void session.send("long transcript");
    await waitFor(term, "transcript paragraph 29");
    const pending = gate.ask(TALL_QUESTION);
    await waitFor(term, "tall box question");
    term.write("\x1b[B\x1b[B\r");
    await sleep(50);
    // At a 20-row long transcript the panel is compacted: the selected
    // option is represented by the review surface rather than the option
    // label remaining in the bounded screen history.
    expect(history(term)).toContain("Review your answers");
    gate.resolve({ answers: [{ labels: ["route-2"] }] });
    await pending;
    await term.unmount();
  });

  test("a large-turn question stays answerable at a chosen geometry (pty ask-user-large-turn)", async () => {
    const gate = new AskUserGate();
    const pending = gate.ask({ questions: [{ ...TALL_QUESTION.questions[0], question: "large turn question — choose one" }] });
    const term = renderOnFakeTty(<GateHost gate={gate} chatProps={{ session: createSession({ provider: MockProvider.scripted([{ deltas: ["large"], finish: "stop" }]), sink: () => {} }), cwd: mkdtempSync(join(tmpdir(), "moh-ask-large-")), mode: "dev", modelLabel: "mock", width: 120, reveal: FAST_REVEAL }} />, { cols: 120, rows: 40 });
    await waitFor(term, "large turn question");
    term.write("\x1b[B\x1b[B\x1b[B"); await sleep(40);
    expect(history(term)).toContain("route-3");
    gate.resolve({ answers: [{ labels: ["route-3"] }] });
    await pending;
    await term.unmount();
  });
});
