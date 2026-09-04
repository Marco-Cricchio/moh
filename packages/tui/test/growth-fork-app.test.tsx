import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { App } from "../src/App";
import { MockProvider, SessionStore, createSession } from "@moh/core";
import { actUntilFrame, stripAnsi, waitForCondition, waitForFrame } from "./helpers";

const dir = () => join(tmpdir(), `moh-tui-growth-${process.pid}-${Date.now()}`);

/**
 * #468/ADR-0020 detect-and-fork: after a session_file_growth warning the
 * TUI shows a sticky banner with a fork suggestion (/fork); the fork is
 * always an explicit user action — dispose + full-history fork, original
 * file untouched.
 */
describe("detect-and-fork (#468)", () => {
  test("external growth shows the sticky /fork banner; fork-now activates a forked session", async () => {
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
    const originalFile = store.file;
    const originalBytes = readFileSync(originalFile, "utf8");

    const provider = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const i = render(<App cwd={cwd} home={home} provider={provider} env={{}} skipOnboarding />);
    const frameText = () => stripAnsi(i.lastFrame() ?? "");
    try {
      // The pertinent session (unconsumed) is suggested as the pre-selected
      // banner row; enter opens it.
      await waitForFrame(frameText, "▸");
      await i.stdin.write("\r");
      await waitForCondition(
        () => frameText().includes("earlier work"),
        () => "session never opened",
      );
      await new Promise((r) => setTimeout(r, 100));

      // External writer appends behind our back, then the next turn emits
      // the growth event.
      appendFileSync(originalFile, JSON.stringify({ type: "user_message", text: "from elsewhere" }) + "\n");
      await i.stdin.write("next turn");
      await new Promise((r) => setTimeout(r, 80));
      await i.stdin.write("\r");
      // The growth event crosses the session's event stream → sticky banner.
      await waitForCondition(
        () => frameText().includes("⚡"),
        () => "sticky growth banner never appeared",
        { timeoutMs: 8_000 },
      );

      // Fork now: the explicit action (via the /fork command). The slash
      // completion popup opens on "/f"; the first enter accepts the
      // suggestion into the textarea, the second sends it. The forked
      // session becomes active on a new file.
      await i.stdin.write("/fork");
      await new Promise((r) => setTimeout(r, 80));
      await i.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 80));
      await i.stdin.write("\r");
      const slugDir = join(originalFile, "..");
      await waitForCondition(
        () => readdirSync(slugDir).filter((f) => f.endsWith(".jsonl")).length >= 2,
        () => "fork-now never created the forked session file",
        { timeoutMs: 8_000 },
      );

      // The original file is untouched (append-only, byte-identical prefix).
      expect(readFileSync(originalFile, "utf8").startsWith(originalBytes)).toBe(true);
    } finally {
      i.unmount();
    }
  });
});
