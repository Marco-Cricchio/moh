import "./faketty/ci-mask";
/**
 * #1674: Frontier, SettingsPanel and ManualModal fit the viewport — both
 * borders included — because their list window is what is left after the
 * rows actually drawn around it, not `rows - 8`. In-process fake tty: the
 * frame is the real screen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrackerBackend, TrackerIssue } from "@moh/core";
import { renderOnFakeTty, type FakeTerminal } from "./faketty/render";
import { Frontier } from "../src/Frontier";
import { ManualModal } from "../src/ManualModal";
import { SettingsPanel } from "../src/SettingsPanel";
import { DEFAULT_USER_CONFIG } from "../src/user-config";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";

const open: FakeTerminal[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.unmount();
});

function mount(node: React.ReactElement, rows: number, cols: number) {
  const tty = renderOnFakeTty(<ThemeProvider value={THEMES[DEFAULT_THEME]}>{node}</ThemeProvider>, { cols, rows });
  open.push(tty);
  return tty;
}

function expectFits(tty: FakeTerminal, rows: number): string {
  const lines = tty.screen.lines().map((l) => l.trimEnd());
  const top = lines.findIndex((l) => l.includes("╭"));
  const bottom = lines.findIndex((l) => l.includes("╰"));
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeGreaterThan(top);
  expect(bottom - top + 1).toBeLessThanOrEqual(rows);
  expect(tty.maxFrameRows()).toBeLessThanOrEqual(rows);
  return lines.join("\n");
}

const issues = (deps: boolean): TrackerIssue[] =>
  Array.from({ length: 80 }, (_, i) => ({
    id: String(i + 1),
    title: `Issue ${i + 1}`,
    state: "open",
    labels: [],
    assignees: i % 7 === 0 ? ["@me"] : [],
    blockedBy: deps && i % 3 === 0 && i > 0 ? [String(i)] : [],
  }));

const backendOf = (list: TrackerIssue[], kind: TrackerBackend["kind"]): TrackerBackend => ({
  kind,
  async list() {
    return list;
  },
  async claim() {},
  async unclaim() {},
});

describe("#1674 modals fit the viewport", () => {
  // 80 columns at the usual heights, plus a narrow terminal where the footers
  // wrap and a short one where the window sits at its floor.
  for (const [cols, rows] of [[80, 24], [80, 30], [80, 50], [80, 12], [40, 24], [40, 16]] as const) {
    for (const [label, deps, kind] of [["flat", false, "gh"], ["grouped", true, "local-markdown"]] as const) {
      test(`Frontier, ${label} list of 80 issues at ${cols}x${rows}: both borders, frame ≤ viewport`, async () => {
        const tty = mount(<Frontier backend={backendOf(issues(deps), kind)} onToast={() => {}} onClose={() => {}} />, rows, cols);
        await tty.settle();
        expectFits(tty, rows);
        for (let i = 0; i < 79; i++) tty.write("\x1b[B");
        await tty.settle();
        expectFits(tty, rows);
      });
    }

    test(`SettingsPanel at ${cols}x${rows}: both borders, frame ≤ viewport`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "moh-fit-cwd-"));
      const home = mkdtempSync(join(tmpdir(), "moh-fit-home-"));
      writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
      const tty = mount(
        <SettingsPanel
          cwd={cwd}
          home={home}
          config={DEFAULT_USER_CONFIG}
          onChange={() => {}}
          modelLabel="mock"
          onProviderSwitch={() => {}}
          onStartWizard={() => {}}
          onToast={() => {}}
          onClose={() => {}}
        />,
        rows,
        cols,
      );
      await tty.settle();
      expectFits(tty, rows);
      for (let i = 0; i < 60; i++) tty.write("\x1b[B");
      await tty.settle();
      expectFits(tty, rows);
    });

    test(`ManualModal index at ${cols}x${rows}: both borders, frame ≤ viewport`, async () => {
      const tty = mount(<ManualModal onClose={() => {}} />, rows, cols);
      await tty.settle();
      expectFits(tty, rows);
      for (let i = 0; i < 60; i++) tty.write("\x1b[B");
      await tty.settle();
      expectFits(tty, rows);
    });
  }
});
