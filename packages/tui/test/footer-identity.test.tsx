/**
 * #1355: the footer's third row — the running moh version on the left
 * (`MoH - vX.Y.Z`), the session name (only when renamed) and the session id
 * on the right. Ambient identity chrome: it never wraps, and the right side
 * degrades (name elided → dropped, full id → short id) instead.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { MockProvider, createSession } from "@moh/core";
import { ThemeProvider, THEMES } from "../src/themes";
import { BottomBar, footerVersionText, sessionIdentityText } from "../src/BottomBar";
import { Chat } from "../src/Chat";
import { stripAnsi } from "./helpers";

const base = {
  width: 120,
  pending: false,
  spinner: "⠸",
  model: "mock",
  turns: 12,
  tokens: { contextIn: 10_000, totalOut: 100, calls: 1 },
  level: "medium" as const,
  focusedChip: null,
};

function frameOfElement(ui: React.ReactElement): string {
  const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}>{ui}</ThemeProvider>);
  const frame = stripAnsi(ink.lastFrame() ?? "");
  ink.unmount();
  return frame;
}

function frameOf(props: Record<string, unknown>, width?: number): string {
  const bottomBarProps = { ...base, ...(width !== undefined ? { width } : {}), ...props };
  return frameOfElement(<BottomBar {...(bottomBarProps as unknown as Parameters<typeof BottomBar>[0])} />);
}

const identityLineOf = (frame: string): string =>
  frame.split("\n").find((line) => line.includes("MoH - v") || line.includes("session-")) ?? "";

describe("footer row 3 (#1355)", () => {
  test("absent when neither a version nor a session id is passed", () => {
    expect(identityLineOf(frameOf({}))).toBe("");
  });

  test("wide: version left, id right", () => {
    const line = identityLineOf(frameOf({ appVersion: "0.64.7", sessionId: "session-4f7a2b1c" }, 110));
    expect(line).toContain("MoH - v0.64.7");
    expect(line).toContain("session-4f7a2b1c");
    expect(line.indexOf("MoH - v")).toBeLessThan(line.indexOf("session-"));
  });

  test("the renamed session shows `name · id`; never-renamed shows the id alone", () => {
    const renamed = identityLineOf(frameOf({ appVersion: "0.64.7", sessionId: "session-4f7a2b1c", sessionName: "refactor-footer" }, 110));
    expect(renamed).toContain("refactor-footer · session-4f7a2b1c");
    const plain = identityLineOf(frameOf({ appVersion: "0.64.7", sessionId: "session-4f7a2b1c", sessionName: null }, 110));
    expect(plain).toContain("session-4f7a2b1c");
    expect(plain).not.toContain("·");
  });

  test("an empty rename is not a name: the id renders alone", () => {
    const line = identityLineOf(frameOf({ appVersion: "0.64.7", sessionId: "session-4f7a2b1c", sessionName: "  " }, 110));
    expect(line).toContain("session-4f7a2b1c");
    expect(line).not.toContain("·");
  });

  test("compact tiers degrade without wrapping", () => {
    // 35 columns is the style-guide floor; nothing may wrap below or at it.
    for (const width of [35, 48, 69]) {
      const frame = frameOf({ appVersion: "0.64.7", sessionId: "session-4f7a2b1c", sessionName: "refactor-footer" }, width);
      const lines = frame.split("\n").filter((line) => line.includes("MoH - v"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("MoH - v0.64.7");
    }
    // The compact mock: the name elides (head kept, `…` closes it) and the
    // id shortens to its uuid tail.
    expect(sessionIdentityText("refactor-footer", "session-4f7a2b1c", 22)).toBe("refactor-… · 4f7a2b1c");
  });

  test("the identity fits whatever the version leaves of the row", () => {
    expect(sessionIdentityText(null, "session-4f7a2b1c", 40)).toBe("session-4f7a2b1c");
    expect(sessionIdentityText("refactor-footer", "session-4f7a2b1c", 40)).toBe("refactor-footer · session-4f7a2b1c");
    expect(sessionIdentityText(null, "session-4f7a2b1c", 8)).toBe("4f7a2b1c");
  });

  test("footerVersionText says `v` once", () => {
    expect(footerVersionText("0.64.7")).toBe("MoH - v0.64.7");
    expect(footerVersionText("v0.64.7")).toBe("MoH - v0.64.7");
  });

  test("Chat reads version, name and id through the client seam", () => {
    const session = createSession({ provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]), memory: { enabled: false } });
    session.rename("refactor-footer");
    const frame = frameOfElement(
      <Chat
        session={session}
        cwd="/tmp"
        mode="dev"
        modelLabel="mock"
        width={110}
        version="0.64.7"
        sessionId={session.id}
        sessionName="refactor-footer"
      />,
    );
    const line = frame.split("\n").find((text) => text.includes("MoH - v0.64.7")) ?? "";
    expect(line).toContain("refactor-footer ·");
    expect(line).toContain(session.id);
  });
});
