import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { COMPOSER_READY, pressCommitted, pressSettled, sendPrompt, stripAnsi, waitForCondition, waitForFrame, waitText } from "./helpers";

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
    const i = render(<App intro={false} cwd={cwd} home={home} provider={provider} env={{}} skipOnboarding startInChat />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // #939: the identity gate mounts the tree (and its stdin) a beat after
    // render(), so the first keystroke has to wait for the settled chat.
    await waitForFrame(frame, COMPOSER_READY);
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
      // The live switch leaves the panel open: reopening is then a no-op.
      if (frame().includes("Session tree")) return;
      await i.stdin.write("/tree");
      await waitText(i, "/tree", "the /tree command echoed in the composer");
      await pressCommitted(i, "\r", "the completion accepted into the composer");
      await pressSettled(i, "\r");
      await waitForFrame(frame, "Session tree");
    };
    try {
      // Two turns on the main line.
      await sendPrompt(i, "fix the auth redirect loop");
      await waitForCondition(() => frame().includes("first answer"), () => "first turn never finished");
      await sendPrompt(i, "add integration tests");
      await waitForCondition(() => frame().includes("second answer"), () => "second turn never finished");

      // Open the panel.
      await openTree();

      // Move up to the first turn's row and switch here.
      await pressCommitted(i, "\x1b[A", "the cursor moved to the first turn");
      await pressSettled(i, "\r");
      await waitForCondition(
        () => logText().includes("branch_switched"),
        () => `branch_switched never appended. Frame:\n${frame()}`,
      );

      // r = branch from here: the panel closes, the sticky banner shows.
      await openTree();
      await pressSettled(i, "r");
      await waitForCondition(() => frame().includes("branching from"), () => "sticky branch banner never appeared");

      // The next message starts the new branch (implicit split).
      await sendPrompt(i, "retry with jwt middleware");
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
