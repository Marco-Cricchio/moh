import "./faketty/ci-mask";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, SessionStore, builtinTools, createSession } from "@moh/core";
import { Chat } from "../src/Chat";
import { renderOnFakeTty } from "./faketty/render";
import { COMPOSER_READY, pressSettled, sendPrompt, waitStep, waitText } from "./helpers";

function bangHarness(turns: Parameters<typeof MockProvider.scripted>[0], onNotify?: (text: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "moh-bang-"));
  const home = mkdtempSync(join(tmpdir(), "moh-bang-h-"));
  const store = SessionStore.create(cwd, home);
  const session = createSession({
    cwd,
    provider: MockProvider.scripted(turns),
    tools: builtinTools(),
    permissions: { unrestrictedTools: true },
    sink: (event) => store.append(event),
  });
  const term = renderOnFakeTty(
    <Chat session={session} cwd={cwd} mode="dev" modelLabel="mock" width={100} onNotify={onNotify} />,
    { cols: 100, rows: 40 },
  );
  // Input waits read the current surface, not a placeholder left in scrollback.
  const view = { lastFrame: () => term.screen.lines().join("\n"), stdin: term.stdin };
  return {
    session, view,
    history: () => [...term.screen.scrollback(), ...term.screen.lines()].join("\n"),
    async dispose() {
      try { await term.unmount(); }
      finally {
        try { await session.dispose(); }
        finally {
          rmSync(cwd, { recursive: true, force: true });
          rmSync(home, { recursive: true, force: true });
        }
      }
    },
  };
}

describe("composer bang commands (ADR-0076)", () => {
  // Named state waits are bounded at 3s each. The test budget covers input,
  // process completion, painted output and asynchronous cleanup together.
  test("!cmd runs through the bash tool and shows in the transcript", async () => {
    const harness = bangHarness([{ deltas: ["ok"], finish: "stop" }]);
    const { session, view } = harness;
    try {
      await sendPrompt(view, "!echo bang-marker-42");
      await waitStep(view, () => session.history().some((event) => event.type === "tool_result"), "bash result recorded");
      await waitStep(view, () => harness.history().split("\n").some((row) => row.trim() === "bang-marker-42"), "bash output painted");
      const result = session.history().find((event) => event.type === "tool_result");
      expect(result).toMatchObject({ ok: true, output: "bang-marker-42" });
      expect(session.history().some((event) => event.type === "user_message")).toBe(false);
    } finally { await harness.dispose(); }
  }, 15000);

  test("!!cmd auto-sends the output to the model", async () => {
    const harness = bangHarness([{ deltas: ["ack"], finish: "stop" }]);
    const { session, view } = harness;
    try {
      await sendPrompt(view, "!!echo autosend-marker-7");
      await waitStep(view, () => session.history().some((event) => event.type === "done"), "auto-send model turn completes");
      const events = session.history();
      const resultAt = events.findIndex((event) => event.type === "tool_result");
      const sendAt = events.findIndex((event) => event.type === "user_message");
      expect(resultAt).toBeGreaterThan(-1);
      expect(sendAt).toBeGreaterThan(resultAt);
      expect(events[sendAt]).toMatchObject({ text: "! output:\nautosend-marker-7" });
      await waitStep(view, () => harness.history().split("\n").some((row) => row.trim() === "ack"), "model acknowledgement painted");
    } finally { await harness.dispose(); }
  }, 15000);

  test("an active turn refuses the bang visibly", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const notices: string[] = [];
    const harness = bangHarness([
      { deltas: ["half", "after release"], finish: "stop", hold: { afterDeltas: 1, release: gate } },
    ], (text) => notices.push(text));
    const { session, view } = harness;
    try {
      await waitText(view, COMPOSER_READY, "composer mounted");
      const running = session.send("long turn");
      await waitText(view, "half", "held model turn painted");
      await pressSettled(view, "!echo nope");
      await waitText(view, "!echo nope", "bang draft committed during active turn");
      await pressSettled(view, "\r");
      await waitStep(view, () => notices.some((text) => text.includes("esc to interrupt")), "active-turn refusal delivered");
      expect(session.pending()).toBe(true);
      expect(session.history().some((event) => event.type === "tool_call")).toBe(false);
      release();
      expect((await running).status).toBe("done");
    } finally { release(); await harness.dispose(); }
  }, 15000);

  test("\\! escapes to a literal prompt send", async () => {
    const harness = bangHarness([{ deltas: ["done"], finish: "stop" }]);
    const { session, view } = harness;
    try {
      await sendPrompt(view, "\\!literal");
      await waitStep(view, () => session.history().some((event) => event.type === "done"), "literal prompt completes");
      expect(session.history().find((event) => event.type === "user_message")).toMatchObject({ text: "!literal" });
      expect(session.history().some((event) => event.type === "tool_call")).toBe(false);
    } finally { await harness.dispose(); }
  }, 15000);
});
