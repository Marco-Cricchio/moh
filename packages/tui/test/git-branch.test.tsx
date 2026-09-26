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

  test("compact tier: tail-anchored cwd keeps the project dir; the branch drops whole, never mid-word (#1012)", () => {
    const frame = renderBar({ width: 35, mode: "dev", cwd: "/Users/mc/Documents/AI_Projects/moh", branch: "feat/very-long-branch-name" });
    const row = frame.split("\n").find((line) => line.includes("▣"))!;
    // the cwd is tail-anchored (…/moh), the long branch drops WHOLE (it would
    // truncate mid-word), the projection chip survives
    expect(row).toContain("▣ …/AI_Projects/moh");
    expect(row).not.toContain("⎇");
    expect(row).toContain("◉ dev");
    expect(row.length).toBeLessThanOrEqual(35);
  });

  test("compact tier ladder: the branch is kept while it fits whole, dropped before fragmenting (#1012)", () => {
    // 45 cols: the short branch still fits and renders whole.
    const fits = renderBar({ width: 45, mode: "dev", cwd: "/Users/mc/Documents/AI_Projects/moh", branch: "develop" });
    expect(fits).toContain("⎇ develop");
    // 35 cols with the same branch: no mid-word fragment anywhere on the row.
    const tight = renderBar({ width: 35, mode: "dev", cwd: "/Users/mc/Documents/AI_Projects/moh", branch: "develop" });
    const row = tight.split("\n").find((line) => line.includes("◉"))!;
    expect(row).not.toMatch(/⎇ \S+-\S+/); // never truncated inside the name
    for (const line of tight.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(35);
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
    // the offset — not just the suffix — is what must hold. Up to 120
    // columns the host emits the whole row, so the offset is exact; at 140
    // ink clamps the frame to the host width and only the tail's own end is
    // observable ("flush right", never the left margin).
    for (const width of [35, 45, 69, 70, 90, 109, 110, 120, 140]) {
      const frame = renderBar({ width, mode: "dev", cwd: "/x", branch: "develop" });
      const row2 = frame.split("\n").find((line) => line.includes("▣"))!;
      const tail = row2.slice(row2.indexOf("▣"));
      expect(row2.indexOf("▣")).toBe(row2.length - tail.length);
      expect(row2.indexOf("▣")).toBeGreaterThan(1);
      if (width <= 120) expect(row2.length).toBe(width - 2);
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
        expect(row2.indexOf("▣")).toBe(row2.length - tail.length);
        expect(row2.length).toBe(width - 2);
      }
    }
  });

  test("every permission mode speaks on the left, before the cwd (#876)", () => {
    // Owner decision: the mode is a statement about the session, so it reads
    // in the left slot the yolo banner always used — never beside the
    // projection chip on the right.
    for (const [width, leads] of [
      [120, { normal: "◌ Normal", "auto-accept": "◐ Auto-Accept", yolo: "⚠ YOLO — unrestricted tools" }],
      [90, { normal: "◌ Normal", "auto-accept": "◐ Auto-Accept", yolo: "⚠ YOLO" }],
      [60, { normal: "◌", "auto-accept": "◐", yolo: "⚠" }],
    ] as const) {
      for (const [permissionMode, lead] of Object.entries(leads)) {
        const frame = renderBar({ width, mode: "dev", cwd: "/x", branch: "develop", permissionMode });
        const row = frame.split("\n").find((line) => line.includes("⎇ develop"))!;
        expect(row.trimStart().startsWith(lead)).toBe(true);
        expect(row.indexOf("▣")).toBeGreaterThan(row.indexOf(lead));
        // the tail keeps exactly its two segments: cwd, branch, projection chip.
        expect(row.indexOf("▣")).toBeLessThan(row.indexOf("⎇ develop"));
        expect(row.indexOf("⎇ develop")).toBeLessThan(row.indexOf("◉ dev"));
        for (const copy of ["Normal", "Auto-Accept"]) expect(row.indexOf(copy) <= row.indexOf("▣")).toBe(true);
      }
    }
  });

  test("the word is what goes when the width class is tight; the glyph stays (#876)", () => {
    for (const [permissionMode, glyph] of [["normal", "◌"], ["auto-accept", "◐"], ["yolo", "⚠"]] as const) {
      const frame = renderBar({ width: 60, mode: "dev", cwd: "/x", branch: "develop", permissionMode });
      const row = frame.split("\n").find((line) => line.includes("⎇ develop"))!;
      expect(row.trimStart().startsWith(glyph)).toBe(true);
      expect(row).not.toContain("Normal");
      expect(row).not.toContain("Auto-Accept");
      expect(row).not.toContain("YOLO");
    }
  });

  test("no mode lead when the client has no mode to show (#876)", () => {
    const frame = renderBar({ mode: "dev", cwd: "/x", branch: "develop" });
    for (const copy of ["Normal", "Auto-Accept", "YOLO"]) expect(frame).not.toContain(copy);
    // The tail is still right-aligned: an empty left slot is simply empty.
    const row = frame.split("\n").find((line) => line.includes("▣"))!;
    expect(row.indexOf("▣")).toBe(row.length - row.slice(row.indexOf("▣")).length);
  });

  test("the mode lead is never dropped, and no row wraps, 35–140 (#876)", () => {
    for (const width of [35, 45, 69, 70, 90, 109, 110, 120, 140]) {
      for (const [permissionMode, glyph] of [["normal", "◌"], ["auto-accept", "◐"], ["yolo", "⚠"]] as const) {
        const frame = renderBar({ width, mode: "dev", cwd: "/Users/mc/Documents/AI_Projects/moh", branch: "develop", permissionMode, updateMessage: "moh 0.8.0 available" });
        // #1012: in compact the branch may drop whole; anchor on the row by
        // the projection chip, which survives every tier.
        const row = width < 70 ? frame.split("\n").find((line) => line.includes("◉ dev"))! : frame.split("\n").find((line) => line.includes("⎇"))!;
        expect(row).toContain(glyph);
        expect(row).toContain("◉ dev");
        for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(width - 1);
      }
    }
  });

  test("the cwd keeps its head and tail: the lead takes its space, never the cwd's shape", () => {
    // The squeezed widths are the point: the lead reserves its space first, so
    // the cwd shrinks and keeps its elision marker instead of being cut from
    // the end (which would take the project directory with it).
    for (const width of [45, 69, 90, 120]) {
      const frame = renderBar({ width, mode: "dev", cwd: "/Users/mc/Documents/very/deeply/nested/projects/thing", branch: "develop", permissionMode: "auto-accept" });
      const row = frame.split("\n").find((line) => line.includes("⎇"))!;
      expect(row).toMatch(/▣ \S*…\S+/);
      expect(row.trimStart().startsWith("◐")).toBe(true);
      for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(width - 1);
    }
    // #1012: at 35 the cwd degrades tail-anchored (the project dir stays)
    // instead of middle-elided, and the branch drops whole.
    {
      const frame = renderBar({ width: 35, mode: "dev", cwd: "/Users/mc/Documents/very/deeply/nested/projects/thing", branch: "develop", permissionMode: "auto-accept" });
      const row = frame.split("\n").find((line) => line.includes("◉ dev"))!;
      expect(row.trimStart().startsWith("◐")).toBe(true);
      for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(35);
    }
    // The tightest combination the row has: the mode lead and the whole tail
    // claim space at the narrowest class. The cwd keeps its shape (tail-
    // anchored in compact) — the branch is what gives way (style guide §4).
    {
      const frame = renderBar({ width: 45, mode: "dev", cwd: "/Users/mc/Documents/very/deeply/nested/projects/thing", branch: "develop", permissionMode: "yolo" });
      const row = frame.split("\n").find((line) => line.includes("⎇"))!;
      expect(row).toMatch(/▣ \S*…\S+/);
      expect(row.trimStart().startsWith("⚠")).toBe(true);
      for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(45);
    }
    for (const width of [32, 35]) {
      const frame = renderBar({ width, mode: "dev", cwd: "/Users/mc/Documents/very/deeply/nested/projects/thing", branch: "develop", permissionMode: "yolo" });
      const row = frame.split("\n").find((line) => line.includes("◉ dev"))!;
      expect(row.trimStart().startsWith("⚠")).toBe(true);
      // the whole cwd or the whole branch survives — never a fragment
      expect(row.includes("▣ …/") || row.includes("⎇ develop")).toBe(true);
      for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  test("middleElide: no-op within budget, exact split at the boundary", () => {
    expect(middleElide("/short/path", 20)).toBe("/short/path");
    expect(middleElide("/a/b/c/d/e/f/g/h", 9)).toBe("/a/b…/g/h");
  });

  test("#1012 compact battery: rows never wrap, never fragment mid-word, at 32/36/45 with pending and chips", () => {
    for (const width of [32, 36, 45]) {
      const frame = renderBar({
        width, pending: true, spinner: "⠸", mode: "vibe",
        model: "opencode-go/deepseek-v4", turns: 3,
        tokens: { contextIn: 170_000, totalOut: 4_000, calls: 2 },
        level: "medium" as const,
        mpmStatus: "updating", jevStatus: "active" as const,
        cwd: "/Users/mc/Documents/AI_Projects/moh", branch: "fix/944-routing-dedup",
        permissionMode: "normal" as const,
      });
      const lines = frame.split("\n").filter(Boolean);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(width - 1);
      // the scanner strip is never split across physical rows: row 1 appears exactly once
      expect(lines.filter((line) => line.includes("◈")).length).toBe(1);
      // the status rows show no mid-word fragments: segments end on word boundaries
      // (the model elides with …, never cut inside a run of letters without one)
      const row1 = lines.find((line) => line.includes("◈"))!;
      for (const word of row1.split(/\s+/).filter((w) => w.length > 2)) {
        expect(word.endsWith("-")).toBe(false);
      }
      // the model degrades to the endpoint-stripped or elided form, never a raw cut
      expect(row1).not.toContain("opencode-go/deepseek-v4".slice(0, 12));
      expect(row1.includes("deepseek-v4") || row1.includes("…")).toBe(true);
    }
  });

  test("#1012 compact row 1: the context gauge degrades to a percentage", () => {
    const frame = renderBar({ width: 36, pending: true, spinner: "⠸", mode: "dev", model: "mock", turns: 1, tokens: { contextIn: 170_000, totalOut: 100, calls: 1 }, level: "default" as const });
    expect(frame).toMatch(/\[\d{2}%\]/);
    expect(frame).not.toContain("████");
    // regular keeps the bar
    const wide = renderBar({ width: 90, pending: true, spinner: "⠸", mode: "dev", model: "mock", turns: 1, tokens: { contextIn: 170_000, totalOut: 100, calls: 1 }, level: "default" as const });
    expect(wide).toContain("█");
  });

  test("#1012 compact row 1: the model drops the endpoint prefix, then elides, then drops; the ◆ marker marks whichever survives", () => {
    const render1 = (width: number) => renderBar({ width, pending: true, spinner: "⠸", mode: "vibe", model: "opencode-go/deepseek-v4", turns: 0, tokens: { contextIn: 0, totalOut: 0, calls: 0 }, level: "default" as const });
    // 45: the stripped name fits whole
    const mid = render1(45);
    expect(mid).toContain("◆ deepseek-v4");
    expect(mid).not.toContain("opencode-go");
    // 32: elided with the marker — the stripped name (11) still fits the raw
    // budget, so force the tier with a left cluster that eats the row.
    const tight = renderBar({ width: 32, pending: true, spinner: "⠸", mode: "vibe", model: "opencode-go/deepseek-v4", turns: 0, tokens: { contextIn: 0, totalOut: 0, calls: 0 }, level: "default" as const, memoryFresh: true, mpmStatus: "updating", jevStatus: "active" as const });
    const row1 = tight.split("\n").find((line) => line.includes("◈"))!;
    expect(row1).toMatch(/◆ \S*…|◆ \S+/);
    expect(tight).not.toContain("opencode-go");
    expect(row1.includes("…") || row1.includes("deepseek-v4")).toBe(true);
  });

  test("#1012 compact row 1: the budget counts the left-cluster chips — no wrap with memory, MPM, jev and an extension status", () => {
    const frame = renderBar({
      width: 36, pending: true, spinner: "⠸", mode: "vibe",
      model: "claude-sonnet-4", turns: 0,
      tokens: { contextIn: 0, totalOut: 0, calls: 0 }, level: "default" as const,
      memoryFresh: true, mpmStatus: "ready",
      extensionStatuses: [{ extension: "guard", text: "∅ offline" }],
      jevStatus: "inert" as const,
    });
    for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(35);
    const row1 = frame.split("\n").find((line) => line.includes("◈"))!;
    expect(row1).toContain("◍");
    expect(row1).toContain("✓");
    expect(row1).toContain("∅ offline");
  });

  test("#1012 regular widths keep the previous row-1 shape (bar gauge, full model)", () => {
    const frame = renderBar({ width: 90, pending: false, spinner: "⠸", mode: "dev", model: "claude-sonnet-4", turns: 5, tokens: { contextIn: 170_000, totalOut: 100, calls: 1 }, level: "medium" as const });
    expect(frame).toContain("█");
    expect(frame).toContain("◆ claude-sonnet-4");
    expect(frame).toMatch(/⊣ 170\.0k/);
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
    // #876: yolo keeps its original full wording on the left, and the tail is
    // exactly cwd · branch · projection chip.
    expect(row2.trimStart().startsWith("⚠ YOLO — unrestricted tools")).toBe(true);
    expect(row2.indexOf("⚠")).toBeLessThan(row2.indexOf("▣"));
    expect(row2.trimEnd().endsWith("◉ dev")).toBe(true);
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
    expect(row2.indexOf("moh")).toBeLessThan(row2.indexOf("▣"));
  });

  test("short form at narrow widths; rows stay within the viewport", () => {
    const frame = renderBar({ width: 46, mode: "dev", cwd: "/long/path/to/project", branch: "develop", permissionMode: "yolo" });
    const row2 = frame.split("\n").find((l) => l.includes("⎇"))!;
    // the lead never elides below the glyph.
    expect(row2.trimStart().startsWith("⚠")).toBe(true);
    expect(row2).toContain("◉ dev");
    for (const line of frame.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(45);
  });
});
