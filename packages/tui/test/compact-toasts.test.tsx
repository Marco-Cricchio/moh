import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { Chat, composerHintFits } from "../src/Chat";
import { makeSession } from "../src/factory";
import { Toasts, useToasts } from "../src/Toasts";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { COMPOSER_COMPACT, COMPOSER_READY, stripAnsi, unwrap } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("compact mode (issue #33)", () => {
  test("below 60 cols the placeholder shrinks and no key-tips row renders under the input", async () => {
    const { session } = unwrap(makeSession({
      cwd: process.cwd(),
      home: mkdtempSync(join(tmpdir(), "moh-cmp-")),
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
    }));
    const i = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <Chat session={session} cwd={mkdtempSync(join(tmpdir(), "moh-gitless-"))} mode="vibe" modelLabel="mock" />
      </ThemeProvider>,
    );
    Object.defineProperty(i.stdout, "columns", { value: 40, configurable: true });
    await sleep(30);
    i.rerender(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <Chat session={session} cwd={mkdtempSync(join(tmpdir(), "moh-gitless-"))} mode="vibe" modelLabel="mock" />
      </ThemeProvider>,
    );
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "").replace(/\s+/g, " ");
    // The chat column has no tips row of its own anymore (hints live in the
    // chip footer); the compact placeholder keeps the short form.
    expect(frame).toContain(COMPOSER_COMPACT);
    expect(frame).not.toContain("ctrl+j newline");
    expect(frame).not.toContain("esc steer");
    expect(frame).not.toContain("q quit");
    i.unmount();
  });

  test("at 70 cols the long hint falls back to the short form instead of wrapping", async () => {
    const { session } = unwrap(makeSession({
      cwd: process.cwd(),
      home: mkdtempSync(join(tmpdir(), "moh-cmp-")),
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
    }));
    const tree = <Chat session={session} cwd={mkdtempSync(join(tmpdir(), "moh-gitless-"))} mode="vibe" modelLabel="mock" />;
    const i = render(<ThemeProvider value={THEMES[DEFAULT_THEME]}>{tree}</ThemeProvider>);
    Object.defineProperty(i.stdout, "columns", { value: 70, configurable: true });
    await sleep(30);
    i.rerender(<ThemeProvider value={THEMES[DEFAULT_THEME]}>{tree}</ThemeProvider>);
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    // 70 cols is a "regular" class, but the composer cannot hold the hint on
    // one row there: a wrapped hint would make the empty composer two rows.
    expect(frame).toContain(`› ${COMPOSER_COMPACT}`);
    expect(frame).not.toContain(COMPOSER_READY);
    i.unmount();
  });

  test("at 80 cols the editor hint renders in the placeholder, not a tips row", async () => {
    const { session } = unwrap(makeSession({
      cwd: process.cwd(),
      home: mkdtempSync(join(tmpdir(), "moh-cmp-")),
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
    }));
    const i = render(<Chat session={session} cwd={mkdtempSync(join(tmpdir(), "moh-gitless-"))} mode="vibe" modelLabel="mock" />);
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("/ask-moh - for everything you need (shift+enter || ctrl+j newline)");
    expect(frame).not.toContain("ctrl+s settings");
    i.unmount();
  });

  test("an unusable terminal width never promotes the long hint", () => {
    // A tty whose size could not be read answers 0 columns (Linux PTY) or
    // NaN; both must take the short form — the fallback exists to protect
    // the composer, never to widen it.
    for (const columns of [0, -1, NaN, Number.POSITIVE_INFINITY, 69, 70]) {
      expect(composerHintFits(columns), `columns=${columns}`).toBe(false);
    }
    for (const columns of [71, 80, 120, 160]) {
      expect(composerHintFits(columns), `columns=${columns}`).toBe(true);
    }
  });
});

describe("toasts (issue #33)", () => {
  function Harness() {
    const { toasts, push } = useToasts();
    React.useEffect(() => {
      push("memory updated", "ok");
      push("saved settings");
    }, [push]);
    return (
      <React.Fragment>
        <Toasts toasts={toasts} />
      </React.Fragment>
    );
  }

  test("notices render inline, never as a blocking overlay", async () => {
    const i = render(<Harness />);
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("memory updated");
    expect(frame).toContain("saved settings");
    expect(frame).not.toContain("╭"); // no dialog borders
    i.unmount();
  });

  test("toasts auto-dismiss", async () => {
    const i = render(<Harness />);
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("memory updated");
    await sleep(3800);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("memory updated");
    i.unmount();
  });
});
