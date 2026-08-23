import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chat } from "../src/Chat";
import { makeSession } from "../src/factory";
import { MockProvider } from "@moh/core";
import { stripAnsi, unwrap } from "./helpers";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-tui-scroll-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PGDN = "\x1b[6~";

/** A reply long enough to wrap over several window rows. */
const longReply = Array.from({ length: 30 }, (_, i) => `word-${i}`).join(" ");

describe("chat window scroll (issue #117)", () => {
  test("↑ scrolls older turns into view; ↓/PgDn returns follow-tail", async () => {
    const provider = MockProvider.scripted([{ deltas: [longReply], finish: "stop" }]);
    const { session } = unwrap(makeSession({ cwd: process.cwd(), home: tempHome(), provider }));
    const i = render(<Chat session={session} mode="dev" modelLabel="mock" />);
    await sleep(50);
    for (const msg of ["first-message", "second-message", "third-message"]) {
      i.stdin.write(msg);
      await sleep(20);
      i.stdin.write("\r");
      await sleep(250);
    }
    // bottom-anchored: newest visible, oldest scrolled out
    let frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("third-message");
    expect(frame).not.toContain("first-message");
    // scroll up: the oldest turn re-enters, the newest leaves
    for (let k = 0; k < 14; k++) {
      i.stdin.write(UP);
      await sleep(20);
    }
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("first-message");
    expect(frame).not.toContain("third-message");
    // back to the bottom: follow-tail resumes
    i.stdin.write(PGDN);
    await sleep(30);
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("third-message");
    i.unmount();
  });

  test("streaming while scrolled up never moves the window; the tail resumes on PgDn", async () => {
    const provider = MockProvider.scripted([
      { deltas: [longReply], finish: "stop" },
      { deltas: Array.from({ length: 30 }, (_, k) => `late-${k} `), finish: "stop", deltaDelayMs: 30 },
    ]);
    const { session } = unwrap(makeSession({ cwd: process.cwd(), home: tempHome(), provider }));
    const i = render(<Chat session={session} mode="dev" modelLabel="mock" />);
    await sleep(50);
    for (const msg of ["aa-message", "bb-message"]) {
      i.stdin.write(msg);
      await sleep(20);
      i.stdin.write("\r");
      await sleep(250);
    }
    // scroll away from the tail, then start a slow stream below the view
    for (let k = 0; k < 6; k++) {
      i.stdin.write(UP);
      await sleep(20);
    }
    i.stdin.write("cc-message");
    await sleep(20);
    i.stdin.write("\r");
    const before = stripAnsi(i.lastFrame() ?? "");
    expect(before).toContain("aa-message");
    await sleep(400); // deltas arrive while scrolled up
    const during = stripAnsi(i.lastFrame() ?? "");
    expect(during).toContain("aa-message"); // the window did not move
    expect(during).not.toContain("cc-message"); // the stream stays below it
    i.stdin.write(PGDN);
    await sleep(30);
    i.stdin.write(DOWN); // idempotent at the bottom
    await sleep(1500); // let the slow stream finish
    const after = stripAnsi(i.lastFrame() ?? "");
    expect(after).toContain("cc-message");
    expect(after).toContain("late-29");
    i.unmount();
  });
});
