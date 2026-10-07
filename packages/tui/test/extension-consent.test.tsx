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
import { grantTeamExtension, stripAnsi, unwrap, waitForCondition, waitForFrame } from "./helpers";

const frameOf = (i: { lastFrame: () => string | undefined }) => stripAnsi(i.lastFrame() ?? "");

function homeWithExtension(name: string, body: string): string {
  const home = mkdtempSync(join(tmpdir(), "moh-ext-consent-"));
  mkdirSync(join(home, ".moh", "extensions"), { recursive: true });
  writeFileSync(join(home, ".moh", "extensions", `${name}.mjs`), body);
  // ADR-0061: a file extension loads only with a manifest beside it — the
  // manifest is what consent reads, so the fixture writes one.
  writeFileSync(
    join(home, ".moh", "extensions", "moh.extension.json"),
    JSON.stringify({ name, version: "0.3.0", entry: `${name}.mjs`, capabilities: [] }),
  );
  grantTeamExtension(home);
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

  test("a widening manifest edit shows the capability diff in the question (ADR-0061)", () => {
    const view = describePermissionRequest(
      "extension",
      {
        name: "guard",
        version: "0.4.0",
        file: "/home/u/.moh/extensions/guard.mjs",
        capabilities: ["contribute-commands", "contribute-panels"],
        addedCapabilities: ["contribute-panels"],
      },
      { source: "extension", extension: "guard" },
    );
    expect(view.detail).toContain("capabilities: contribute-commands, contribute-panels");
    expect(view.detail).toContain("new since last approval: contribute-panels");
  });

  test("the manifest's reasoning is part of the question (ADR-0066 display)", () => {
    const view = describePermissionRequest(
      "extension",
      {
        name: "team",
        version: "0.1.0",
        capabilities: ["spawn-subagent"],
        reasoning: "It does not add peer messaging between members.",
      },
      { source: "extension", extension: "team" },
    );
    expect(view.detail).toContain("capabilities: spawn-subagent — may create up to 10 concurrent child sessions and steer or stop them");
    expect(view.detail).toContain("reasoning: It does not add peer messaging between members.");
  });

  test("a first-time file is asked about with its path and bytes, before it runs", () => {
    const view = describePermissionRequest(
      "extension",
      { file: "/home/u/.moh/extensions/guard.mjs", hash: "a".repeat(64) },
      { source: "extension", extension: "guard.mjs" },
    );
    expect(view.detail).toEqual([
      "source: /home/u/.moh/extensions/guard.mjs",
      `sha256: ${"a".repeat(64)}`,
      "name/version: not stated yet (the file is asked about before it runs)",
      "no sandbox: it runs with moh's own privileges",
    ]);
    expect(view.rulePreview).toBeNull();
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
      // #834 (security): the first-time ask comes before the import, so the
      // label names the *file* — the module has not run and has stated
      // nothing yet.
      await waitForFrame(() => frameOf(i), "extension enable (guard.mjs)");
      const frame = frameOf(i);
      expect(frame).toContain("An extension wants to run in this session:");
      expect(frame).toContain("source: ");
      expect(frame).toContain("sha256: ");
      expect(frame).toContain("not stated yet");
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
        () => session.history().some((e) => e.type === "extension_loaded" && (e as { name?: string }).name === "guard"),
        () => "the extension to load after the consent",
      );
      expect(
        session.history().find((e) => e.type === "extension_loaded" && (e as { name?: string }).name === "guard"),
      ).toMatchObject({
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
      await waitForFrame(() => frameOf(i), "extension enable (guard.mjs)");
      i.stdin.write("n");
      await waitForCondition(
        () => session.history().some((e) => e.type === "extension_failed"),
        () => "the refused load to be recorded",
      );
      const failure = session.history().find((e) => e.type === "extension_failed") as { reason: string };
      expect(failure.reason).toBe("consent");
      // The pre-granted team extension is the only thing allowed to have
      // loaded; the declined file extension must not be among them.
      expect(
        session
          .history()
          .filter((e) => e.type === "extension_loaded")
          .every((e) => (e as { name?: string }).name === "team"),
      ).toBe(true);
    } finally {
      i.unmount();
      await session.dispose();
    }
  });
});
