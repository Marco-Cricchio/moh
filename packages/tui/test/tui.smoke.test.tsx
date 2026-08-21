import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App";
import { Home } from "../src/Home";
import { Chat } from "../src/Chat";
import { makeSession } from "../src/factory";
import { MockProvider, createSession, SessionStore } from "@moh/core";
import { stripAnsi } from "./helpers";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-tui-smoke-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("chat smoke (mock provider)", () => {
  test("streams coalesced markdown into the moh box and settles", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["I keep a **diary** of it.\n\n", "- saved automatically\n", "- private"], finish: "stop" },
    ]);
    const { session } = makeSession({ cwd: process.cwd(), home: tempHome(), provider });
    const i = render(<Chat session={session} mode="vibe" modelLabel="mock" />);
    await sleep(30);
    i.stdin.write("where do you keep our conversation?");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(300);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("where do you keep our conversation?");
    expect(frame).toContain("diary");
    expect(frame).toContain("saved automatically");
    expect(frame).toContain("private");
    i.unmount();
  });

  test("esc x2 stops a mid-stream turn", async () => {
    const provider = MockProvider.scripted([
      { deltas: Array.from({ length: 20 }, () => "word "), finish: "stop", deltaDelayMs: 40 },
    ]);
    const { session } = makeSession({ cwd: process.cwd(), home: tempHome(), provider });
    const i = render(<Chat session={session} mode="dev" modelLabel="mock" />);
    await sleep(30);
    i.stdin.write("go");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(150); // mid-stream
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("esc to steer");
    i.stdin.write("\x1b"); // arm
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("esc again to stop");
    i.stdin.write("\x1b"); // stop
    await sleep(30);
    await sleep(300);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("stopped");
    expect(session.pending()).toBe(false);
    i.unmount();
  });

  test("esc x1 arms steering; a new send preempts the stream", async () => {
    const provider = MockProvider.scripted([
      { deltas: Array.from({ length: 10 }, () => "x "), finish: "stop", deltaDelayMs: 40 },
      { deltas: ["second answer"], finish: "stop" },
    ]);
    const { session } = makeSession({ cwd: process.cwd(), home: tempHome(), provider });
    const i = render(<Chat session={session} mode="vibe" modelLabel="mock" />);
    await sleep(30);
    i.stdin.write("first");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(120);
    i.stdin.write("\x1b"); // steer armed, input stays usable
    await sleep(30);
    i.stdin.write("wait, do this instead");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(300);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("wait, do this instead");
    expect(frame).toContain("second answer");
    i.unmount();
  });

  test("dev mode shows the status line; vibe mode does not", async () => {
    const provider = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const { session } = makeSession({ cwd: process.cwd(), home: tempHome(), provider });
    const i = render(<Chat session={session} mode="dev" modelLabel="mock" />);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("mock · turn");
    i.rerender(<Chat session={session} mode="vibe" modelLabel="mock" />);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("mock · turn");
    i.unmount();
  });
});

describe("home smoke", () => {
  test("filter-first: typed query filters live, enter opens the new-session row", async () => {
    const cwd = process.cwd();
    const home = tempHome();
    const store = SessionStore.create(cwd, home);
    const persisted = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await persisted.send("fix the login page");

    const i = render(
      <Home
        cwd={cwd}
        home={home}
        mode="vibe"
        onOpen={(resume, initialPrompt) => {
          expect(resume === null || resume.file === store.file).toBe(true);
        }}
        onExit={() => {}}
      />,
    );
    let frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("fix the login page");
    i.stdin.write("zzz");
    await sleep(20);
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("start “zzz”");
    expect(frame).not.toContain("fix the login page");
    i.unmount();
  });

  test("App: enter on the new-session row opens a chat and sends the prompt", async () => {
    const provider = MockProvider.scripted([{ deltas: ["hello there"], finish: "stop" }]);
    const i = render(<App cwd={process.cwd()} home={tempHome()} provider={provider} skipOnboarding />);
    i.stdin.write("greet me");
    await sleep(20);
    await sleep(50);
    i.stdin.write("\r"); // enter on "start "greet me""
    await sleep(300);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("greet me");
    expect(frame).toContain("hello there");
    i.unmount();
  });

  test("App: enter on a session row resumes the persisted session", async () => {
    const cwd = process.cwd();
    const home = tempHome();
    const store = SessionStore.create(cwd, home);
    const persisted = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await persisted.send("fix the login page");

    const provider = MockProvider.scripted([{ deltas: ["done!"], finish: "stop" }]);
    const i = render(<App cwd={cwd} home={home} provider={provider} />);
    await sleep(30);
    i.stdin.write("\r"); // enter on the (only) session row
    await sleep(300);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("fix the login page"); // resumed history visible
    i.stdin.write("and now?");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(300);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("done!");
    i.unmount();
  });

  test("App: ctrl+t switches theme (remount), footer label follows", async () => {
    const provider = MockProvider.demo();
    const i = render(<App cwd={process.cwd()} home={tempHome()} provider={provider} />);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Tokyo Night");
    i.stdin.write("\x14"); // ctrl+t
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Catppuccin Mocha");
    i.unmount();
  });
});
