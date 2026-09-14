/**
 * #675: startup handoff discovery must run on the Home-screen path.
 * App-level integration: App is mounted on Home (no startInChat) with
 * the factory's discoverHandoffForHome mocked to return a fixed offer
 * (the function's own gating/fetch paths are covered by
 * handoff-reception.tui.test.tsx and the core reception tests); the
 * assertion is that App invokes it and Home renders the resulting row.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import type { HandoffOffer } from "@moh/core";
import { stripAnsi, waitForFrame } from "./helpers";

const actualFactory = await import("../src/factory");

const discoveryCalls: { cwd: string; home?: string }[] = [];
const discoveryResult: { value: HandoffOffer } = { value: { status: "none" } };

mock.module("../src/factory", () => ({
  ...actualFactory,
  discoverHandoffForHome: async (cwd: string, home?: string) => {
    discoveryCalls.push({ cwd, home });
    return discoveryResult.value;
  },
}));

// Import App only after the mock is in place so it binds the mocked factory.
const { App } = await import("../src/App");

const TMP = join(import.meta.dir, "tmp-tui-handoff-home-discovery");

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  discoveryCalls.length = 0;
  discoveryResult.value = { status: "none" };
});

function project(name: string, mohJson?: unknown): { cwd: string; home: string } {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "moh-handoff-home-disc-"));
  if (mohJson !== undefined) writeFileSync(join(dir, "moh.json"), JSON.stringify(mohJson));
  return { cwd: dir, home };
}

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

describe("App → Home → handoff discovery (#675)", () => {
  test("a normal Home launch discovers and renders the offer row", async () => {
    const { cwd, home } = project("home-offer", { handoff: { transport: "gist" } });
    discoveryResult.value = OFFER;
    const i = render(<App cwd={cwd} home={home} env={{}} skipOnboarding />);
    try {
      expect(discoveryCalls.map((c) => c.cwd)).toContain(cwd);
      await waitForFrame(() => stripAnsi(i.lastFrame() ?? ""), "session handoff from another machine");
      await waitForFrame(() => stripAnsi(i.lastFrame() ?? ""), "2026-09-02 18:00");
    } finally {
      i.unmount();
    }
  });

  test("a stale handoff renders the stale marker", async () => {
    const { cwd, home } = project("home-stale", { handoff: { transport: "gist" } });
    discoveryResult.value = { ...OFFER, stale: true };
    const i = render(<App cwd={cwd} home={home} env={{}} skipOnboarding />);
    try {
      await waitForFrame(() => stripAnsi(i.lastFrame() ?? ""), "session handoff from another machine");
      await waitForFrame(() => stripAnsi(i.lastFrame() ?? ""), "stale");
    } finally {
      i.unmount();
    }
  });

  test("no discovery on the direct-chat path (startInChat)", async () => {
    const { cwd, home } = project("chat", { handoff: { transport: "gist" } });
    const i = render(<App cwd={cwd} home={home} env={{}} skipOnboarding startInChat />);
    await new Promise((r) => setTimeout(r, 50));
    try {
      expect(discoveryCalls).toEqual([]);
    } finally {
      i.unmount();
    }
  });

  test("a none result leaves Home without an offer row", async () => {
    const { cwd, home } = project("home-none", { handoff: { transport: "gist" } });
    const i = render(<App cwd={cwd} home={home} env={{}} skipOnboarding />);
    await new Promise((r) => setTimeout(r, 50));
    try {
      expect(discoveryCalls.map((c) => c.cwd)).toContain(cwd);
      expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("session handoff from");
    } finally {
      i.unmount();
    }
  });
});
