/**
 * #619: MPM in the TUI — the first status row chip (ready / updating /
 * unavailable, compact + wide), the /mpm inspection modal rendering the
 * CLI-equivalent diagnostic concepts, and the slash-command
 * discoverability wiring. Component-level fixtures only: no projection IO.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { MpmDiagnostics } from "@moh/core";
import { BottomBar } from "../src/BottomBar";
import { MpmModal } from "../src/MpmModal";
import { activeCommands } from "../src/commands";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi, waitForFrame } from "./helpers";

const base = {
  width: 120,
  pending: false,
  spinner: "⠸",
  model: "mock",
  turns: 12,
  tokens: { contextIn: 10_000, totalOut: 100, calls: 1 },
  level: "medium" as const,
  focusedChip: null,
};

function barFrame(props: Record<string, unknown>): string {
  const ink = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <BottomBar {...base} {...(props as any)} />
    </ThemeProvider>,
  );
  const frame = stripAnsi(ink.lastFrame() ?? "");
  ink.unmount();
  return frame;
}

function diag(over: Partial<MpmDiagnostics> = {}): MpmDiagnostics {
  return {
    status: "ready",
    disabled: false,
    disabledReason: null,
    fileCount: 42,
    symbolCount: 318,
    coverage: [
      { language: "typescript", files: 40, symbols: 310 },
      { language: "python", files: 2, symbols: 8 },
    ],
    capabilities: [{ language: "typescript", relations: ["imports"] }],
    builtAt: Date.now() - 120_000,
    staleCount: 3,
    pendingWork: 1,
    budget: { maxFiles: 20_000, maxTotalBytes: 64 * 1024 * 1024 },
    exclusions: ["dist/**", "node_modules/**"],
    evictions: 0,
    fallbackReason: null,
    ...over,
  };
}

function mountModal(over: Partial<MpmDiagnostics> = {}) {
  let closed = 0;
  const i = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <MpmModal diagnostics={diag(over)} onClose={() => (closed += 1)} />
    </ThemeProvider>,
  );
  return { instance: i, closed: () => closed };
}

const waitFor = (instance: { lastFrame: () => string | undefined }, text: string) =>
  waitForFrame(() => stripAnsi(instance.lastFrame() ?? ""), text);

describe("MPM status chip on the first status row (#619)", () => {
  test("renders nothing when MPM never activated", () => {
    const frame = barFrame({ mpmStatus: null });
    expect(frame).not.toContain("map");
    expect(frame).not.toContain("mapping");
    expect(frame).not.toContain("no map");
  });

  test("ready state shows ✓ map next to the status row (wide)", () => {
    const frame = barFrame({ mpmStatus: "ready" });
    expect(frame).toContain("✓ map");
  });

  test("updating state shows ↻ mapping", () => {
    const frame = barFrame({ mpmStatus: "updating" });
    expect(frame).toContain("↻ mapping");
  });

  test("unavailable state shows — no map", () => {
    const frame = barFrame({ mpmStatus: "unavailable" });
    expect(frame).toContain("— no map");
  });

  test("compact width degrades to bare glyphs, no row overflow", () => {
    for (const width of [35, 48, 69]) {
      const frame = barFrame({ mpmStatus: "updating", width });
      expect(frame).toContain("↻");
      expect(frame).not.toContain("mapping");
      // Never wraps past its row: the first line stays one line.
      expect(frame.split("\n")[0]!.length).toBeLessThan(width);
    }
  });

  test("transitions render across every state at constrained widths", () => {
    for (const status of ["ready", "updating", "unavailable"] as const) {
      for (const width of [48, 90, 120]) {
        const frame = barFrame({ mpmStatus: status, width });
        expect(frame.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("MpmModal inspection view (#619)", () => {
  test("renders the CLI-equivalent diagnostic concepts", async () => {
    const { instance } = mountModal();
    await waitFor(instance, "project map");
    const frame = stripAnsi(instance.lastFrame()!);
    expect(frame).toContain("✓ ready");
    expect(frame).toContain("42 file(s) · 318 symbol(s)");
    expect(frame).toContain("typescript: 40 file(s) · 310 symbol(s)");
    expect(frame).toContain("3 sampled path(s) changed");
    expect(frame).toContain("1 path(s) awaiting background refresh");
    expect(frame).toContain("20000 files");
    expect(frame).toContain("dist/**");
    expect(frame).not.toContain("export function"); // never source content
  });

  test("disabled state reports the reason, nothing else fabricated", async () => {
    const { instance } = mountModal({
      status: "unavailable",
      disabled: true,
      disabledReason: "user",
      fileCount: 0,
      symbolCount: 0,
      coverage: [],
      staleCount: 0,
      pendingWork: 0,
      fallbackReason: "disabled",
    });
    await waitFor(instance, "project map");
    const frame = stripAnsi(instance.lastFrame()!);
    expect(frame).toContain("disabled (user)");
    expect(frame).not.toContain("coverage");
    expect(frame).not.toContain("budget");
  });

  test("fallback reason is surfaced when present", async () => {
    const { instance } = mountModal({ fallbackReason: "stale" });
    await waitFor(instance, "stale");
    expect(stripAnsi(instance.lastFrame()!)).toContain("mapped paths stale");
  });

  test("esc closes the modal", async () => {
    const { instance, closed } = mountModal();
    await waitFor(instance, "project map");
    instance.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));
    expect(closed()).toBe(1);
  });
});

describe("MPM discoverability (#619)", () => {
  test("/mpm is listed with the TUI shell seam", () => {
    const commands = activeCommands({ config: { workflow: { enabled: false } } as any });
    const mpm = commands.find((c) => c.name === "mpm");
    expect(mpm).toBeDefined();
    expect(mpm!.description).toContain("project map");
    // Headless fallback: explains it needs the TUI, never crashes.
    let notified = "";
    mpm!.run({ notify: (m: string) => (notified = m) } as any, "");
    expect(notified).toContain("needs an open session");
  });
});
