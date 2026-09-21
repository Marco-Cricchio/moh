import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { readGitBranch } from "../src/git-branch";
import { BottomBar, middleElide } from "../src/BottomBar";
import { ThemeProvider, THEMES } from "../src/themes";
import { stripAnsi } from "./helpers";

const tempDir = () => mkdtempSync(join(tmpdir(), "moh-git-branch-"));

describe("readGitBranch (status bar git label)", () => {
  test("reads the branch from .git/HEAD", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feature/status-bar\n");
    expect(readGitBranch(dir)).toBe("feature/status-bar");
  });

  test("walks up to the repository root", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/develop\n");
    const nested = join(dir, "packages", "tui");
    mkdirSync(nested, { recursive: true });
    expect(readGitBranch(nested)).toBe("develop");
  });

  test("follows the gitdir pointer of a worktree", () => {
    const main = tempDir();
    mkdirSync(join(main, ".git"));
    writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/develop\n");
    const gitDir = mkdtempSync(join(tmpdir(), "moh-git-wt-"));
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feature/x\n");
    const worktree = tempDir();
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    expect(readGitBranch(worktree)).toBe("feature/x");
  });

  test("shows the short sha of a detached HEAD", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".git"));
    const sha = "0123456789abcdef0123456789abcdef01234567";
    writeFileSync(join(dir, ".git", "HEAD"), `${sha}\n`);
    expect(readGitBranch(dir)).toBe(sha.slice(0, 7));
  });

  test("returns null outside any repository", () => {
    expect(readGitBranch(tempDir())).toBeNull();
  });

  test("an unreadable .git directory is not a repository", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".git")); // no HEAD file
    expect(readGitBranch(dir)).toBeNull();
  });
});

describe("BottomBar branch segment", () => {
  const base = { width: 120, pending: false, spinner: "⠸", model: "claude-sonnet-4", turns: 12, tokens: { contextIn: 170_000, totalOut: 4_000, calls: 2 }, level: "medium" as const, focusedChip: null };

  const renderBar = (props: Record<string, unknown>) => {
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><BottomBar {...base} {...(props as any)} /></ThemeProvider>);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    ink.unmount();
    return frame;
  };

  test("shows the branch in both modes", () => {
    for (const mode of ["vibe", "dev"] as const) {
      expect(renderBar({ mode, branch: "develop" })).toContain("⎇ develop");
    }
  });

  test("omits the segment when there is no repository", () => {
    expect(renderBar({ mode: "dev", branch: null })).not.toContain("⎇");
  });

  test("the segment stays inside the row budget at narrow widths", () => {
    for (const width of [35, 45, 69, 70, 90]) {
      const frame = renderBar({ width, mode: "dev", branch: "develop", tokens: { contextIn: 0, totalOut: 0, calls: 0 } });
      for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(width - 1);
    }
  });
});

describe("status row 2A: the where-you-are row (cwd → branch → mode)", () => {
  const base = { width: 120, pending: false, spinner: "⠸", model: "mock", turns: 0, tokens: { contextIn: 0, totalOut: 0, calls: 0 }, level: "default" as const, focusedChip: null };

  const renderBar = (props: Record<string, unknown>) => {
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><BottomBar {...base} {...(props as any)} /></ThemeProvider>);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    ink.unmount();
    return frame;
  };

  test("shows the cwd, branch and mode together, cwd first", () => {
    const frame = renderBar({ mode: "dev", cwd: "/Users/mc/Documents/AI_Projects/moh", branch: "develop" });
    expect(frame).toContain("▣ /Users/mc/Documents/AI_Projects/moh");
    expect(frame).toContain("⎇ develop");
    expect(frame).toContain("◉ dev");
    const row = frame.split("\n").find((line) => line.includes("▣"))!;
    expect(row.indexOf("▣")).toBeLessThan(row.indexOf("⎇"));
    expect(row.indexOf("⎇")).toBeLessThan(row.indexOf("◉"));
  });

  test("a long cwd middle-elides: head and tail stay, middle collapses", () => {
    const long = "/Users/mc/Documents/very/deeply/nested/projects/thing";
    // width 90 = regular class → cwd budget 30 (head 15 + … + tail 14)
    const frame = renderBar({ width: 90, mode: "dev", cwd: long, branch: "develop" });
    expect(frame).toContain("▣ /Users/mc/Docum…projects/thing");
    expect(frame).not.toContain(long);
    // width 120 = wide class → budget 44: the same path keeps more of both ends
    const wide = renderBar({ mode: "dev", cwd: long, branch: "develop" });
    expect(wide).toContain("▣ /Users/mc/Documents/ve…nested/projects/thing");
  });

  test("compact budget keeps start and end readable at 35 cols", () => {
    const frame = renderBar({ width: 35, mode: "dev", cwd: "/Users/mc/Documents/AI_Projects/moh", branch: "feat/very-long-branch-name" });
    const row = frame.split("\n").find((line) => line.includes("▣"))!;
    // the cwd segment is middle-elided (head and tail visible), then branch, then mode
    expect(row).toMatch(/▣ \S+…\S+ ⎇/);
    expect(row).toContain("◉ dev");
    expect(row.length).toBeLessThanOrEqual(35);
  });

  test("no cwd prop: row 2 degrades to branch + mode", () => {
    const frame = renderBar({ mode: "vibe", branch: "develop" });
    expect(frame).toContain("⎇ develop");
    expect(frame).toContain("○ vibe");
    expect(frame).not.toContain("▣");
  });

  test("the tail closes on the last printable cell with no left segment", () => {
    // #876: with one child, `space-between` resolves to flex-start and the
    // tail rendered flush left; the justification follows the left slot, so
    // the offset — not just the suffix — is what must hold.
    for (const width of [35, 45, 69, 70, 90, 109, 110, 120]) {
      const frame = renderBar({ width, mode: "dev", cwd: "/x", branch: "develop" });
      const row2 = frame.split("\n").find((line) => line.includes("▣"))!;
      const tail = row2.slice(row2.indexOf("▣"));
      expect(row2.length).toBe(width - 2);
      expect(row2.indexOf("▣")).toBe(width - 2 - tail.length);
    }
  });

  test("the tail is right-aligned with a left segment, with and without a notice", () => {
    for (const width of [35, 70, 120]) {
      for (const extra of [
        { permissionMode: "yolo" as const },
        { updateMessage: "moh 0.8.0 available" },
        { permissionMode: "yolo" as const, updateMessage: "moh 0.8.0 available" },
      ]) {
        const frame = renderBar({ width, mode: "dev", cwd: "/x", branch: "develop", ...extra });
        const row2 = frame.split("\n").find((line) => line.includes("▣"))!;
        const tail = row2.slice(row2.indexOf("▣"));
        expect(row2.length).toBe(width - 2);
        expect(row2.indexOf("▣")).toBe(width - 2 - tail.length);
      }
    }
  });

  test("every permission mode renders its chip after the projection chip (#876)", () => {
    const chips = { normal: "◌ Normal", "auto-accept": "◐ Auto-Accept", yolo: "⚠ YOLO" } as const;
    for (const [permissionMode, chip] of Object.entries(chips)) {
      const frame = renderBar({ mode: "dev", cwd: "/x", branch: "develop", permissionMode });
      const row = frame.split("\n").find((line) => line.includes("⎇ develop"))!;
      expect(row).toContain(chip);
      expect(row.indexOf("◉ dev")).toBeLessThan(row.lastIndexOf(chip));
    }
  });

  test("compact terminals keep the permission glyph and drop the word (#876)", () => {
    const glyphs = { normal: "◌", "auto-accept": "◐", yolo: "⚠" } as const;
    for (const [permissionMode, glyph] of Object.entries(glyphs)) {
      const frame = renderBar({ width: 60, mode: "dev", cwd: "/x", branch: "develop", permissionMode });
      const row = frame.split("\n").find((line) => line.includes("⎇ develop"))!;
      expect(row.endsWith(`◉ dev ${glyph}`)).toBe(true);
      expect(row).not.toContain("Normal");
      expect(row).not.toContain("Auto-Accept");
    }
  });

  test("no permission-mode chip when the client has no mode to show (#876)", () => {
    const frame = renderBar({ mode: "dev", cwd: "/x", branch: "develop" });
    for (const copy of ["Normal", "Auto-Accept", "YOLO"]) expect(frame).not.toContain(copy);
  });

  test("the permission-mode chip is never dropped, and no row wraps, 35–140 (#876)", () => {
    const glyphs = { normal: "◌", "auto-accept": "◐", yolo: "⚠" } as const;
    for (const width of [35, 45, 69, 70, 90, 109, 110, 120]) {
      for (const [permissionMode, glyph] of Object.entries(glyphs)) {
        const frame = renderBar({ width, mode: "dev", cwd: "/Users/mc/Documents/AI_Projects/moh", branch: "develop", permissionMode, updateMessage: "moh 0.8.0 available" });
        const row = frame.split("\n").find((line) => line.includes("⎇"))!;
        expect(row).toContain(glyph);
        expect(row).toContain("◉ dev");
        for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(width - 1);
      }
    }
  });

  test("the cwd keeps its head and tail: the chip takes its space, never the cwd's shape", () => {
    const frame = renderBar({ width: 90, mode: "dev", cwd: "/Users/mc/Documents/very/deeply/nested/projects/thing", branch: "develop", permissionMode: "auto-accept" });
    const row = frame.split("\n").find((line) => line.includes("⎇ develop"))!;
    expect(row).toMatch(/▣ \S+…\S+/);
    expect(row).toContain("◐ Auto-Accept");
  });

  test("middleElide: no-op within budget, exact split at the boundary", () => {
    expect(middleElide("/short/path", 20)).toBe("/short/path");
    expect(middleElide("/a/b/c/d/e/f/g/h", 9)).toBe("/a/b…/g/h");
  });
});

describe("status row 2 update notice (#328)", () => {
  const base = { width: 120, pending: false, spinner: "⠸", model: "mock", turns: 0, tokens: { contextIn: 0, totalOut: 0, calls: 0 }, level: "default" as const, focusedChip: null };

  const renderBar = (props: Record<string, unknown>) => {
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><BottomBar {...base} {...(props as any)} /></ThemeProvider>);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    ink.unmount();
    return frame;
  };

  const MSG = "moh 0.8.0 available — run `moh update`";

  test("notice renders left-aligned on row 2 with the tail intact, both modes", () => {
    for (const mode of ["vibe", "dev"] as const) {
      const frame = renderBar({ mode, cwd: "/Users/mc/Documents/AI_Projects/moh", branch: "develop", updateMessage: MSG });
      const row2 = frame.split("\n").find((l) => l.includes("⎇ develop"))!;
      expect(row2).toContain(MSG);
      expect(row2.trimEnd().endsWith("○ vibe") || row2.trimEnd().endsWith("◉ dev")).toBe(true);
      expect(row2.indexOf(MSG)).toBeLessThan(row2.indexOf("▣"));
    }
  });

  test("no notice segment when none is active", () => {
    const frame = renderBar({ mode: "dev", cwd: "/x", branch: "develop" });
    expect(frame).not.toContain("moh update");
  });

  test("notice elides at narrow widths; the tail is never displaced or dropped", () => {
    for (const width of [50, 70, 90]) {
      const frame = renderBar({ width, mode: "dev", cwd: "/Users/mc/Documents/AI_Projects/moh", branch: "develop", updateMessage: MSG });
      const row2 = frame.split("\n").find((l) => l.includes("⎇ develop"))!;
      expect(row2).toContain("◉ dev");
      expect(row2).not.toContain(MSG); // fully elided at these widths is fine
      for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(width - 1);
    }
  });
});

describe("yolo indicator (#377)", () => {
  const base = { width: 120, pending: false, spinner: "⠸", model: "mock", turns: 0, tokens: { contextIn: 0, totalOut: 0, calls: 0 }, level: "default" as const, focusedChip: null };
  const renderBar = (props: Record<string, unknown>) => {
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><BottomBar {...base} {...(props as any)} /></ThemeProvider>);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    ink.unmount();
    return frame;
  };

  test("⚠ YOLO leads row 2 when the session is yolo; absent otherwise", () => {
    const frame = renderBar({ mode: "dev", cwd: "/x", branch: "develop", permissionMode: "yolo" });
    const row2 = frame.split("\n").find((l) => l.includes("▣"))!;
    // #876: the banner is the fixed `⚠ YOLO` alarm (never elided away); the
    // mode itself is carried by the tail chip on the right.
    expect(row2.trimStart().startsWith("⚠ YOLO")).toBe(true);
    expect(row2.indexOf("⚠")).toBeLessThan(row2.indexOf("▣"));
    expect(row2.trimEnd().endsWith("◉ dev ⚠ YOLO")).toBe(true);
    const plain = renderBar({ mode: "dev", cwd: "/x", branch: "develop" });
    expect(plain).not.toContain("YOLO");
  });

  test("yolo indicator leads row 2 with the update notice beside it; the tail is never displaced", () => {
    const frame = renderBar({ mode: "dev", cwd: "/x", branch: "develop", permissionMode: "yolo", updateMessage: "moh update available" });
    const row2 = frame.split("\n").find((l) => l.includes("⎇ develop"))!;
    expect(row2.trimStart().startsWith("⚠ YOLO")).toBe(true);
    expect(row2).toContain("◉ dev");
    // #391 follow-up: a yolo session still sees the update notice (#328),
    // elided to the remaining budget — never dropped entirely.
    expect(row2).toContain("moh upd");
    expect(row2.indexOf("YOLO")).toBeLessThan(row2.indexOf("moh"));
  });

  test("short form at narrow widths; rows stay within the viewport", () => {
    const frame = renderBar({ width: 46, mode: "dev", cwd: "/long/path/to/project", branch: "develop", permissionMode: "yolo" });
    const row2 = frame.split("\n").find((l) => l.includes("⎇"))!;
    // the banner never elides below its fixed shape, banner and chip alike.
    expect(row2).toContain("⚠ YOLO");
    expect(row2).toContain("◉ dev");
    for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(45);
  });
});
