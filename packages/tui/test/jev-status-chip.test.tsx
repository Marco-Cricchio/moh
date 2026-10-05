/**
 * #876: the Jev chip on the bottom bar's first row.
 *
 * The seven use cases are independent, so the chip is a *summary* — at least
 * one judging (fully or partially) / none judging / structurally unable to
 * act / in outage — and the detail stays in `/jev`. What these tests pin: the
 * compact glyph form, the absence of any claim when there is no snapshot, the
 * chip's place at the end of the left cluster, and the wiring that feeds it
 * (the client's own 2s poll of the extension's `state`, never `setStatus`).
 */
import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, userConfigFile } from "@moh/core";
import { JEV_USE_CASES, type JevUseCase, type JevUseCaseSnapshot, type JevUseCaseState } from "@moh/jev-guard";
import { BottomBar } from "../src/BottomBar";
import { App } from "../src/App";
import { readJevSummary, resolveJevChip, summarizeJevStatus } from "../src/jev-control";
import { ThemeProvider, THEMES } from "../src/themes";
import { stripAnsi, waitForCondition } from "./helpers";

/** A full snapshot, everything off but the given overrides. */
function snapshot(overrides: Partial<Record<JevUseCase, JevUseCaseState>> = {}): JevUseCaseSnapshot {
  const out = {} as Record<JevUseCase, JevUseCaseState>;
  for (const usecase of JEV_USE_CASES) out[usecase] = { status: "off", config: false };
  return { ...out, ...overrides };
}

const allIn = (status: JevUseCaseState["status"]): JevUseCaseSnapshot => {
  const out = {} as Record<JevUseCase, JevUseCaseState>;
  for (const usecase of JEV_USE_CASES) out[usecase] = { status, config: false };
  return out;
};

describe("summarizeJevStatus (#876)", () => {
  test("no snapshot = no claim", () => {
    expect(summarizeJevStatus(null)).toBeNull();
    expect(summarizeJevStatus({} as JevUseCaseSnapshot)).toBeNull();
  });

  test("at least one use case judging and none switched off = active", () => {
    expect(summarizeJevStatus({ ...allIn("inert"), routing: { status: "on", config: true } })).toBe("active");
  });

  test("some judging, at least one off or paused = partial (the user's own opt-out must not hide)", () => {
    expect(summarizeJevStatus(snapshot({ guardrail: { status: "on", config: true } }))).toBe("partial");
    expect(summarizeJevStatus({ ...allIn("inert"), guardrail: { status: "on", config: true }, routing: { status: "paused", config: true } })).toBe("partial");
  });

  test("none judging, at least one off or paused = off", () => {
    expect(summarizeJevStatus(snapshot())).toBe("off");
    expect(summarizeJevStatus({ ...allIn("inert"), routing: { status: "paused", config: true } })).toBe("off");
    expect(summarizeJevStatus({ ...allIn("inert"), lint: { status: "off", config: false } })).toBe("off");
  });

  test("none judging and none off: every one structurally unable = inert", () => {
    expect(summarizeJevStatus(allIn("inert"))).toBe("inert");
  });

  test("readJevSummary reads the extension's own snapshot, never throws", () => {
    const read = (_extension: string, key: string) =>
      key === "jevState" ? () => snapshot({ guardrail: { status: "on", config: true } }) : undefined;
    expect(readJevSummary(read)).toBe("partial");
    // Not registered, a throwing getter, a non-object: all = no claim.
    expect(readJevSummary(undefined)).toBeNull();
    expect(readJevSummary(() => { throw new Error("gone"); })).toBeNull();
    expect(readJevSummary(() => "nonsense")).toBeNull();
  });
});

describe("the Jev chip in row 1 (#876)", () => {
  const base = { width: 120, pending: false, spinner: "⠸", mode: "dev" as const, model: "mock", turns: 0, tokens: { contextIn: 0, totalOut: 0, calls: 0 }, level: "default" as const, focusedChip: null };

  const barFrame = (props: Record<string, unknown>) => {
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><BottomBar {...(base as any)} {...(props as any)} /></ThemeProvider>);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    ink.unmount();
    return frame;
  };

  const row1 = (frame: string) => frame.split("\n").find((line) => line.includes("· ready"))!;

  test("one word per state, in wide and regular terminals", () => {
    expect(row1(barFrame({ jevStatus: "active" }))).toContain("◈ jev active");
    expect(row1(barFrame({ jevStatus: "partial" }))).toContain("◈ jev partial");
    expect(row1(barFrame({ jevStatus: "off" }))).toContain("◈ jev off");
    expect(row1(barFrame({ jevStatus: "inert" }))).toContain("◈ jev inert");
    expect(row1(barFrame({ jevStatus: "offline" }))).toContain("◈ jev offline");
    expect(row1(barFrame({ jevStatus: "auth" }))).toContain("◈ jev auth");
  });

  test("compact keeps the glyph and drops the word", () => {
    for (const status of ["active", "partial", "off", "inert", "offline", "auth"] as const) {
      const frame = barFrame({ width: 60, jevStatus: status });
      const line = frame.split("\n").find((l) => l.includes("◈"))!;
      expect(line).toContain("◈");
      // neither the extension's name nor the state's own word survives.
      expect(line).not.toContain("jev");
      expect(line).not.toContain(status);
    }
  });

  test("no chip without a snapshot: nothing renders, never a placeholder", () => {
    expect(barFrame({ jevStatus: null })).not.toContain("◈");
    expect(barFrame({})).not.toContain("◈");
  });

  test("the chip sits last in the left cluster, after memory, MPM and extension statuses", () => {
    const frame = barFrame({
      memoryFresh: true,
      mpmStatus: "ready",
      extensionStatuses: [{ extension: "jev-guard", text: "∅ jev offline" }],
      jevStatus: "inert",
    });
    const line = row1(frame);
    expect(line.indexOf("◍ memory")).toBeLessThan(line.indexOf("✓ map"));
    expect(line.indexOf("✓ map")).toBeLessThan(line.indexOf("∅ jev offline"));
    expect(line.indexOf("∅ jev offline")).toBeLessThan(line.indexOf("◈ jev inert"));
  });

  test("an outage overrides the snapshot: the chip never says active while down", () => {
    expect(resolveJevChip("active", [{ extension: "jev-guard", text: "∅ jev offline" }])).toBe("offline");
    expect(resolveJevChip("partial", [{ extension: "jev-guard", text: "∅ jev offline" }])).toBe("offline");
    expect(resolveJevChip("off", [{ extension: "jev-guard", text: "∅ jev offline" }])).toBe("offline");
    // #1207: a rejected key is the other client failure, and overrides too —
    // `active` next to `∅ jev key rejected` would be the same lie.
    expect(resolveJevChip("active", [{ extension: "jev-guard", text: "∅ jev key rejected" }])).toBe("auth");
    expect(resolveJevChip("partial", [{ extension: "jev-guard", text: "∅ jev key rejected" }])).toBe("auth");
    // Another extension's status, or a jev-guard note that is not a failure
    // text, never overrides.
    expect(resolveJevChip("active", [{ extension: "other-ext", text: "∅ jev offline" }])).toBe("active");
    expect(resolveJevChip("active", [{ extension: "jev-guard", text: "jev-guard: some turn note" }])).toBe("active");
    // No snapshot: still no claim, outage or not.
    expect(resolveJevChip(null, [{ extension: "jev-guard", text: "∅ jev offline" }])).toBeNull();
  });

  test("the outage text and the chip coexist: two seams, one reading", () => {
    // The bar renders both; the chip's word is resolved upstream (App passes
    // `offline`, the outage chip keeps its own seam).
    const frame = barFrame({ extensionStatuses: [{ extension: "jev-guard", text: "∅ jev offline" }], jevStatus: "offline" });
    const line = row1(frame);
    expect(line).toContain("∅ jev offline");
    expect(line).toContain("◈ jev offline");
  });
});

describe("the Jev chip on a real session (#876)", () => {
  // The real keychain on a dev machine can hold a `typesafe` credential that
  // a tmp `home` cannot isolate — pin the bounded file store for the whole
  // describe (the documented test switch), so "not configured" stays honest.
  const prevSecretStore = process.env.MOH_SECRET_STORE;
  beforeEach(() => {
    process.env.MOH_SECRET_STORE = "file";
  });
  afterAll(() => {
    if (prevSecretStore === undefined) delete process.env.MOH_SECRET_STORE;
    else process.env.MOH_SECRET_STORE = prevSecretStore;
  });

  const home = (config?: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "moh-876-jev-"));
    mkdirSync(join(dir, ".moh"), { recursive: true });
    if (config) writeFileSync(userConfigFile(dir), JSON.stringify(config));
    return dir;
  };

  test("the poll reads the extension through the session's state seam", async () => {
    // The reader the client poll uses is the session's own `extensionState`,
    // never a Jev-specific channel: a configured extension shows up through
    // the bundled source the TUI actually mounts.
    const dir = home({ typesafe: { apiKey: "sk-test" } });
    const provider = MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]);
    const i = render(<App intro={false} cwd={mkdtempSync(join(tmpdir(), "moh-876-app-"))} home={dir} provider={provider} startInChat skipOnboarding />);
    const frameText = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForCondition(() => frameText().includes("◈ jev"), () => "the Jev chip never rendered", { timeoutMs: 5_000 });
      expect(frameText()).toMatch(/◈ jev (active|partial|off|inert|offline)/);
    } finally {
      i.unmount();
    }
  });

  test("no chip at all when Jev is not configured", async () => {
    const dir = home();
    const provider = MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]);
    const i = render(<App intro={false} cwd={mkdtempSync(join(tmpdir(), "moh-876-app-"))} home={dir} provider={provider} startInChat skipOnboarding />);
    const frameText = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForCondition(() => frameText().includes("vibe"), () => "chat never opened");
      await new Promise((r) => setTimeout(r, 120));
      expect(frameText()).not.toContain("◈ jev");
    } finally {
      i.unmount();
    }
  });
});
