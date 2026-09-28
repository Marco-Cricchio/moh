/**
 * #1042: the Settings sub-menus must fit the terminal. The Jev sub-menu
 * rendered ~41 rows on a 24-row terminal — the parent list, the sub rows,
 * the scope/disclosure paragraph and the footer all stacked in one dialog —
 * and a frame that reaches `stdout.rows` sends Ink down its fullscreen path
 * (clearTerminal + static reprint per render: the #622 flicker root cause).
 *
 * These tests mount `SettingsPanel` directly and stub the viewport, no PTY
 * needed: the frame's non-empty line count must stay strictly below the
 * terminal height at the small geometry the bug was reported at.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsPanel } from "../src/SettingsPanel";
import { DEFAULT_USER_CONFIG } from "../src/user-config";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "moh-sub-h-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "moh-sub-h-home-"));
  writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
  return { cwd, home };
}

function mount(cwd: string, home: string, rows: number) {
  const i = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
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
      />
    </ThemeProvider>,
  );
  Object.defineProperty(i.stdout, "columns", { value: 80, configurable: true });
  Object.defineProperty(i.stdout, "rows", { value: rows, configurable: true });
  i.stdout.emit("resize");
  return i;
}

const frameLines = (i: ReturnType<typeof render>) =>
  stripAnsi(i.lastFrame() ?? "").split("\n").filter((l) => l.trim().length > 0);

const gotoRow = async (i: ReturnType<typeof render>, label: string) => {
  for (let k = 0; k < 24; k++) {
    const on = frameLines(i).some((l) => l.includes("›") && l.includes(label));
    if (on) return;
    i.stdin.write("\x1b[B");
    await sleep(25);
  }
  throw new Error(`row "${label}" was not reachable by label`);
};

describe("settings sub-menu height (#1042)", () => {
  for (const rows of [24, 40]) {
    test(`the Jev sub-menu fits a ${rows}-row terminal`, async () => {
      const { cwd, home } = setup();
      const i = mount(cwd, home, rows);
      await sleep(50);
      await gotoRow(i, "Jev (TypeSafe)");
      i.stdin.write("\r"); // open the sub-menu
      await sleep(50);
      const lines = frameLines(i);
      expect(lines.some((l) => l.includes("API key"))).toBe(true);
      if (rows >= 40) {
        // Ample height: all ten rows, the cursor description and the full
        // scope/disclosure paragraph are shown.
        expect(lines.some((l) => l.includes("Remove"))).toBe(true);
        expect(lines.some((l) => l.includes("persistent"))).toBe(true);
        expect(lines.some((l) => l.includes("disclosures truncated"))).toBe(false);
      } else {
        // #1042: a short terminal windows the sub-menu rows exactly like the
        // top-level list windows at small heights — the frame stays under
        // the terminal size instead of tripping Ink's fullscreen path, and
        // the `↓ N more` indicator keeps the hidden rows reachable.
        expect(lines.some((l) => l.includes("more"))).toBe(true);
      }
      expect(lines.length).toBeLessThan(rows);
      i.unmount();
    });

    test(`the fallback sub-menu fits a ${rows}-row terminal`, async () => {
      const { cwd, home } = setup();
      const i = mount(cwd, home, rows);
      await sleep(50);
      await gotoRow(i, "Fallback models");
      i.stdin.write("\r");
      await sleep(50);
      const lines = frameLines(i);
      expect(lines.length).toBeLessThan(rows);
      i.unmount();
    });

    test(`the endpoint sub-menu fits a ${rows}-row terminal`, async () => {
      const { cwd, home } = setup();
      const i = mount(cwd, home, rows);
      await sleep(50);
      await gotoRow(i, "Provider");
      i.stdin.write("\r");
      await sleep(50);
      const lines = frameLines(i);
      expect(lines.some((l) => l.includes("mock"))).toBe(true);
      expect(lines.length).toBeLessThan(rows);
      i.unmount();
    });
  }
});
