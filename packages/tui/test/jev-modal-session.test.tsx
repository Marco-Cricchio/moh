/**
 * #833: the modal against a **real** extension in a **real** session — the
 * wiring `App.tsx` uses (`read` = the session's own `state` seam, `send` =
 * the ADR-0038 control channel), with the bundle the TUI actually mounts.
 *
 * This is the seam a component fixture cannot cover: the vocabulary the modal
 * reads and the grammar it sends are the extension's own (#832), so the two
 * ends are checked against each other rather than against a stub.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFromConfig, userConfigFile } from "@moh/core";
import type { JevUseCase, JevUseCaseAction } from "@moh/jev-guard";
import { BUNDLED_EXTENSION_SOURCES } from "../src/bundled-extensions";
import { JEV_EXTENSION_NAME, setJevUseCase } from "../src/jev-control";
import { JevModal } from "../src/JevModal";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function assembled(config: Record<string, unknown>) {
  const home = tmpDir("moh-jev-modal-home-");
  mkdirSync(join(home, ".moh"), { recursive: true });
  writeFileSync(userConfigFile(home), JSON.stringify({ typesafe: config }));
  const assembled = sessionFromConfig({
    cwd: tmpDir("moh-jev-modal-cwd-"),
    home,
    config: { provider: "mock" },
    bundledExtensions: BUNDLED_EXTENSION_SOURCES,
  });
  if ("error" in assembled) throw new Error(assembled.error.message);
  // The extension is registered fire-and-forget; its hooks and `state` are
  // in place from the first dispatch, so one turn is enough to settle.
  await assembled.session.send("hello");
  return assembled;
}

describe("the /jev modal on a real session (#833)", () => {
  test("a flip commands the extension and the log carries the session-only line", async () => {
    const { session } = await assembled({ apiKey: "sk-test" });
    const reads: string[] = [];
    const sent: { usecase: JevUseCase; action: JevUseCaseAction }[] = [];
    const i = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <JevModal
          active={session.extensionNames().includes(JEV_EXTENSION_NAME)}
          read={(extension, key) => {
            reads.push(key);
            return session.extensionState(extension, key);
          }}
          send={(usecase, action) => {
            sent.push({ usecase, action });
            setJevUseCase(session, usecase, action);
          }}
          onClose={() => {}}
        />
      </ThemeProvider>,
    );
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("guardrail");
    expect(frame).toContain("config on"); // the key is the guardrail's switch
    expect(frame).toContain("config off"); // injection starts off

    // Flip the anti-injection row (index 3, after guardrail/routing/class).
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\r");
    // The channel is asynchronous: the extension answers one dispatch later.
    await sleep(120);

    expect(sent).toEqual([{ usecase: "injection", action: "on" }]);
    // The extension answered: the modal re-read it and says it is session-only.
    expect(reads).toContain("jevState");
    const after = stripAnsi(i.lastFrame() ?? "").replace(/[\s│]+/g, " ");
    expect(after).toContain("on for this session — the config still says off");

    // The command is in the log (ADR-0038) and the extension's own line too.
    const events = session.history();
    expect(events.some((e) => e.type === "extension_control")).toBe(true);
    expect(
      events.some((e) => e.type === "extension_event" && e.name === "jev_usecase"),
    ).toBe(true);
    i.unmount();
    await session.dispose();
  });

  test("with no key the modal is the way to Settings: no rows, no command possible", async () => {
    const { session } = await assembled({});
    expect(session.extensionNames()).not.toContain(JEV_EXTENSION_NAME);
    const i = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <JevModal
          active={session.extensionNames().includes(JEV_EXTENSION_NAME)}
          read={session.extensionState.bind(session)}
          send={(usecase, action) => setJevUseCase(session, usecase, action)}
          onClose={() => {}}
        />
      </ThemeProvider>,
    );
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("not active in this session");
    expect(frame).toContain("API key");
    expect(frame).not.toContain("guardrail");
    // Nothing was appended: an inactive Jev is not a command target.
    expect(session.history().some((e) => e.type === "extension_control")).toBe(false);
    i.unmount();
    await session.dispose();
  });
});
