import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { stripAnsi, waitForCondition, waitForFrame } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = () => join(tmpdir(), `moh-tui-tree-app-${process.pid}-${Date.now()}`);

/**
 * #581: the /tree panel inside the App — opened from chat with /tree,
 * live switch appends branch_switched through the session seam, `r`
 * closes the panel and raises the sticky branch-from-here banner.
 */
describe("/tree panel in the App (#581)", () => {
  test("/tree opens the panel; enter switches live; r shows the sticky banner; next message splits", async () => {
    const home = join(dir(), "home");
    const cwd = join(dir(), "repo");
    const provider = MockProvider.scripted([
      { deltas: ["first answer"], finish: "stop" },
      { deltas: ["second answer"], finish: "stop" },
      { deltas: ["branch answer"], finish: "stop" },
    ]);
    const i = render(<App cwd={cwd} home={home} provider={provider} env={{}} skipOnboarding startInChat />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // The App assembles its own session: discover the actual log file in
    // the project slug directory rather than assuming `store`'.
    const slugDir = join(home, ".moh", "projects");
    const sessionLogs = () => {
      const project = readdirSync(slugDir)[0];
      return project ? readdirSync(join(slugDir, project)).filter((f) => f.endsWith(".jsonl")).map((f) => join(slugDir, project, f)) : [];
    };
    const logText = () => sessionLogs().map((f) => readFileSync(f, "utf8")).join("\n");
    // The slash completion popup: the first enter accepts the suggestion
    // into the textarea, the second sends it (same flow /fork tests use).
    // The slash completion popup: the first enter accepts the suggestion
    // into the textarea (with a trailing space), the second enter sends
    // it (same flow the /fork test uses).
    const openTree = async () => {
      await i.stdin.write("/tree");
      await sleep(60);
      await i.stdin.write("\r");
      await sleep(60);
      await i.stdin.write("\r");
      await waitForFrame(frame, "Session tree");
    };
    try {
      // Two turns on the main line.
      await i.stdin.write("fix the auth redirect loop");
      await sleep(60);
      await i.stdin.write("\r");
      await waitForCondition(() => frame().includes("first answer"), () => "first turn never finished");
      await i.stdin.write("add integration tests");
      await sleep(60);
      await i.stdin.write("\r");
      await waitForCondition(() => frame().includes("second answer"), () => "second turn never finished");

      // Open the panel.
      await openTree();

      // Move up to the first turn's row and switch here.
      await i.stdin.write("\x1b[A");
      await sleep(60);
      await i.stdin.write("\r");
      await waitForCondition(
        () => logText().includes("branch_switched"),
        () => `branch_switched never appended. Frame:\n${frame()}`,
      );

      // r = branch from here: the panel closes, the sticky banner shows.
      await openTree();
      await i.stdin.write("r");
      await waitForCondition(() => frame().includes("branching from"), () => "sticky branch banner never appeared");

      // The next message starts the new branch (implicit split).
      await i.stdin.write("retry with jwt middleware");
      await sleep(60);
      await i.stdin.write("\r");
      await waitForCondition(() => frame().includes("branch answer"), () => "branch turn never finished");
      // The branch turn's user_message landed in the log.
      expect(logText().includes("retry with jwt middleware")).toBe(true);
      // Banner dismissed by the send.
      await waitForCondition(() => !frame().includes("branching from"), () => "banner never dismissed");
    } finally {
      i.unmount();
    }
  });
});
