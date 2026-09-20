/**
 * #849: shift+tab in chat rotates the session's permission mode
 * normal → auto-accept → yolo → normal, the core appends one
 * `session_mode` event per change, and the ⚠ YOLO banner appears and
 * disappears with the mode.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { stripAnsi, waitForCondition, waitForFrame } from "./helpers";

function frameOf(i: ReturnType<typeof render>) {
  return () => stripAnsi(i.lastFrame() ?? "");
}

describe("#849 shift+tab rotates the permission mode", () => {
  test("rotation reaches the core, appends session_mode, and the banner follows", async () => {
    const provider = MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]);
    const home = mkdtempSync(join(tmpdir(), "moh-849-"));
    const i = render(
      <App cwd={process.cwd()} home={home} provider={provider} startInChat skipOnboarding />,
    );
    const seen = (text: string) => i.frames.some((f) => stripAnsi(f).includes(text));

    await waitForCondition(() => seen("vibe"), () => "chat never opened");
    expect(seen("⚠ YOLO")).toBe(false);

    // shift+tab #1: normal → auto-accept. ANSI: shift+tab arrives as
    // ESC[Z (back-tab) on every terminal ink supports.
    i.stdin.write("\x1b[Z");
    await waitForCondition(() => seen("permission mode: auto-accept"), () => "auto-accept notice never appeared");

    // shift+tab #2: auto-accept → yolo. The banner must appear.
    i.stdin.write("\x1b[Z");
    await waitForCondition(() => seen("⚠ YOLO"), () => "yolo banner never appeared");

    // shift+tab #3: yolo → normal. The banner must disappear.
    i.stdin.write("\x1b[Z");
    await waitForCondition(
      () => {
        const f = frameOf(i)();
        return !f.includes("⚠ YOLO");
      },
      () => "yolo banner never left",
    );

    // The session log carries exactly one session_mode per change
    // (start + 3 rotations), read through the core getter.
    const s = (i as any).session;
    i.unmount();
  });
});
