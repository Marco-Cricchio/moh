/**
 * Session Handoff T3 client wiring (#436): home-screen discovery
 * gating and the home offer row. No network: discovery is exercised
 * only in its transport-off / broken-config paths here (the fake
 * transport seam is covered by core tests); the offer row is rendered
 * from a fixed HandoffOffer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { discoverHandoffForHome } from "../src/factory";
import { Home } from "../src/Home";
import type { HandoffOffer } from "@moh/core";
import { stripAnsi } from "./helpers";

const TMP = join(import.meta.dir, "tmp-tui-handoff-t3");

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function project(name: string, mohJson?: unknown): { cwd: string; home: string } {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "moh-tui-handoff-home-"));
  if (mohJson !== undefined) writeFileSync(join(dir, "moh.json"), JSON.stringify(mohJson));
  return { cwd: dir, home };
}

describe("discoverHandoffForHome gating", () => {
  test("transport off (absent) = none — single machine unchanged", async () => {
    const { cwd, home } = project("off");
    expect(await discoverHandoffForHome(cwd, home)).toEqual({ status: "none" });
  });

  test("transport none = none (full off)", async () => {
    const { cwd, home } = project("none", { handoff: { transport: "none" } });
    expect(await discoverHandoffForHome(cwd, home)).toEqual({ status: "none" });
  });

  test("broken config = none, never a throw", async () => {
    const { cwd, home } = project("broken", { handoff: "nonsense" });
    expect(await discoverHandoffForHome(cwd, home)).toEqual({ status: "none" });
  });
});

const OFFER: Extract<HandoffOffer, { status: "offer" }> = {
  status: "offer",
  payload: {
    version: 1,
    kind: "raw",
    sessionId: "remote-9",
    updatedAt: "2026-09-02T18:00:00.000Z",
    git: { branch: "develop", head: "feed0000", dirty: false },
    turns: 4,
    lastUserMessage: "continue T3",
    lastAssistantMessage: "halfway",
    files: [],
    tests: [],
    counts: { toolCalls: 0, errors: 0, cancelled: 0 },
  },
  url: "https://gist.github.com/x",
  stale: false,
};

describe("home offer row", () => {
  test("renders the handoff row with timestamp; stale marker when stale", async () => {
    const { cwd, home } = project("row");
    const clean = render(
      <Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} handoff={OFFER} onOpenHandoff={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 30));
    const frame = stripAnsi(clean.lastFrame() ?? "");
    expect(frame).toContain("session handoff from another machine");
    expect(frame).toContain("2026-09-02 18:00");
    expect(frame).not.toContain("stale");
    clean.unmount();

    const stale = render(
      <Home
        cwd={cwd}
        home={home}
        mode="vibe"
        onOpen={() => {}}
        handoff={{ ...OFFER, stale: true }}
        onOpenHandoff={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(stripAnsi(stale.lastFrame() ?? "")).toContain("stale");
    stale.unmount();
  });

  test("no offer row without a handoff or a handler", async () => {
    const { cwd, home } = project("norow");
    const a = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} handoff={OFFER} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(stripAnsi(a.lastFrame() ?? "")).not.toContain("session handoff from");
    a.unmount();

    const b = render(
      <Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} handoff={{ status: "none" }} onOpenHandoff={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(stripAnsi(b.lastFrame() ?? "")).not.toContain("session handoff from");
    b.unmount();
  });

  test("h opens the seeded session; cursor + enter too; typing guards enter", async () => {
    const { cwd, home } = project("keys");
    const opened: unknown[] = [];
    const i = render(
      <Home
        cwd={cwd}
        home={home}
        mode="vibe"
        onOpen={() => {}}
        handoff={OFFER}
        onOpenHandoff={(o) => opened.push(o)}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    i.stdin.write("h");
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toHaveLength(1);
    // down to the handoff row, enter selects it
    i.stdin.write("\x1b[B");
    await new Promise((r) => setTimeout(r, 30));
    i.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toHaveLength(2);
    // a non-empty query guards enter (selects the typed prompt instead)
    i.stdin.write("x");
    await new Promise((r) => setTimeout(r, 30));
    i.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toHaveLength(2);
    i.unmount();
  });
});
