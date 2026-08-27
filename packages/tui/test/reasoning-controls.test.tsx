import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, MockProvider, type Provider } from "@moh/core";
import { App, REASONING_PERSISTENCE_NOTICE } from "../src/App";
import { Chat, settledBoundary } from "../src/Chat";
import { visibleChips } from "../src/BottomBar";
import { loadUserConfig } from "../src/user-config";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function drain(session: { events: AsyncIterable<unknown> }) {
  void (async () => {
    for await (const _ of session.events) void _;
  })();
}

describe("reasoning display and controls (#242)", () => {
  test("enabling display immediately repaints settled historical reasoning", async () => {
    const session = createSession({
      provider: MockProvider.scripted([{ reasoning: { deltas: ["persisted historical reasoning"] }, deltas: ["answer"], finish: "stop" }]),
      memory: { enabled: false },
    });
    // Chat owns one event subscriber; this extra drain is harmless and
    // mirrors App's independent chrome subscriber.
    drain(session);
    const ui = render(
      <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="mock" width={80} showReasoning={false} />,
    );
    await session.send("question");
    await sleep(30);
    expect(stripAnsi(ui.lastFrame() ?? "")).not.toContain("persisted historical reasoning");

    ui.rerender(
      <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="mock" width={80} showReasoning />,
    );
    await sleep(30);
    const shown = stripAnsi(ui.lastFrame() ?? "");
    expect(shown).toContain("thinking");
    expect(shown).toContain("persisted historical reasoning");

    // The toggle changes only projection; the persisted history remains.
    // (ink-testing-library accumulates Static output and cannot emulate the
    // real terminal's clear-screen escape used when hiding again.)
    expect(session.history().some((event) => event.type === "reasoning" && event.text === "persisted historical reasoning")).toBe(true);
    ui.unmount();
  });

  test("completed reasoning remains model-labelled while the turn continues live", () => {
    const events = [
      { type: "user_message", text: "work" },
      { type: "reasoning", text: "live completed call reasoning" },
      { type: "model_call", model: "ep/model", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "tool_call", callId: "pending", name: "bash", args: { command: "sleep 1" } },
    ] as const;
    // The reasoning stays volatile until its label arrives and the next
    // event proves the call did not fail; it is never sealed as "model".
    expect(settledBoundary(events.slice(0, 2), true)).toBe(1);
    expect(settledBoundary(events.slice(0, 3), true)).toBe(1);
    // Once the unresolved tool starts, the immutable reasoning+call prefix
    // promotes together while the overall turn remains live.
    expect(settledBoundary(events, true)).toBe(3);
  });

  test("normal/wide bottom-bar focus exposes the thinking level chip", () => {
    expect(visibleChips(140).chips.map((chip) => chip.label)).toContain("thinking");
    expect(visibleChips(200).chips.map((chip) => chip.label)).toContain("thinking");
  });

  test("unknown custom providers get conservative pre-call consent", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-custom-notice-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "moh-custom-notice-cwd-"));
    const provider: Provider = {
      name: "custom-provider",
      async *stream() { yield { type: "finish" as const, reason: "stop" as const }; },
    };
    const ui = render(<App cwd={cwd} home={home} provider={provider} startInChat skipOnboarding />);
    await sleep(50);
    expect(stripAnsi(ui.lastFrame() ?? "")).toContain("provider-exposed reasoni");
    expect(loadUserConfig(join(home, ".moh", "config")).reasoningNoticeShown).toBe(true);
    ui.unmount();
  });

  test("one-shot persistence notice appears before a compatible model call", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-reason-notice-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "moh-reason-notice-cwd-"));
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({
      endpoints: [{ name: "ep", type: "anthropic", defaultModel: "claude-fable-5" }],
    }));
    let calls = 0;
    const provider: Provider = {
      name: "ep/claude-fable-5",
      async *stream(_messages, _signal) {
        calls++;
        yield { type: "model_call_start", model: "ep/claude-fable-5" };
        yield { type: "text_delta", text: "ok" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const ui = render(<App cwd={cwd} home={home} provider={provider} startInChat skipOnboarding />);
    await sleep(50);
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("provider-exposed reasoni"); // width-capped status projection
    expect(REASONING_PERSISTENCE_NOTICE).toContain("saved in the session log");
    expect(REASONING_PERSISTENCE_NOTICE).toContain("resume and fork");
    expect(REASONING_PERSISTENCE_NOTICE).toContain("exports and backups");
    expect(calls).toBe(0); // notice precedes the first compatible call
    expect(loadUserConfig(join(home, ".moh", "config")).reasoningNoticeShown).toBe(true);
    ui.unmount();
  });
});
