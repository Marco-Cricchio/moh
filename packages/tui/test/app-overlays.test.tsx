import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMohConfig, MockProvider } from "@moh/core";
import { App } from "../src/App";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempHome = () => mkdtempSync(join(tmpdir(), "moh-app-ov-"));

describe("App overlays (issue #33)", () => {
  // #236 Class 1: App must isolate onboarding env-detection from the real
  // process environment — a machine with provider keys in the environment
  // made every "first run" test see the detect list (or its chrome) instead
  // of the wizard, regardless of the injected home dir.
  test("onboarding env-detection uses the injected env, not the real process env (#236)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const home = tempHome();
    const withKey = render(<App cwd={cwd} home={home} env={{ ANTHROPIC_API_KEY: "sk-test-236" }} />);
    await sleep(50);
    expect(stripAnsi(withKey.lastFrame() ?? "")).toContain("connect a provider");
    withKey.unmount();
    const fresh = tempHome();
    const clean = render(<App cwd={mkdtempSync(join(tmpdir(), "moh-app-cwd-"))} home={fresh} env={{}} />);
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
    const i = render(<App cwd={cwd} home={home} env={{}} />);
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
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    i.stdin.write("n"); // new session
    await sleep(50);
    i.unmount();
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).handoff).toEqual({ onboarding: "reminded" });
  });

  test("direct chat skips the handoff offer", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} startInChat />);
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("type…");
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("session handoff");
    i.unmount();
  });

  test("a configured provider skips onboarding entirely", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("search or start something new");
    i.unmount();
  });

  test("? opens the all-commands panel, esc closes; s opens settings", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
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
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
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
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding />);
    Object.defineProperty(i.stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(i.stdout, "rows", { value: 40, configurable: true });
    i.stdout.emit("resize");
    await sleep(50);
    const before = stripAnsi(i.lastFrame() ?? "");
    expect(before).toContain("type…");
    expect(before).toContain("· ready");

    i.stdin.write("\x13"); // ctrl+s
    await sleep(50);
    const during = stripAnsi(i.lastFrame() ?? "").split("\n");
    expect(during.some((line) => line.includes("settings"))).toBe(true);
    expect(during.some((line) => line.includes("type…"))).toBe(true);
    expect(during.some((line) => line.includes("· ready"))).toBe(true);
    i.unmount();
  });

  test("in chat, ? on an empty draft opens commands, then closes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding />);
    await sleep(50);
    i.stdin.write("n"); // new session → chat
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("type…");
    i.stdin.write("?");
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("all commands");
    i.stdin.write("\x1b");
    await sleep(50);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("all commands");
    expect(frame).toContain("type…"); // chat still alive under the closed overlay
    i.unmount();
  });
});

describe("usage quota modal (#499)", () => {
  test("ctrl+q opens the modal from chat, esc closes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-app-cwd-"));
    const i = render(<App cwd={cwd} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding />);
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
