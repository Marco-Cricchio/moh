import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App";
import { MockProvider, SessionStore, createSession } from "@moh/core";
import { actUntilFrame, stripAnsi, waitForCondition, waitForFrame } from "./helpers";

const dir = () => `/tmp/moh-tui-continuity-${process.pid}-${Date.now()}`;

/**
 * #402 acceptance, TUI surface: the vision-note-28 story through the App
 * itself. Two distinct project roots sharing one fake home — work in root
 * A, then the App opens at root B (a clone carrying the identity file) and
 * yesterday's session is on the home screen and resumable with enter.
 */
describe("cross-machine continuity, TUI surface (#402)", () => {
  test("the clone's home screen lists yesterday's session and enter resumes it", async () => {
    const home = join(dir(), "home");
    const rootA = join(dir(), "laptop", "repo");
    const rootB = join(dir(), "office-pc", "checkouts", "repo");
    mkdirSync(join(home, ".moh"), { recursive: true });
    mkdirSync(rootA, { recursive: true });

    // Machine A (yesterday): one persisted turn.
    const store = SessionStore.create(rootA, home);
    const worked = createSession({
      cwd: rootA,
      provider: MockProvider.scripted([{ deltas: ["worked on tickets 12 and 15"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await worked.send("continue work on tickets 12 and 15");
    await worked.dispose({ timeoutMs: 5_000 });

    // The machine switch: the clone carries the identity file.
    mkdirSync(join(rootB, ".moh"), { recursive: true });
    copyFileSync(join(rootA, ".moh", "project.json"), join(rootB, ".moh", "project.json"));

    // Machine B (today): the App's home screen, same shared home. The
    // shared home carries skills metadata; skip onboarding like the CLI
    // would on a configured machine.
    const provider = MockProvider.scripted([{ deltas: ["picking up where we left off"], finish: "stop" }]);
    const i = render(<App cwd={rootB} home={home} provider={provider} env={{}} skipOnboarding />);
    const frameText = () => stripAnsi(i.lastFrame() ?? "");
    try {
      // Yesterday's session is listed despite the different checkout path.
      await waitForFrame(frameText, "continue work on tickets 12 and 15");

      // Enter on the session row resumes: history visible in the chat.
      await actUntilFrame(() => i.stdin.write("\r"), frameText, "type…");
      // Resumed history is promoted through Static (written once, then out
      // of the volatile frame): assert on the accumulated frames.
      await waitForCondition(
        () => i.frames.some((f) => stripAnsi(f).includes("tickets 12 and 15")),
        () => "resumed history never appeared in any frame",
      );
    } finally {
      i.unmount();
    }
  });
});
