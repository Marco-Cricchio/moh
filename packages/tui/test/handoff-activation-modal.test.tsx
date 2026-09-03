import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMohConfig } from "@moh/core";
import { HandoffActivationModal } from "../src/HandoffActivationModal";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cwd = () => mkdtempSync(join(tmpdir(), "moh-handoff-choice-"));
const mount = (dir: string, props: Partial<Parameters<typeof HandoffActivationModal>[0]> = {}) => render(
  <ThemeProvider value={THEMES[DEFAULT_THEME]}>
    <HandoffActivationModal cwd={dir} onDone={() => {}} {...props} />
  </ThemeProvider>,
);

describe("handoff activation modal (#438)", () => {
  test("enables GitHub Gist only after a successful inline gh verification", async () => {
    const dir = cwd();
    let verified = 0;
    const i = mount(dir, { verifyGh: () => { verified += 1; return { ok: true, user: "octo" }; } });
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("same account on both machines");
    i.stdin.write("\r");
    await sleep(30);
    expect(verified).toBe(1);
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toEqual({ transport: "gist" });
    i.unmount();
  });

  test("a missing gh leaves the project transport Not Set", async () => {
    const dir = cwd();
    const i = mount(dir, { verifyGh: () => ({ ok: false, error: { reason: "gh-missing" } }) });
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("not installed");
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toBeUndefined();
    i.unmount();
  });

  test("failed verification leaves the project transport Not Set", async () => {
    const dir = cwd();
    const i = mount(dir, { verifyGh: () => ({ ok: false, error: { reason: "not-logged-in" } }) });
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("gh auth login");
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toBeUndefined();
    i.unmount();
  });

  test("Settings can explicitly disable or reset the per-project transport without gh", async () => {
    const dir = cwd();
    let checks = 0;
    const i = mount(dir, { verifyGh: () => { checks += 1; return { ok: true, user: "unused" }; } });
    await sleep(30);
    i.stdin.write("\x1b[B");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toEqual({ transport: "none" });
    expect(checks).toBe(0);
    i.unmount();
  });

  test("Settings resets an explicit transport to Not Set", async () => {
    const dir = cwd();
    const i = mount(dir);
    await sleep(30);
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toBeUndefined();
    i.unmount();
  });

  test("startup dismissal persists one future reminder state", async () => {
    const dir = cwd();
    const i = mount(dir, { startup: true });
    await sleep(30);
    i.stdin.write("n");
    await sleep(30);
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toEqual({ onboarding: "dismissed" });
    i.unmount();
  });
});
