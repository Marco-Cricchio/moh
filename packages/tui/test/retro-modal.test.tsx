/**
 * The retro report surface (ADR-0075, #1275): the pull-based door.
 * Component-level, in-process — the store is real (temp dirs), the
 * subagent is never involved (the findings are seeded directly).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { RetroStore } from "@moh/core";
import { RetroModal } from "../src/RetroModal";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi, waitForFrame } from "./helpers";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = join(tmpdir(), `moh-retro-modal-${prefix}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(cwd: string, mohHome: string) {
  return render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <RetroModal cwd={cwd} mohHome={mohHome} onClose={() => {}} />
    </ThemeProvider>,
  );
}

/** Seeds one finding and returns the store plus the signature it was
 * stamped with (the store owns the signature derivation). */
function seed(cwd: string, mohHome: string, category = "navigation", evidence = "spent 12 calls locating the session store") {
  const store = RetroStore.forProject(cwd, mohHome);
  store.append([{ category, evidence, confidence: 0.7, session: "s-1", signature: `${category}:${evidence}` }]);
  return { store, signature: store.read()[0]!.signature };
}

describe("RetroModal", () => {
  test("an empty store shows the accumulation hint", async () => {
    const cwd = tempDir("cwd");
    const mohHome = tempDir("home");
    const instance = mount(cwd, mohHome);
    await waitForFrame(() => stripAnsi(instance.lastFrame() ?? ""), "nothing accumulated");
    instance.unmount();
  });

  test("lists findings with category, confidence and the proposed application", async () => {
    const cwd = tempDir("cwd");
    const mohHome = tempDir("home");
    seed(cwd, mohHome);
    const instance = mount(cwd, mohHome);
    await waitForFrame(() => stripAnsi(instance.lastFrame() ?? ""), "navigation");
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("70%");
    expect(frame).toContain("spent 12 calls locating the session store");
    expect(frame).toContain("add a navigation pointer");
    expect(frame).toContain("AGENTS.md");
    instance.unmount();
  });

  test("d records a durable dismissal bound to the signature", async () => {
    const cwd = tempDir("cwd");
    const mohHome = tempDir("home");
    const { store, signature } = seed(cwd, mohHome);
    const instance = mount(cwd, mohHome);
    await waitForFrame(() => stripAnsi(instance.lastFrame() ?? ""), "navigation");
    instance.stdin.write("d");
    await sleep(60);
    expect(store.dismissed().has(signature)).toBe(true);
    expect(store.report().findings).toHaveLength(0);
    instance.unmount();
  });

  test("apply asks for confirmation and writes only on y", async () => {
    const cwd = tempDir("cwd");
    const mohHome = tempDir("home");
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\n");
    seed(cwd, mohHome);
    const instance = mount(cwd, mohHome);
    await waitForFrame(() => stripAnsi(instance.lastFrame() ?? ""), "navigation");
    instance.stdin.write("a");
    await sleep(40);
    expect(stripAnsi(instance.lastFrame() ?? "")).toContain("apply to AGENTS.md?");
    instance.stdin.write("n");
    await sleep(40);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe("# Agents\n");
    instance.stdin.write("a");
    await sleep(40);
    instance.stdin.write("y");
    await sleep(60);
    const after = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(after).toContain("## Retro findings");
    expect(after).toContain("add a navigation pointer");
    expect(stripAnsi(instance.lastFrame() ?? "")).toContain("applied to");
    instance.unmount();
  });
});
