import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, createSession, MockProvider } from "@moh/core";
import { Home } from "../src/Home";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** n sessions titled s1…sn (oldest first, so sN is the newest). */
function homeWithSessions(n: number): { cwd: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "moh-tui-home-list-"));
  const cwd = process.cwd();
  for (let i = 1; i <= n; i++) {
    const store = SessionStore.create(cwd, home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    void session.send(`title s${i}`);
  }
  return { cwd, home };
}

const DOWN = "\x1b[B";

describe("home session list", () => {
  test("the first row is always New session, even with no sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-tui-home-list-"));
    const i = render(<Home cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("New session");
    i.unmount();
  });

  test("caps the list at 5 visible sessions with a more-below hint", async () => {
    const { cwd, home } = homeWithSessions(8);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("New session");
    expect(frame).toContain("s8"); // newest session first under New session
    expect(frame).toContain("s4"); // 5th visible session
    expect(frame).not.toContain("s3"); // 6th is below the fold
    expect(frame).toContain("↓"); // hidden-below hint
    i.unmount();
  });

  test("scrolling follows the cursor to the tail and back up", async () => {
    const { cwd, home } = homeWithSessions(8);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    for (const _ of Array.from({ length: 8 })) {
      i.stdin.write(DOWN);
      await sleep(10);
    }
    const tail = stripAnsi(i.lastFrame() ?? "");
    expect(tail).toContain("s1"); // oldest reached by scrolling
    expect(tail).not.toContain("s8"); // scrolled out of the window
    expect(tail).toContain("↑"); // hidden-above hint
    i.unmount();
  });
});

describe("home session list — configurable cap", () => {
  test("listMax prop raises the visible window", async () => {
    const { cwd, home } = homeWithSessions(8);
    const i = render(
      <Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} listMax={8} />,
    );
    await sleep(60);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("s1"); // every session fits
    expect(frame).not.toContain("↓"); // nothing below the fold
    i.unmount();
  });
});

describe("home chrome (#292)", () => {
  test("no static hint line; the footer carries new/settings/keys", async () => {
    const { lastFrame } = render(<Home cwd={process.cwd()} mode="vibe" onOpen={() => {}} />);
    await sleep(30);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("type to filter or start new");
    expect(frame).not.toContain("n new session");
    expect(frame).toContain("new (n) · settings (s) · keys (?)");
  });

  test("active-query hint appears while filtering", async () => {
    const i = render(<Home cwd={process.cwd()} mode="vibe" onOpen={() => {}} />);
    await sleep(30);
    i.stdin.write("x");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("enter open · esc clear · ↑↓ select");
    i.unmount();
  });
});

describe("home update notice (#273)", () => {
  test("shows the fixed line when a newer stable is cached", async () => {
    const { lastFrame } = render(
      <Home cwd={process.cwd()} mode="vibe" onOpen={() => {}} updateNotice={{ kind: "available", latestVersion: "0.2.0" }} />,
    );
    await sleep(30);
    expect(stripAnsi(lastFrame() ?? "")).toContain("moh 0.2.0 available — run `moh update`");
  });

  test("nonstable build shows the dev notice", async () => {
    const { lastFrame } = render(
      <Home cwd={process.cwd()} mode="vibe" onOpen={() => {}} updateNotice={{ kind: "nonstable", latestVersion: "0.2.0" }} />,
    );
    await sleep(30);
    expect(stripAnsi(lastFrame() ?? "")).toContain("non-stable (dev) version");
  });

  test("no line without a notice", async () => {
    const { lastFrame } = render(<Home cwd={process.cwd()} mode="vibe" onOpen={() => {}} />);
    await sleep(30);
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("moh update");
  });
});
