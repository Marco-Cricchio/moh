/**
 * #784: the TUI chrome of the Jev infra layer — the transcript lines for the
 * two new AgentEvent variants, the footer status chip (ADR-0032) and the
 * extension `ask` in the consent prompt (ADR-0031). No network anywhere: the
 * key validator is injected.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@moh/core";
import { projectTranscript, extensionEventLine } from "../src/transcript";
import { BottomBar, ExtensionStatusChip } from "../src/BottomBar";
import { PermissionModal } from "../src/PermissionModal";
import { PermissionGate } from "../src/permission-gate";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const theme = THEMES[DEFAULT_THEME];

describe("extension_event / session_note in the transcript (#784)", () => {
  test("a known judgment renders useCase, decision and the first answer", () => {
    expect(
      extensionEventLine("jev_judgment", {
        useCase: "guardrail",
        decision: "ask",
        questions: { destructive: 0.42, in_scope: 0.98 },
      }),
    ).toBe("jev · guardrail · ask (destructive 0.42)");
  });

  test("an unknown name renders as itself; a malformed payload never throws", () => {
    expect(extensionEventLine("whatever_happened", { anything: 1 })).toBe("whatever_happened");
    expect(extensionEventLine("jev_judgment", null)).toBe("jev_judgment");
    // An unrecognizable payload degrades to the bare event name.
    expect(extensionEventLine("jev_judgment", { questions: "nope" })).toBe("jev");
    expect(extensionEventLine("jev_judgment", [1, 2, 3])).toBe("jev_judgment");
  });

  test("both variants land as chrome blocks, never as errors", () => {
    const events = [
      { type: "extension_event", extension: "jev-guard", name: "jev_judgment", payload: { useCase: "guardrail", decision: "pass" } },
      { type: "session_note", text: "jev: inactive (no api key)" },
    ] as unknown as AgentEvent[];
    const blocks = projectTranscript(events, {});
    const rendered = blocks.map((b) => (b.kind === "chrome" ? b.type : b.kind));
    expect(rendered).toContain("jev · guardrail · pass");
    expect(rendered).toContain("jev: inactive (no api key)");
    expect(blocks.every((b) => b.kind === "chrome")).toBe(true);
  });
});

describe("footer status chip (ADR-0032)", () => {
  const mount = (statuses?: { extension: string; text: string }[]) =>
    render(
      <ThemeProvider value={theme}>
        <BottomBar
          width={120}
          pending={false}
          spinner="⠋"
          mode="dev"
          model="mock"
          turns={1}
          tokens={{ contextIn: 0, totalOut: 0, calls: 0 }}
          level="default"
          focusedChip={null}
          extensionStatuses={statuses}
        />
      </ThemeProvider>,
    );

  test("renders one chip per published status, name included", async () => {
    const i = mount([{ extension: "jev-guard", text: "∅ jev offline" }]);
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("jev-guard ∅ jev offline");
    i.unmount();
  });

  test("cleared (no statuses) renders no chip at all", async () => {
    const i = mount([]);
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("jev offline");
    i.unmount();
  });

  test("several extensions render separate chips, in registration order", async () => {
    const i = render(
      <ThemeProvider value={theme}>
        <Box flexDirection="column">
          <ExtensionStatusChip status={{ extension: "a-ext", text: "first" }} wide theme={theme} />
          <ExtensionStatusChip status={{ extension: "b-ext", text: "second" }} wide theme={theme} />
        </Box>
      </ThemeProvider>,
    );
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame.indexOf("a-ext first")).toBeLessThan(frame.indexOf("b-ext second"));
    i.unmount();
  });
});

describe("extension ask in the consent prompt (ADR-0031)", () => {
  test("offers yes/no only, carries the reason as its label, writes no rule", async () => {
    const gate = new PermissionGate();
    const pending = gate.ask("bash", { command: "rm -rf /tmp/build" }, {
      source: "extension",
      extension: "jev-guard",
      reason: "verify (destructive 0.42)",
    });
    const i = render(
      <ThemeProvider value={theme}>
        <PermissionModal gate={gate} mode="dev" />
      </ThemeProvider>,
    );
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("extension ask (jev-guard): verify (destructive 0.42)");
    // No "always"/"edit" affordance and no rule preview line.
    expect(frame).not.toContain("always");
    expect(frame).not.toContain("writes the session rule");
    expect(frame).toContain("no");
    // `a` is inert on an extension ask: the prompt stays up.
    i.stdin.write("a");
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("extension ask");
    expect(gate.current?.rulePreview).toBeNull();
    i.stdin.write("n");
    await sleep(30);
    expect(await pending).toBe("no");
    expect(gate.current).toBeNull();
    i.unmount();
  });

  test("a plain tool ask keeps its always/edit affordances", async () => {
    const gate = new PermissionGate();
    const pending = gate.ask("bash", { command: "echo hi" });
    const i = render(
      <ThemeProvider value={theme}>
        <PermissionModal gate={gate} mode="dev" />
      </ThemeProvider>,
    );
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("always");
    expect(frame).toContain("writes the session rule: bash:echo hi");
    gate.resolve("yes");
    await pending;
    i.unmount();
  });
});
