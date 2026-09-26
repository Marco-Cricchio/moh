/**
 * #918/ADR-0044: the `/mnt` footer hint. A project root under `/mnt/` is a
 * Windows drive mounted into WSL, where file I/O is dramatically slower;
 * the footer says so on its own row, always on, never blocking. Outside the
 * condition nothing renders — the distro-filesystem case keeps today's
 * footer byte for byte.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, createSession } from "@moh/core";
import { ThemeProvider, THEMES } from "../src/themes";
import { BottomBar } from "../src/BottomBar";
import { Chat } from "../src/Chat";
import { stripAnsi } from "./helpers";

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

/** One frame of the themed element, de-ANSI'd (the shared render seam of
 * this file: the BottomBar cases and the Chat case differ only in the tree). */
function frameOfElement(ui: React.ReactElement): string {
  const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}>{ui}</ThemeProvider>);
  const frame = stripAnsi(ink.lastFrame() ?? "");
  ink.unmount();
  return frame;
}

function frameOf(props: Record<string, unknown>, width?: number): string {
  const bottomBarProps = { ...base, ...(width !== undefined ? { width } : {}), ...props };
  return frameOfElement(<BottomBar {...(bottomBarProps as unknown as Parameters<typeof BottomBar>[0])} />);
}

/** The hint's own row, isolated: the frame's other rows legitimately contain
 * elision markers (the short composer placeholder) and slashes, so a
 * whole-frame substring check cannot tell "fits untruncated" from "cut by the
 * terminal". */
function hintLineOf(frame: string): string {
  return frame.split("\n").find((line) => line.includes("/mnt")) ?? "";
}

describe("`/mnt` footer hint (#918, ADR-0044)", () => {
  test("absent by default and when the fact is false", () => {
    expect(frameOf({})).not.toContain("/mnt");
    expect(frameOf({ rootOnWindowsMount: false })).not.toContain("/mnt");
  });

  test("wide: what /mnt is, why it costs, what to do", () => {
    const frame = frameOf({ rootOnWindowsMount: true });
    expect(frame).toContain("⚠ /mnt — a Windows drive in WSL");
    expect(frame).toContain("dramatically slower");
    expect(frame).toContain("keep projects in Linux (~/projects)");
  });

  test("narrow widths keep the advice, dropping the explanation", () => {
    expect(frameOf({ rootOnWindowsMount: true }, 90)).toContain("⚠ /mnt — slow I/O (a Windows drive in WSL); keep projects in Linux");
    expect(frameOf({ rootOnWindowsMount: true }, 48)).toContain("⚠ /mnt is slow — use ~/projects");
  });

  test("every tier fits the style guide's 35-column floor untruncated", () => {
    // The hint earns its own row by carrying the advice, so a truncation at
    // the supported floor would cut exactly that. Below 70 columns the
    // compact tier is in force, making the floor its tightest real case.
    for (const width of [35, 40, 69]) {
      expect(hintLineOf(frameOf({ rootOnWindowsMount: true }, width)).trim()).toBe("⚠ /mnt is slow — use ~/projects");
    }
  });

  test("the status rows are untouched: the hint is its own line", () => {
    const withHint = frameOf({ rootOnWindowsMount: true, cwd: "/mnt/c/project" });
    const without = frameOf({ cwd: "/mnt/c/project" });
    // The cwd row renders identically in both — the hint never displaces or
    // rewrites the live status, it only adds a line above it.
    expect(without).not.toContain("⚠ /mnt");
    const cwdRows = (frame: string) => frame.split("\n").filter((line) => line.includes("▣"));
    expect(cwdRows(withHint)).toEqual(cwdRows(without));
  });
});

describe("the hint rides the session's own fact (#918)", () => {
  test("Chat reads it from the session — a /mnt session shows it, a distro one does not", () => {
    const provider = () => MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const onMount = createSession({ cwd: "/mnt/c/project", provider: provider(), memory: { enabled: false } });
    const onDistro = createSession({
      cwd: join(tmpdir(), `moh-tui-mnt-${process.pid}-${Date.now()}`),
      provider: provider(),
      memory: { enabled: false },
    });
    const chatFrame = (session: ReturnType<typeof createSession>, cwd: string) =>
      frameOfElement(<Chat session={session} cwd={cwd} mode="dev" modelLabel="mock" width={100} />);
    expect(chatFrame(onMount, "/mnt/c/project")).toContain("⚠ /mnt");
    expect(chatFrame(onDistro, "/tmp")).not.toContain("⚠ /mnt");
  });
});
