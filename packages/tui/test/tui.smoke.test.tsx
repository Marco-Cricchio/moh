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
import { stripAnsi, unwrap } from "./helpers";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-tui-smoke-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("chat smoke (mock provider)", () => {
  test("streams coalesced markdown into the moh box and settles", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["I keep a **diary** of it.\n\n", "- saved automatically\n", "- private"], finish: "stop" },
    ]);
    const { session } = unwrap(makeSession({ cwd: process.cwd(), home: tempHome(), provider }));
    const i = render(<Chat session={session} cwd={mkdtempSync(join(tmpdir(), "moh-gitless-"))} mode="vibe" modelLabel="mock" />);
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
    const { session } = unwrap(makeSession({ cwd: process.cwd(), home: tempHome(), provider }));
    const i = render(<Chat session={session} cwd={mkdtempSync(join(tmpdir(), "moh-gitless-"))} mode="dev" modelLabel="mock" />);
    await sleep(30);
    i.stdin.write("go");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(150); // mid-stream
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("esc stop");
    i.stdin.write("\x1b"); // arm
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("esc again to stop");
    i.stdin.write("\x1b"); // stop
    await sleep(30);
    await sleep(300);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("cancelled");
    expect(session.pending()).toBe(false);
    i.unmount();
  });

  test("esc x1 arms steering; a new send preempts the stream", async () => {
    const provider = MockProvider.scripted([
      { deltas: Array.from({ length: 10 }, () => "x "), finish: "stop", deltaDelayMs: 40 },
      { deltas: ["second answer"], finish: "stop" },
    ]);
    const { session } = unwrap(makeSession({ cwd: process.cwd(), home: tempHome(), provider }));
    const i = render(<Chat session={session} cwd={mkdtempSync(join(tmpdir(), "moh-gitless-"))} mode="vibe" modelLabel="mock" />);
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

  test("status row always shows model and current mode", async () => {
    const provider = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const { session } = unwrap(makeSession({ cwd: process.cwd(), home: tempHome(), provider }));
    const i = render(<Chat session={session} cwd={mkdtempSync(join(tmpdir(), "moh-gitless-"))} mode="dev" modelLabel="mock" />);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("◆ mock");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("◉ dev");
    i.rerender(<Chat session={session} cwd={mkdtempSync(join(tmpdir(), "moh-gitless-"))} mode="vibe" modelLabel="mock" />);
    await sleep(30); // the mode repaint fires in an effect
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("◆ mock");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("○ vibe");
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
    const i = render(<App cwd={cwd} home={home} provider={provider} env={{}} />);
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

  test("App: ctrl+o switches vibe ↔ dev in session (regression: ctrl+m is \\r, indistinguishable from Enter)", async () => {
    const provider = MockProvider.demo();
    const i = render(<App cwd={process.cwd()} home={tempHome()} provider={provider} startInChat skipOnboarding />);
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("○ vibe");
    i.stdin.write("\x0f");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("◉ dev");
    i.stdin.write("\x0f");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("○ vibe");
    i.unmount();
  });

  test("App: mode switch changes the transcript grammar, not just the label (#193)", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["first answer"], finish: "stop", usage: { inputTokens: 100, outputTokens: 10 } },
      { deltas: ["second answer"], finish: "stop", usage: { inputTokens: 200, outputTokens: 40 } },
      { deltas: ["third answer"], finish: "stop", usage: { inputTokens: 300, outputTokens: 50 } },
    ]);
    const i = render(<App cwd={process.cwd()} home={tempHome()} provider={provider} startInChat skipOnboarding />);
    await sleep(30);
    i.stdin.write("one");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(300);
    // vibe: plain transcript, no usage metrics
    let frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("first answer");
    expect(frame).not.toContain("100 in");
    // dev: settled turns close with one model line, no usage line (#213)
    i.stdin.write("\x0f");
    await sleep(50);
    i.stdin.write("two");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(300);
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("second answer");
    expect(frame).toContain("─ model mock");
    expect(frame).not.toContain("200 in");
    // back to vibe: the dev-printed block stays (native scrollback), but
    // the new turn settles without one
    i.stdin.write("\x0f");
    await sleep(50);
    i.stdin.write("three");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(300);
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("third answer");
    expect(frame).toContain("─ model mock"); // printed dev form persists
    expect(frame).not.toContain("300 in"); // vibe suppressed the new turn's
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
import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";

describe("visible assembly error (#100, ADR-0005)", () => {
  test("a broken provider reference surfaces as an error toast, not a silent demo session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-tui-broken-"));
    const home = mkdtempSync(join(tmpdir(), "moh-tui-broken-h-"));
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "no-such-endpoint/model" }));
    const i = render(<App cwd={cwd} home={home} startInChat skipOnboarding />);
    await sleep(120);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("session error (provider)");
    expect(frame).toContain("unknown provider");
    // The user is pointed at the fix instead of landing in a swapped demo chat.
    expect(frame).toContain("onboarding");
    i.unmount();
  });
});
