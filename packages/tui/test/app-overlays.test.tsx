import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionSummaries, loadMohConfig, MockProvider, type Provider } from "@moh/core";
import { App } from "../src/App";
import { COMPOSER_READY, stripAnsi, waitForCondition, waitForFrame } from "./helpers";
import { installAiSdkWarningSink } from "../src/ai-sdk-warnings";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempHome = () => mkdtempSync(join(tmpdir(), "moh-app-ov-"));

/** Push a toast through App's own channel with no keystroke involved (the
 * SDK warning sink), so the intro is still on screen when it lands. */
function emitAiSdkWarning(message: string): void {
  const sink = (globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS as
    | ((options: { warnings: Array<Record<string, unknown>> }) => void)
    | undefined;
  if (typeof sink !== "function") throw new Error("the AI SDK warning sink is not installed");
  sink({ warnings: [{ type: "probe", message }] });
}

describe("home logo intro — chrome stays off the animation", () => {
  test("the footer and toasts are hidden while the intro plays, and return after it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-intro-"));
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await sleep(150);
    // The animation owns the screen: no footer, no bottom toast chrome.
    expect(frame()).not.toContain("ctrl+t theme");
    // A toast pushed without any keystroke — the shape of a startup notice
    // (an available update, a skill sync) landing while the intro plays.
    // The AI SDK warning sink is App's own toast channel, so no key ends
    // the intro before the assertion.
    installAiSdkWarningSink();
    emitAiSdkWarning("intro probe notice");
    await sleep(120);
    expect(frame()).not.toContain("intro probe notice");
    // Ending the intro hands the screen back: the deferred toast is shown,
    // not lost.
    i.stdin.write(" ");
    await waitForCondition(
      () => frame().includes("intro probe notice"),
      () => "the toast deferred behind the intro never re-appeared",
      { timeoutMs: 4000 },
    );
    expect(frame()).toContain("ctrl+t theme");
    i.unmount();
  }, 10000);

  test("the intro plays once per process: a theme remount does not replay it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-intro-once-"));
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await sleep(120);
    i.stdin.write(" "); // end the intro
    await waitForCondition(() => frame().includes("My Own Harness"), () => "intro never settled");
    i.stdin.write("\x14"); // ctrl+t: theme cycle remounts Home
    await sleep(120);
    // Still the settled banner and chrome — no second animation run.
    expect(frame()).toContain("My Own Harness");
    expect(frame()).toContain("ctrl+t theme");
    i.unmount();
  }, 10000);
});

describe("App overlays (issue #33)", () => {
  // #236 Class 1: App must isolate onboarding env-detection from the real
  // process environment — a machine with provider keys in the environment
  // made every "first run" test see the detect list (or its chrome) instead
  // of the wizard, regardless of the injected home dir.
  test("onboarding env-detection uses the injected env, not the real process env (#236)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const home = tempHome();
    const withKey = render(<App intro={false} cwd={cwd} home={home} env={{ ANTHROPIC_API_KEY: "sk-test-236" }} />);
    await sleep(50);
    expect(stripAnsi(withKey.lastFrame() ?? "")).toContain("connect a provider");
    withKey.unmount();
    const fresh = tempHome();
    const clean = render(<App intro={false} cwd={mkdtempSync(join(tmpdir(), "moh-app-cwd-"))} home={fresh} env={{}} />);
    await sleep(50);
    const frame = stripAnsi(clean.lastFrame() ?? "");
    expect(frame).toContain("connect a provider");
    // A fresh environment never offers a detected candidate — wizard phase.
    expect(frame).not.toContain("sk-test-236");
    expect(frame).not.toMatch(/detected/i);
    clean.unmount();
  });

  test("first run with nothing configured opens onboarding; skip lands on home", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const home = tempHome();
    const i = render(<App intro={false} cwd={cwd} home={home} env={{}} />);
    await sleep(50);
    // Either the env-detect list or the wizard — never the home screen.
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("connect a provider");
    i.stdin.write("s"); // skip (works in both phases)
    await sleep(50);
    i.stdin.write("n"); // dismiss the per-project handoff offer
    await sleep(50);
    i.stdin.write("n"); // skip the workflow offer revealed by correct overlay layering
    await sleep(50);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("search or start something new");
    i.unmount();
  });

  test("a dismissed handoff offer reminds once at the first session end", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ handoff: { onboarding: "dismissed" } }));
    const i = render(<App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    i.stdin.write("n"); // new session
    await sleep(50);
    i.unmount();
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).handoff).toEqual({ onboarding: "reminded" });
  });

  test("direct chat skips the handoff offer", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} startInChat />);
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain(COMPOSER_READY);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("session handoff");
    i.unmount();
  });

  test("a configured provider skips onboarding entirely", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("search or start something new");
    i.unmount();
  });

  test("? opens the all-commands panel, esc closes; s opens settings", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    i.stdin.write("?");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("all commands");
    i.stdin.write("\x1b"); // esc closes
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("all commands");
    i.stdin.write("s"); // settings from home
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("settings");
    i.stdin.write("\x1b");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("Default permission mode");
    i.unmount();
  });

  test("ctrl+s and ctrl+k open the panels from home too", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    i.stdin.write("\x13"); // ctrl+s
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("settings");
    i.stdin.write("\x1b");
    // Closing an alternate-buffer modal includes a bounded 40ms flip.
    await sleep(70);
    i.stdin.write("\x0b"); // ctrl+k
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("all commands");
    i.unmount();
  });

  test("a modal layer remains transparent around the dialog", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding />);
    Object.defineProperty(i.stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(i.stdout, "rows", { value: 40, configurable: true });
    i.stdout.emit("resize");
    await sleep(50);
    const before = stripAnsi(i.lastFrame() ?? "");
    expect(before).toContain(COMPOSER_READY);
    expect(before).toContain("· ready");

    i.stdin.write("\x13"); // ctrl+s
    await sleep(50);
    const during = stripAnsi(i.lastFrame() ?? "").split("\n");
    expect(during.some((line) => line.includes("settings"))).toBe(true);
    expect(during.some((line) => line.includes(COMPOSER_READY))).toBe(true);
    expect(during.some((line) => line.includes("· ready"))).toBe(true);
    i.unmount();
  });

  test("in chat, ? on an empty draft opens commands, then closes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    i.stdin.write("n"); // new session → chat
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain(COMPOSER_READY);
    i.stdin.write("?");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("all commands");
    i.stdin.write("\x1b");
    await sleep(50);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("all commands");
    expect(frame).toContain(COMPOSER_READY); // chat still alive under the closed overlay
    i.unmount();
  });
});

describe("in-session rename modal (#534)", () => {
  test("ctrl+r renames the live session and the restarted home shows the exact name", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const home = tempHome();
    const i = render(<App intro={false} cwd={cwd} home={home} provider={MockProvider.demo()} startInChat skipOnboarding />);
    await sleep(50);
    i.stdin.write("\x12"); // ctrl+r
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("rename session");
    i.stdin.write("Release checklist");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(70);
    expect(listSessionSummaries(cwd, home)[0]?.title).toBe("Release checklist");
    i.unmount();

    const reopened = render(<App intro={false} cwd={cwd} home={home} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    expect(stripAnsi(reopened.lastFrame() ?? "")).toContain("Release checklist");
    reopened.unmount();
  });

  test("ctrl+r starts empty for an unrenamed session; empty confirmation resets an existing name", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const home = tempHome();
    const i = render(<App intro={false} cwd={cwd} home={home} provider={MockProvider.demo()} startInChat skipOnboarding />);
    await sleep(50);
    i.stdin.write("\x12");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("name: Name");
    i.stdin.write("Name");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(50);
    i.stdin.write("\x12");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("renamed Name");
    i.stdin.write("\x1b[3~".repeat(4));
    await sleep(30);
    i.stdin.write("\r");
    await sleep(50);
    expect(listSessionSummaries(cwd, home)[0]?.title).toBe("(empty session)");
    i.unmount();
  });

  test("ctrl+r opens while an action chip is focused", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding />);
    await sleep(50);
    i.stdin.write("\t");
    await sleep(30);
    i.stdin.write("\x12");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("rename session");
    i.unmount();
  });

  test("saving while streaming does not interrupt the active turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const home = tempHome();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let aborted = false;
    const provider: Provider = {
      name: "gated-rename-test",
      async *stream(_messages, signal) {
        const onAbort = () => { aborted = true; release(); };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          if (signal.aborted) onAbort();
          if (aborted) return;
          yield { type: "text_delta", text: "FIRST" };
          await gate;
          if (aborted) return;
          yield { type: "text_delta", text: "SECOND" };
          yield { type: "finish", reason: "stop" };
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
    };
    const i = render(<App intro={false} cwd={cwd} home={home} provider={provider} startInChat skipOnboarding />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // A painted frame can precede useInput's passive effect. Flush the
    // input update before the next key, without sleeping or replaying it.
    const send = async (key: string) => {
      const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const previous = env.IS_REACT_ACT_ENVIRONMENT;
      env.IS_REACT_ACT_ENVIRONMENT = true;
      try {
        await act(async () => { i.stdin.write(key); });
      } finally {
        if (previous === undefined) delete env.IS_REACT_ACT_ENVIRONMENT;
        else env.IS_REACT_ACT_ENVIRONMENT = previous;
      }
    };
    try {
      await waitForFrame(frame, COMPOSER_READY);
      await send("reply");
      await waitForFrame(frame, "reply");
      await send("\r");
      await waitForFrame(frame, "FIRST");
      await send("\x12");
      await waitForFrame(frame, "rename session");
      expect(frame()).toContain("rename session");
      await send("Streaming name");
      await waitForFrame(frame, "Streaming name");
      await send("\r");
      await waitForFrame(frame, "rename session", { absent: true });
      await waitForCondition(
        () => listSessionSummaries(cwd, home)[0]?.title === "Streaming name",
        () => `streaming rename was not saved. Last frame:\n${frame()}`,
      );
      const summary = listSessionSummaries(cwd, home)[0];
      expect(summary?.title).toBe("Streaming name");
      const pendingLog = readFileSync(summary!.file, "utf8");
      expect(pendingLog).toContain('"text":"FIRST"');
      expect(pendingLog).not.toContain('"text":"SECOND"');
      expect(pendingLog).not.toContain('"type":"done"');
      expect(aborted).toBe(false);
      release();
      await waitForCondition(
        () => readFileSync(summary!.file, "utf8").includes('"type":"done"'),
        () => `the renamed turn did not finish. Last frame:\n${frame()}`,
      );
      const log = readFileSync(summary!.file, "utf8");
      expect(log).toContain('"text":"SECOND"');
      expect(log).not.toContain('"type":"cancelled"');
      expect(aborted).toBe(false);
    } finally {
      release();
      i.unmount();
    }
  });

  test("esc cancels without changing the current display name", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const home = tempHome();
    const i = render(<App intro={false} cwd={cwd} home={home} provider={MockProvider.demo()} startInChat skipOnboarding />);
    await sleep(50);
    i.stdin.write("\x12");
    await sleep(50);
    i.stdin.write("Keep me");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(50);
    i.stdin.write("\x12");
    await sleep(50);
    i.stdin.write(" changed");
    await sleep(30);
    i.stdin.write("\x1b");
    await sleep(50);
    expect(listSessionSummaries(cwd, home)[0]?.title).toBe("Keep me");
    i.unmount();
  });
});

describe("usage quota modal (#499)", () => {
  test("ctrl+q opens the modal from chat, esc closes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding />);
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("usage quota");
    i.stdin.write("\x11"); // ctrl+q
    await sleep(80);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("usage quota");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("local measured");
    i.stdin.write("\x1b"); // esc
    await sleep(70); // 40ms alt-buffer flip
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("usage quota");
    i.unmount();
  });
});

describe("project map modal (#619)", () => {
  test("/mpm opens the inspection modal from chat, esc closes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding />);
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("project map");
    i.stdin.write("/mpm");
    await sleep(60);
    // The slash popup's first enter accepts the suggestion, the second sends.
    i.stdin.write("\r");
    await sleep(80);
    i.stdin.write("\r");
    await sleep(120);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("project map");
    // Metadata only, in every state.
    expect(frame).toContain("esc close");
    i.stdin.write("\x1b"); // esc
    await sleep(70);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("project map");
    i.unmount();
  });
});