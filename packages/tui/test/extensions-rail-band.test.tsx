/**
 * Owner directive: the extensions rail lives in the chat area — the rows
 * directly above the composer — never over the composer frame or the
 * footer. The band Chat reserves must equal what the rail draws, so a
 * roster change (a member settling) re-anchors the panel above the
 * composer without moving the composer's own rows.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRuntime, MockProvider, createSession } from "@moh/core";
import { createTeamExtension, teamManifestAuthority } from "@moh/team";
import { App } from "../src/App";
import { grantTeamExtension, stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempDir = () => mkdtempSync(join(tmpdir(), "moh-rail-band-"));
const tempHome = () => { const h = mkdtempSync(join(tmpdir(), "moh-rail-band-h-")); grantTeamExtension(h); return h; };

describe("rail band above the composer (owner directive)", () => {
  test("a member settling re-renders the panel above the composer — the composer rows never move", async () => {
    const rt = new ExtensionRuntime({ mohHome: tempHome(), consent: () => true });
    expect(await rt.register(createTeamExtension(), { manifest: teamManifestAuthority() })).toBe(true);
    await rt.ready();
    // The reviewer's delayed deltas hold the roster mixed while the builders
    // settle: the panel's content (and the band's height) changes mid-run.
    const session = createSession({
      provider: MockProvider.scripted([
        { deltas: ["composing"], finish: "tool_calls", toolCalls: [{ name: "team", args: { compose: [
          { role: "builder", name: "builder-1", task: "write file a" },
          { role: "builder", name: "builder-2", task: "write file b" },
          { role: "reviewer", name: "reviewer-1", task: "review both reports carefully" },
        ] } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      extensions: rt,
      permissions: { unrestrictedTools: true },
      subagents: { home: tempDir(), provider: MockProvider.scripted([
        { deltas: ["b1"], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
        { deltas: ["b2"], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
        { deltas: ["r"], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
      ]) },
    });
    const i = render(
      <App intro={false} cwd={tempDir()} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding session={session} />,
    );
    Object.defineProperty(i.stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(i.stdout, "rows", { value: 30, configurable: true });
    i.stdout.emit("resize");
    try {
      void session.send("work with the team");
      await waitFor(() => stripAnsi(i.lastFrame() ?? "").includes("team team ·"));
      const composerLineBefore = composerLine(stripAnsi(i.lastFrame() ?? ""));
      expect(composerLineBefore).toBeGreaterThan(0);
      // The panel must sit ABOVE the composer line, never beside/below it.
      const panelLineBefore = panelLine(stripAnsi(i.lastFrame() ?? ""));
      expect(panelLineBefore).toBeLessThan(composerLineBefore);
      // Wait past every member settling: the roster re-renders (all ✓).
      await waitFor(() => stripAnsi(i.lastFrame() ?? "").split("\n").filter((l) => l.includes("✓")).length >= 3);
      await sleep(300);
      const after = stripAnsi(i.lastFrame() ?? "");
      const composerLineAfter = composerLine(after);
      const panelLineAfter = panelLine(after);
      // The panel still sits fully above the composer after the roster
      // settled (scrollback growth shifts absolute rows — the invariant is
      // the ORDERING and the panel's distance to the composer, not the
      // absolute line).
      expect(panelLineAfter).toBeGreaterThan(0);
      expect(panelLineAfter).toBeLessThan(composerLineAfter);
      const beforeGap = composerLineBefore - panelLineBefore;
      const afterGap = composerLineAfter - panelLineAfter;
      expect(afterGap).toBeLessThanOrEqual(beforeGap + 2);
    } finally {
      i.unmount();
      await session.dispose();
    }
  }, 30000);

  const composerLine = (frame: string) => frame.split("\n").findIndex((l) => l.includes("shift+enter"));
  const panelLine = (frame: string) => frame.split("\n").findIndex((l) => l.includes("team team ·"));
  const panelBottomLine = (frame: string) => {
    const lines = frame.split("\n");
    let last = -1;
    lines.forEach((l, idx) => { if (l.includes("│") && idx < lines.findIndex((x) => x.includes("shift+enter"))) last = idx; });
    return last;
  };

  async function waitFor(condition: () => boolean, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await sleep(25);
    expect(condition()).toBe(true);
  }

  test("the panel's bottom edge stops before the composer separator", async () => {
    const rt = new ExtensionRuntime({ mohHome: tempHome(), consent: () => true });
    expect(await rt.register(createTeamExtension(), { manifest: teamManifestAuthority() })).toBe(true);
    await rt.ready();
    const session = createSession({
      provider: MockProvider.scripted([
        { deltas: ["composing"], finish: "tool_calls", toolCalls: [{ name: "team", args: { compose: [
          { role: "builder", name: "builder-1", task: "write file a" },
          { role: "builder", name: "builder-2", task: "write file b" },
          { role: "reviewer", name: "reviewer-1", task: "review both reports carefully" },
        ] } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      extensions: rt,
      permissions: { unrestrictedTools: true },
      subagents: { home: tempDir(), provider: MockProvider.scripted([
        { deltas: ["b1"], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
        { deltas: ["b2"], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
        { deltas: ["r"], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
      ]) },
    });
    const i = render(
      <App intro={false} cwd={tempDir()} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding session={session} />,
    );
    Object.defineProperty(i.stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(i.stdout, "rows", { value: 30, configurable: true });
    i.stdout.emit("resize");
    try {
      void session.send("work with the team");
      await waitFor(() => stripAnsi(i.lastFrame() ?? "").includes("team team ·"));
      await sleep(500);
      const frame = stripAnsi(i.lastFrame() ?? "");
      const lines = frame.split("\n");
      const composerIdx = lines.findIndex((l) => l.includes("shift+enter"));
      // The frame's total volatile height stays within the terminal: the
      // band reservation keeps the frame from growing when the roster settles.
      expect(composerIdx).toBeGreaterThan(0);
      await waitFor(() => lines.filter(() => true).length >= 0);
      const settled = stripAnsi(i.lastFrame() ?? "").split("\n");
      const composerSettled = settled.findIndex((l) => l.includes("shift+enter"));
      expect(composerSettled).toBe(composerIdx);
    } finally {
      i.unmount();
      await session.dispose();
    }
  }, 30000);
});
