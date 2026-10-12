import "./faketty/ci-mask";
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
import { Box } from "ink";
import { renderOnFakeTty } from "./faketty/render";
import { useViewport } from "../src/viewport";
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

/** Mounts the modal over a real store, wired exactly as the App wires it
 * to the session's own seams. */
function mount(cwd: string, mohHome: string) {
  const store = RetroStore.forProject(cwd, mohHome);
  return render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <RetroModal
        cwd={cwd}
        readReport={() => store.report()}
        dismiss={(signature, category) => store.dismiss(signature, { category })}
        onClose={() => {}}
      />
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
    await waitForFrame(() => stripAnsi(instance.lastFrame() ?? ""), "no open findings");
    instance.unmount();
  });

  test("a disabled retro says so instead of showing an empty report", async () => {
    const cwd = tempDir("cwd");
    const instance = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <RetroModal cwd={cwd} readReport={() => null} dismiss={() => {}} onClose={() => {}} />
      </ThemeProvider>,
    );
    await waitForFrame(() => stripAnsi(instance.lastFrame() ?? ""), "disabled for this session");
    instance.unmount();
  });

  test("dismissals stay visible after the finding is gone", async () => {
    const cwd = tempDir("cwd");
    const mohHome = tempDir("home");
    const { store, signature } = seed(cwd, mohHome);
    store.dismiss(signature, { now: new Date("2026-01-02T00:00:00Z"), category: "navigation" });
    const instance = mount(cwd, mohHome);
    await waitForFrame(() => stripAnsi(instance.lastFrame() ?? ""), "1 dismissal recorded");
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

describe("RetroModal vertical fit", () => {
  test("many long findings never render past the terminal height", async () => {
    const cwd = tempDir("cwd");
    const mohHome = tempDir("home");
    const store = RetroStore.forProject(cwd, mohHome);
    const long = "the same bash command was issued five times this session: `sleep 150; gh pr checks 871 2>&1 | awk '$2 != \"pass\" {print $1, $2}'` — a polling pattern the batch should notice and describe precisely";
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      category: "tool-economy",
      evidence: `${long} (#${i})`,
      confidence: 0.5,
      session: `s-${i}`,
      signature: `sig-${i}`,
    }));
    store.append(candidates);
    const instance = mount(cwd, mohHome);
    await waitForFrame(() => stripAnsi(instance.lastFrame() ?? ""), "tool-economy");
    const frame = instance.lastFrame() ?? "";
    const rows = stripAnsi(frame).split("\n").length;
    // ink's default test viewport is 80x24: the whole dialog must fit.
    expect(rows).toBeLessThanOrEqual(24);
    instance.unmount();
  });
});

function Overlay({ children }: { children: React.ReactNode }) {
  const viewport = useViewport();
  return <Box width={viewport.columns - 1} height={viewport.rows - 1} flexDirection="column">{children}</Box>;
}

describe("RetroModal terminal geometry", () => {
  test("both borders survive scrolling, confirmation, status and resize", async () => {
    const cwd = tempDir("cwd");
    const mohHome = tempDir("home");
    const store = RetroStore.forProject(cwd, mohHome);
    store.append(Array.from({ length: 30 }, (_, i) => ({
      category: "coding-standards", evidence: `Repeated evidence ${"long observation ".repeat(12)} ${i}`,
      confidence: 0.7, session: "session-with-a-long-identifier-that-wraps-at-narrow-widths", signature: `sig-${i}`,
    })));
    const tty = renderOnFakeTty(<ThemeProvider value={THEMES[DEFAULT_THEME]}><Overlay>
      <RetroModal cwd={cwd} readReport={() => store.report()} dismiss={(signature, category) => store.dismiss(signature, { category })} onClose={() => {}} />
    </Overlay></ThemeProvider>, { cols: 70, rows: 16 });
    const check = async () => {
      await tty.settle();
      const frame = tty.screen.lines().join("\n");
      expect(frame).toContain("╭");
      expect(frame).toContain("╮");
      expect(frame).toContain("╰");
      expect(frame).toContain("╯");
      const lines = frame.split("\n");
      expect(lines.findIndex((line) => line.includes("╰")) - lines.findIndex((line) => line.includes("╭")) + 1).toBeLessThanOrEqual(tty.stdout.rows - 1);
      expect(tty.maxFrameRows()).toBeLessThanOrEqual(tty.stdout.rows);
      return frame;
    };
    try {
      await check();
      for (let i = 0; i < 8; i++) { tty.write("j"); await check(); }
      tty.write("a");
      expect(await check()).toContain("y creates it");
      tty.write("y");
      expect(await check()).toContain("refused:");
      writeFileSync(join(cwd, "CODING_STANDARDS.md"), "# Coding standards\n");
      tty.write("a");
      await check();
      tty.write("y");
      expect(await check()).toContain("applied to");
      expect(readFileSync(join(cwd, "CODING_STANDARDS.md"), "utf8")).toContain("Retro findings");
      tty.resize(45, 16);
      await check();
      tty.resize(100, 24);
      await check();
      tty.resize(60, 12);
      await check();
    } finally { await tty.unmount(); }
  });
});
