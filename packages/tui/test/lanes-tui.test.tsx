/**
 * ADR-0060: the lanes modal in the TUI — feature groups with each lane's
 * status, branch, base freshness and worktree health, read from the
 * user-owned registry at open time; and the /lanes slash-command
 * discoverability wiring. Component-level fixtures only: a real temp
 * registry backs the modal, but no git operations run here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { DevelopmentLaneStore } from "@moh/core";
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
    expect(out).toContain("feature/auth-2");
    expect(out).toContain("←"); // stack parent marker
    expect(out).toContain("issue #42 auth flow");
    expect(out).toContain("conflicted");
    expect(out).toContain("worktree MISSING");
    expect(out).toContain("base develop");
    expect(out).toContain("abc123de");
    expect(out).toContain("0d");
    expect(out).toContain("moh lanes integrate");
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
});
