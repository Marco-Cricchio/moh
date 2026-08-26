import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { readGitBranch } from "../src/git-branch";
import { BottomBar } from "../src/BottomBar";
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
