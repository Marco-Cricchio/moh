import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App";
import { MockProvider, SessionStore, createSession } from "@moh/core";
import { projectTranscript } from "../src/transcript";
import { actUntilFrame, stripAnsi, waitForCondition, waitForFrame } from "./helpers";
import type { AgentEvent } from "@moh/core";

const dir = () => `/tmp/moh-tui-ask-replay-${process.pid}-${Date.now()}`;

/**
 * #415 (ADR-0019 decision 4): replay compatibility for legacy
 * single-question ask_user events. Old sessions carry
 * `{question, options, suggested}` args; the log is never rewritten —
 * the translation happens in memory, at projection time, and the legacy
 * call renders through the same compact Static block as a new question
 * set (one question row + one "↳ you:" answer row, #413).
 */

/** A pre-ADR-0019 turn: one ask_user call in the legacy single-question
 * shape, answered with a chosen option. Exactly what a pre-redesign
 * build persisted (schemaVersion 1 — unchanged, so the file loads). */
const legacyHistory: AgentEvent[] = [
  { type: "session_start", schemaVersion: 1, promptVersion: "fixture-prompt" },
  { type: "user_message", text: "ship the release?" },
  {
    type: "tool_call",
    callId: "ask-legacy",
    name: "ask_user",
    args: {
      question: "Ship v2 now or wait for QA?",
      options: [
        { label: "ship now", description: "cut the release immediately" },
        { label: "wait", description: "hold for QA sign-off" },
      ],
      suggested: "wait",
    },
  },
  { type: "tool_result", callId: "ask-legacy", ok: true, output: "ship now" },
  { type: "assistant_delta", text: "shipping v2 now." },
  { type: "model_call", model: "mock", usage: { inputTokens: 10, outputTokens: 5 } },
  { type: "done", models: ["mock"], usage: { inputTokens: 10, outputTokens: 5 } },
];

/** Writes the legacy history as a real session JSONL file and returns
 * its path (SessionStore.create establishes the project-slug directory;
 * the file content is then replaced wholesale with the legacy lines). */
function writeLegacySessionFile(cwd: string, home: string): string {
  const store = SessionStore.create(cwd, home);
  writeFileSync(store.file, legacyHistory.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return store.file;
}

describe("legacy ask_user replay (#415)", () => {
  test("projection translates legacy single-question events in memory to the compact block", () => {
    const blocks = projectTranscript(legacyHistory);
    const ask = blocks.find((b) => b.type === "ask");
    expect(ask).toBeDefined();
    // Same compact shape a new question-set produces (#413): one question
    // row (kind "ask") plus one answer row (kind "answer"); unchosen
    // options and the suggested chip never appear.
    expect(ask!.lines).toEqual(["Ship v2 now or wait for QA?", "↳ you: ship now"]);
    expect(ask!.lineKinds).toEqual(["ask", "answer"]);
    expect(ask!.state).toBe("ok");
    expect(ask!.lines.join("\n")).not.toContain("wait for QA sign-off");
    // An unanswered legacy call (interrupted session): question row only.
    const open = projectTranscript(legacyHistory.filter((e) => !(e.type === "tool_result" || e.type === "assistant_delta" || e.type === "model_call" || e.type === "done")));
    const openAsk = open.find((b) => b.type === "ask");
    expect(openAsk!.lines).toEqual(["Ship v2 now or wait for QA?"]);
    expect(openAsk!.state).toBe("run");
  });

  test("TUI end-to-end: a legacy session file replays through the compact block and is never rewritten", async () => {
    const home = join(dir(), "home");
    const cwd = join(dir(), "repo");
    mkdirSync(join(home, ".moh"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const file = writeLegacySessionFile(cwd, home);
    const bytesBefore = readFileSync(file, "utf8");

    const provider = MockProvider.scripted([{ deltas: ["done!"], finish: "stop" }]);
    const i = render(<App cwd={cwd} home={home} provider={provider} env={{}} skipOnboarding />);
    const frameText = () => stripAnsi(i.lastFrame() ?? "");
    try {
      // The legacy session is listed by its user message; ↓ selects its
      // row (New session is the default), enter resumes it.
      await waitForFrame(frameText, "ship the release?");
      await actUntilFrame(() => i.stdin.write("\x1b[B"), frameText, "› ship the release?");
      await actUntilFrame(() => i.stdin.write("\r"), frameText, "type…");
      // Resumed history is promoted through Static: assert on accumulated
      // frames — the legacy ask_user renders as the compact block
      // (question row + answer row), never the old modal-era shape.
      await waitForCondition(
        () => i.frames.some((f) => {
          const t = stripAnsi(f);
          return t.includes("Ship v2 now or wait for QA?") && t.includes("↳ you: ship now");
        }),
        () => "legacy ask_user compact projection never appeared in any frame",
      );
      // Acceptance 2: no rewrite or migration on disk — the legacy lines
      // survive byte-identical as the file's prefix. (The resumed session
      // may append NEW events after them; that is the append-only log
      // working, not a rewrite.)
      expect(readFileSync(file, "utf8").startsWith(bytesBefore)).toBe(true);
    } finally {
      i.unmount();
    }
  });

  test("core: resuming a legacy ask_user history replays the conversation to the provider intact", async () => {
    const home = join(dir(), "home");
    const cwd = join(dir(), "repo");
    mkdirSync(join(home, ".moh"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const file = writeLegacySessionFile(cwd, home);

    // The provider sees the legacy call/result pair unchanged (args pass
    // through replayMessages verbatim) and the session log stays intact.
    const store = SessionStore.open(file);
    const seen: string[] = [];
    const session = createSession({
      cwd,
      provider: MockProvider.scripted([{ deltas: ["continuing"], finish: "stop" }]),
      resume: { events: store.load() },
      sink: (event) => {
        if (event.type === "user_message") seen.push(event.text);
        store.append(event);
      },
    });
    const result = await session.send("continue");
    expect(result.status).toBe("done");
    expect(seen).toEqual(["continue"]);
    const log = session.history();
    // The seeded legacy events come first, byte-for-byte unmodified.
    expect(log.slice(0, legacyHistory.length)).toEqual(legacyHistory);
    await session.dispose({ timeoutMs: 5_000 });
    // Still append-only: the file is the original lines plus new ones.
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(bytesOf(legacyHistory))).toBe(true);
    expect(after.length).toBeGreaterThan(bytesOf(legacyHistory).length);
  });
});

function bytesOf(events: AgentEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
