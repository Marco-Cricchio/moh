/**
 * #834: the TUI's side of client-loadable extensions — the enable consent.
 *
 * An extension in `~/.moh/extensions/` is arbitrary in-process code, so the
 * first load asks one question through the permission modal (the same seam
 * MCP trust uses): what it is, where it came from, and that there is no
 * sandbox. Yes enables it for good; no leaves it unloaded.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { PermissionModal } from "../src/PermissionModal";
import { PermissionGate, describePermissionRequest } from "../src/permission-gate";
import { makeSession } from "../src/factory";
import { stripAnsi, unwrap, waitForCondition, waitForFrame } from "./helpers";

const frameOf = (i: { lastFrame: () => string | undefined }) => stripAnsi(i.lastFrame() ?? "");

function homeWithExtension(name: string, body: string): string {
  const home = mkdtempSync(join(tmpdir(), "moh-ext-consent-"));
  mkdirSync(join(home, ".moh", "extensions"), { recursive: true });
  writeFileSync(join(home, ".moh", "extensions", `${name}.mjs`), body);
  return home;
}

describe("extension enable consent (#834)", () => {
  test("the view names the extension, its source and version, and carries no rule", () => {
    const view = describePermissionRequest(
      "extension",
      { name: "guard", version: "0.3.0", file: "/home/u/.moh/extensions/guard.mjs" },
      { source: "extension", extension: "guard" },
    );
    expect(view.detail).toEqual([
      "name: guard",
      "version: 0.3.0",
      "source: /home/u/.moh/extensions/guard.mjs",
      "no sandbox: it runs with moh's own privileges",
    ]);
    expect(view.rulePreview).toBeNull();
    expect(view.extensionAsk).toEqual({ extension: "guard" });
  });

  test("the modal asks about code, offers yes/no only, and 'y' loads the extension", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-ext-consent-cwd-"));
    const home = homeWithExtension(
      "guard",
      `export default { name: "guard", version: "0.3.0", apiVersion: "1.0", setup() {} };`,
    );
    const gate = new PermissionGate();
    const { session } = unwrap(
      makeSession({
        cwd,
        home,
        provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
        onPermissionRequest: gate.ask,
      }),
    );
    const i = render(<PermissionModal gate={gate} mode="dev" />);
    try {
      await waitForFrame(() => frameOf(i), "extension enable (guard)");
      const frame = frameOf(i);
      expect(frame).toContain("An extension wants to run in this session:");
      expect(frame).toContain("name: guard");
      expect(frame).toContain("version: 0.3.0");
      expect(frame).toContain("source: ");
      expect(frame).toContain("no sandbox");
      // No "always" (an extension is not a rule) and no rule preview line.
      expect(frame).not.toContain("always");
      expect(frame).not.toContain("writes the session rule");

      // `a` is inert here: the question stays up until it is answered.
      i.stdin.write("a");
      await Bun.sleep(30);
      expect(frameOf(i)).toContain("extension enable");

      i.stdin.write("y");
      await waitForCondition(
        () => session.history().some((e) => e.type === "extension_loaded"),
        () => "the extension to load after the consent",
      );
      expect(session.history().find((e) => e.type === "extension_loaded")).toMatchObject({
        name: "guard",
        version: "0.3.0",
      });
    } finally {
      i.unmount();
      await session.dispose();
    }
  });

  test("declining loads nothing and says why", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-ext-consent-cwd-"));
    const home = homeWithExtension(
      "guard",
      `export default { name: "guard", version: "0.3.0", apiVersion: "1.0", setup() {} };`,
    );
    const gate = new PermissionGate();
    const { session } = unwrap(
      makeSession({
        cwd,
        home,
        provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
        onPermissionRequest: gate.ask,
      }),
    );
    const i = render(<PermissionModal gate={gate} mode="dev" />);
    try {
      await waitForFrame(() => frameOf(i), "extension enable (guard)");
      i.stdin.write("n");
      await waitForCondition(
        () => session.history().some((e) => e.type === "extension_failed"),
        () => "the refused load to be recorded",
      );
      const failure = session.history().find((e) => e.type === "extension_failed") as { reason: string };
      expect(failure.reason).toBe("consent");
      expect(session.history().some((e) => e.type === "extension_loaded")).toBe(false);
    } finally {
      i.unmount();
      await session.dispose();
    }
  });
});
