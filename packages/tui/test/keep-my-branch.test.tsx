import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App";
import { MockProvider, SessionStore, createSession } from "@moh/core";
import { stripAnsi, waitForCondition, waitForFrame } from "./helpers";

const dir = () => join(tmpdir(), `moh-tui-keep-branch-${process.pid}-${Date.now()}`);

/**
 * #581 (spec §6): the growth banner's primary recovery chip is
 * keep-my-branch (ctrl+g): it appends `branch_switched { to: localTip }`
 * — the #400 adoption action — and clears the warning. Fork (/fork)
 * stays the secondary chip.
 */
describe("growth banner keep-my-branch (#581)", () => {
  test("ctrl+g after external growth switches back to the local tip and clears the warning", async () => {
    const home = join(dir(), "home");
    const cwd = join(dir(), "repo");
    mkdirSync(join(home, ".moh"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    // Yesterday's persisted session to resume.
    const store = SessionStore.create(cwd, home);
    const worked = createSession({
      cwd,
      provider: MockProvider.scripted([{ deltas: ["earlier work"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await worked.send("some earlier work");
    await worked.dispose({ timeoutMs: 5_000 });
    const originalFile = store.file!;

    const provider = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const i = render(<App cwd={cwd} home={home} provider={provider} env={{}} skipOnboarding />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "▸");
      await i.stdin.write("\r");
      await waitForCondition(() => frame().includes("earlier work"), () => "session never opened");
      await new Promise((r) => setTimeout(r, 100));

      // External writer appends behind our back; the next turn emits the
      // growth event with both tips.
      appendFileSync(originalFile, JSON.stringify({ type: "user_message", text: "from elsewhere" }) + "\n");
      await i.stdin.write("next turn");
      await new Promise((r) => setTimeout(r, 80));
      await i.stdin.write("\r");
      await waitForCondition(() => frame().includes("⚡"), () => "sticky growth banner never appeared", { timeoutMs: 8_000 });
      await waitForCondition(
        () => readFileSync(originalFile, "utf8").includes("session_file_growth"),
        () => "growth event never landed",
      );
      const growthLine = readFileSync(originalFile, "utf8").split("\n").find((l) => l.includes("session_file_growth"))!;
      const localTip = (JSON.parse(growthLine) as { localTip?: string }).localTip;
      expect(localTip).toBeTruthy();

      // The banner names the primary chip.
      await waitForCondition(() => frame().includes("keep my branch"), () => `keep-my-branch chip missing. Frame:\n${frame()}`);

      // ctrl+g keeps my branch: adoption switch + warning clears.
      await i.stdin.write("\x07");
      await waitForCondition(
        () => readFileSync(originalFile, "utf8").includes("branch_switched"),
        () => "keep-my-branch never appended branch_switched",
      );
      const switchLine = readFileSync(originalFile, "utf8").split("\n").reverse().find((l) => l.includes("branch_switched"))!;
      expect((JSON.parse(switchLine) as { to?: string }).to).toBe(localTip);
      await waitForCondition(() => !frame().includes("⚡"), () => "growth warning never cleared");
    } finally {
      i.unmount();
    }
  });
});
