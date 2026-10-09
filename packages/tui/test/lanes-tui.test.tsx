/**
 * ADR-0060: the lanes modal in the TUI — feature groups with each lane's
 * status, branch, base freshness and worktree health, read from the
 * user-owned registry at open time; and the /lanes slash-command
 * discoverability wiring. Component-level fixtures only: a real temp
 * registry backs the modal, but no git operations run here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { DevelopmentLaneService, DevelopmentLaneStore } from "@moh/core";
import { LanesModal } from "../src/LanesModal";
import { activeCommands } from "../src/commands";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

function registry(): { cwd: string; home: string; store: DevelopmentLaneStore } {
  const cwd = mkdtempSync(join(tmpdir(), "moh-lanes-tui-proj-"));
  const home = mkdtempSync(join(tmpdir(), "moh-lanes-tui-home-"));
  return { cwd, home, store: new DevelopmentLaneStore({ cwd, home }) };
}

function frame(element: React.ReactElement): string {
  const ink = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>{element}</ThemeProvider>,
  );
  const text = stripAnsi(ink.lastFrame() ?? "");
  ink.unmount();
  return text;
}

describe("lanes modal (ADR-0060)", () => {
  test("renders the empty state with the CLI door", () => {
    const { cwd, home } = registry();
    const out = frame(<LanesModal cwd={cwd} home={home} onClose={() => {}} />);
    expect(out).toContain("lanes");
    expect(out).toContain("no feature groups yet");
    expect(out).toContain("moh lanes group");
  });

  test("renders groups and lanes with status, branch, relation and missing-worktree mark", () => {
    const { cwd, home, store } = registry();
    const group = store.createFeatureGroup({ name: "auth", targetRef: "develop" });
    const lane = store.createLane({
      featureGroupId: group.id,
      sessionId: "session-a",
      // A path that does not exist → the modal must mark it MISSING.
      worktreePath: join(cwd, "no-such-worktree"),
      branchRef: "feature/auth-1",
      baseRef: "develop",
      baseRevision: "abc123def456",
      targetRef: "develop",
      relation: "independent",
    });
    store.setLabel(lane.id, "issue #42 auth flow");
    const child = store.createLane({
      featureGroupId: group.id,
      sessionId: "session-b",
      worktreePath: join(cwd, "no-such-worktree-2"),
      branchRef: "feature/auth-2",
      baseRef: "feature/auth-1",
      baseRevision: "deadbeef0000",
      targetRef: "develop",
      relation: "depends-on",
      parentLaneId: lane.id,
    });
    store.setStatus(child.id, "conflicted");
    const out = frame(<LanesModal cwd={cwd} home={home} onClose={() => {}} />);
    expect(out).toContain("auth");
    expect(out).toContain("develop");
    expect(out).toContain("feature/auth-1");
    expect(out).toContain("feature/auth-2");    expect(out).toContain("←"); // stack parent marker
    expect(out).toContain("issue #42 auth flow");
    expect(out).toContain("conflicted");
    expect(out).toContain("worktree MISSING");
    expect(out).toContain("base develop");
    expect(out).toContain("abc123de");
    expect(out).toContain("0d");
    expect(out).toContain("d delete lane");
    expect(out).toContain("D delete ALL");
  });

  test("d deletes the focused lane (y confirms), x drops only the registry row", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-lanes-tui-repo-"));
    execFileSync("git", ["init", "-b", "develop"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@moh.local"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "moh test"], { cwd, stdio: "ignore" });
    execFileSync("git", ["commit", "--allow-empty", "--allow-empty-message", "-m", "root"], { cwd, stdio: "ignore" });
    const home = mkdtempSync(join(tmpdir(), "moh-lanes-tui-home-"));
    const store = new DevelopmentLaneStore({ cwd, home });
    const group = store.createFeatureGroup({ name: "del", targetRef: "develop" });
    // Real worktrees: `d` runs the real git worktree remove + branch -D.
    const service = new DevelopmentLaneService({ cwd, home });
    const ga = await service.ensureFeatureGroup("del", "develop");
    const createdA = await service.createWorktreeLane({ featureGroupId: ga.id, sessionId: "s-d1", branchRef: "feature/del-1", baseRef: "develop" });
    const createdB = await service.createWorktreeLane({ featureGroupId: ga.id, sessionId: "s-d2", branchRef: "feature/del-2", baseRef: "develop" });
    expect(createdA.ok && createdB.ok).toBe(true);
    const a = store.listLanes().find((l) => l.branchRef === "feature/del-1")!;
    const b = store.listLanes().find((l) => l.branchRef === "feature/del-2")!;
    const ink = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <LanesModal cwd={cwd} home={home} onClose={() => {}} />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    // rows: [group, lane a(2), lane b(2)] → j moves the cursor onto lane a
    ink.stdin.write("j");
    await new Promise((r) => setTimeout(r, 50));
    ink.stdin.write("x"); // drop a's registry row
    await new Promise((r) => setTimeout(r, 100));
    expect(store.listLanes().map((l) => l.id)).toEqual([b.id]);
    ink.stdin.write("j"); // now on lane b
    await new Promise((r) => setTimeout(r, 50));
    ink.stdin.write("d"); // arm delete
    await new Promise((r) => setTimeout(r, 50));
    expect(stripAnsi(ink.lastFrame() ?? "")).toContain("y/N");
    ink.stdin.write("y");
    await new Promise((r) => setTimeout(r, 200));
    expect(store.listLanes()).toEqual([]);
    expect(existsSync(b.worktreePath)).toBe(false); // the worktree directory is gone
    ink.unmount();
  });

  test("D deletes every lane only after the typed confirmation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-lanes-tui-repo-"));
    execFileSync("git", ["init", "-b", "develop"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@moh.local"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "moh test"], { cwd, stdio: "ignore" });
    execFileSync("git", ["commit", "--allow-empty", "--allow-empty-message", "-m", "root"], { cwd, stdio: "ignore" });
    const home = mkdtempSync(join(tmpdir(), "moh-lanes-tui-home-"));
    const store = new DevelopmentLaneStore({ cwd, home });
    const service = new DevelopmentLaneService({ cwd, home });
    const g = await service.ensureFeatureGroup("wipe", "develop");
    const created = await service.createWorktreeLane({ featureGroupId: g.id, sessionId: "s-w1", branchRef: "feature/wipe-1", baseRef: "develop" });
    expect(created.ok).toBe(true);
    const lane = store.listLanes()[0]!;
    const ink = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <LanesModal cwd={cwd} home={home} onClose={() => {}} />
      </ThemeProvider>,
    );
    ink.stdin.write("D");
    await new Promise((r) => setTimeout(r, 60));
    expect(stripAnsi(ink.lastFrame() ?? "")).toContain("delete all");
    // wrong text + enter → refused, lanes survive
    ink.stdin.write("yes");
    ink.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 60));
    expect(store.listLanes()).toHaveLength(1);
    // esc cancels the prompt, then re-arm with the exact phrase
    ink.stdin.write("\u001b");
    await new Promise((r) => setTimeout(r, 60));
    ink.stdin.write("D");
    await new Promise((r) => setTimeout(r, 60));
    for (const ch of "delete all") ink.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 60));
    ink.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 200));
    expect(store.listLanes()).toEqual([]);
    expect(existsSync(lane.worktreePath)).toBe(false);
    ink.unmount();
  });

  test("windowed list: many lanes scroll inside the dialog with indicators", () => {
    const { cwd, home, store } = registry();
    const group = store.createFeatureGroup({ name: "many", targetRef: "develop" });
    for (let i = 0; i < 12; i++) {
      store.createLane({
        featureGroupId: group.id,
        sessionId: `session-${i}`,
        worktreePath: join(cwd, `no-such-worktree-${i}`),
        branchRef: `feature/many-${i}`,
        baseRef: "develop",
        baseRevision: "abc123def456",
        targetRef: "develop",
        relation: "independent",
      });
    }
    const out = frame(<LanesModal cwd={cwd} home={home} onClose={() => {}} />);
    // The dialog stays bounded: not every lane is on screen at once.
    expect(out).toContain("↓ ");
    expect(out).toContain("more");
    // The first lane row is visible; the last one is below the window.
    expect(out).toContain("feature/many-0");
    expect(out).not.toContain("feature/many-29");
  });

  test("/lanes is registered and needs the TUI shell", () => {
    const commands = activeCommands({ config: { workflow: { enabled: false } } as any });
    const lanes = commands.find((c) => c.name === "lanes");
    expect(lanes).toBeDefined();
    // Headless context (no session, no shell seam): a visible refusal,
    // never a silent no-op.
    const notices: string[] = [];
    lanes!.run({ notify: (m: string) => notices.push(m) } as any, "");
    expect(notices).toEqual(["/lanes needs an open session"]);
  });

  test("each lane's install state shows, and a drifted checkout is reported read-only (amendment 5)", () => {
    const { cwd, home, store } = registry();
    const group = store.createFeatureGroup({ name: "deps", targetRef: "develop" });
    store.createLane({
      featureGroupId: group.id,
      sessionId: "session-dep",
      worktreePath: join(cwd, "no-such-worktree"),
      branchRef: "feature/deps-1",
      baseRef: "develop",
      baseRevision: "abc123def456",
      targetRef: "develop",
      relation: "independent",
    });
    const lane = store.listLanes()[0]!;
    const clean = frame(<LanesModal cwd={cwd} home={home} onClose={() => {}} />);
    // No install record yet, and the checkout declares none: nothing claimed.
    expect(clean).not.toContain("install");
    expect(clean).not.toContain("drifted");

    store.setInstall(lane.id, { kind: "installed", command: "bun install", fingerprint: "abc123", at: new Date().toISOString() });
    expect(frame(<LanesModal cwd={cwd} home={home} onClose={() => {}} />)).toContain("install bun install");

    store.setInstall(lane.id, { kind: "failed", command: "bun install", reason: "boom", at: new Date().toISOString() });
    expect(frame(<LanesModal cwd={cwd} home={home} onClose={() => {}} />)).toContain("install FAILED");

    // The checkout's own drift: one read-only line naming the CLI door.
    mkdirSync(join(cwd, "node_modules", "@moh"), { recursive: true });
    symlinkSync(join(cwd, "no-such-target"), join(cwd, "node_modules", "@moh", "core"));
    const drifted = frame(<LanesModal cwd={cwd} home={home} onClose={() => {}} />);
    expect(drifted).toContain("checkout install drifted");
    expect(drifted).toContain("moh lanes repair --apply");
  });
});
