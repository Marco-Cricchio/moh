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
        useCase: "classification",
        decision: "ask",
        questions: { destructive: 0.42, in_scope: 0.98 },
      }),
    ).toBe("jev · classification · ask (destructive 0.42)");
  });

  test("a guardrail judgment phrases the verdict and its key probability (#843)", () => {
    expect(
      extensionEventLine("jev_judgment", { useCase: "guardrail", decision: "ask", keyDimension: "destructive", keyProbability: 0.42 }),
    ).toBe("jev · guardrail · ask (destructive 0.42)");
    expect(
      extensionEventLine("jev_judgment", { useCase: "guardrail", decision: "deny", keyDimension: "exfiltration", keyProbability: 0.9 }),
    ).toBe("jev · guardrail · deny (exfiltration 0.90)");
    expect(
      extensionEventLine("jev_judgment", { useCase: "guardrail", decision: "ask", keyDimension: "risk", keyProbability: 0.8 }),
    ).toBe("jev · guardrail · ask (risk 0.80)");
    // A record with a probability but no dimension (transitional) keeps the
    // historical label; a pre-#843 log has no decision at all — degrade,
    // never invent.
    expect(extensionEventLine("jev_judgment", { useCase: "guardrail", decision: "ask", keyProbability: 0.42 })).toBe(
      "jev · guardrail · ask (destructive 0.42)",
    );
    expect(extensionEventLine("jev_judgment", { useCase: "guardrail", lethalOnly: false, answers: {} })).toBe(
      "jev · guardrail",
    );
  });

  test("a guardrail pass renders nothing; an ask and a deny render one line each (#843)", () => {
    const events = [
      { type: "extension_event", extension: "jev-guard", name: "jev_judgment", payload: { useCase: "guardrail", decision: "pass", callId: "c1" } },
      { type: "extension_event", extension: "jev-guard", name: "jev_judgment", payload: { useCase: "guardrail", decision: "ask", keyDimension: "destructive", keyProbability: 0.42, callId: "c2" } },
      { type: "extension_event", extension: "jev-guard", name: "jev_judgment", payload: { useCase: "guardrail", decision: "deny", keyDimension: "destructive", keyProbability: 0.9, callId: "c3" } },
      // A pre-#843 record keeps its old line: replay never rewrites history.
      { type: "extension_event", extension: "jev-guard", name: "jev_judgment", payload: { useCase: "guardrail", lethalOnly: false } },
    ] as unknown as AgentEvent[];
    const rendered = projectTranscript(events, {}).map((b) => (b.kind === "chrome" ? b.type : b.kind));
    expect(rendered).toEqual([
      "jev · guardrail · ask (destructive 0.42)",
      "jev · guardrail · deny (destructive 0.90)",
      "jev · guardrail",
    ]);
  });

  test("an unknown name renders as itself; a malformed payload never throws", () => {
    expect(extensionEventLine("whatever_happened", { anything: 1 })).toBe("whatever_happened");
    expect(extensionEventLine("jev_judgment", null)).toBe("jev_judgment");
    // An unrecognizable payload degrades to the bare event name.
    expect(extensionEventLine("jev_judgment", { questions: "nope" })).toBe("jev");
    expect(extensionEventLine("jev_judgment", [1, 2, 3])).toBe("jev_judgment");
  });

  test("a routing judgment reads as the router's decision (#787)", () => {
    expect(
      extensionEventLine("jev_judgment", {
        useCase: "routing",
        decision: "switch",
        tier: "potente",
        target: "a/big",
        reason: "hysteresis",
      }),
    ).toBe("jev · routing · switch to a/big (potente)");
    expect(extensionEventLine("jev_judgment", { useCase: "routing", decision: "stay", reason: "low-confidence" })).toBe(
      "jev · routing · stay (low-confidence)",
    );
  });

  test("the router's own notices read as one short line each (#787)", () => {
    expect(extensionEventLine("jev_routing", { kind: "ignored-label", ref: "b/nope" })).toBe(
      "jev · routing · label b/nope ignored (not in the model pool)",
    );
    expect(extensionEventLine("jev_routing", { kind: "unpriced", count: 3, models: ["a/x"] })).toBe(
      "jev · routing · 3 model(s) have no catalog price → bilanciato",
    );
    expect(extensionEventLine("jev_routing", { kind: "listing-failed", message: 'endpoint "local": listing failed (HTTP 500)' })).toBe(
      'jev · routing · endpoint "local": listing failed (HTTP 500)',
    );
    expect(extensionEventLine("jev_routing", { kind: "inert" })).toBe(
      "jev · routing · inert (fewer than two tiers to choose from)",
    );
    expect(extensionEventLine("jev_routing", { kind: "override", model: "a/handpicked" })).toBe(
      "jev · routing · suspended by your manual model switch (a/handpicked)",
    );
    // #847: a mismatch names both sides — what is serving and what the router picked.
    expect(extensionEventLine("jev_routing", { kind: "mismatch", current: "a/handpicked", expected: "a/big" })).toBe(
      "jev · routing · serving a/handpicked, router picked a/big",
    );
    // A malformed mismatch payload degrades gracefully — never `undefined`.
    expect(extensionEventLine("jev_routing", { kind: "mismatch" })).toBe("jev · routing");
    expect(extensionEventLine("jev_routing", { kind: "mismatch", current: 3, expected: "a/big" })).toBe("jev · routing");
    // An unknown kind never guesses.
    expect(extensionEventLine("jev_routing", { kind: "who-knows" })).toBe("jev · routing");
  });

  test("the silent band renders nothing; every other injection line reads as what happened (#791)", () => {
    const events = [
      { type: "extension_event", extension: "jev-guard", name: "jev_judgment", payload: { useCase: "injection", decision: "silent", injection: 0.02, sensitive: 0.01 } },
      { type: "extension_event", extension: "jev-guard", name: "jev_judgment", payload: { useCase: "injection", decision: "pass", injection: 0.03, sensitive: 0.01, source: "tool:fetch" } },
      { type: "extension_event", extension: "jev-guard", name: "jev_judgment", payload: { useCase: "injection", decision: "warn", injection: 0.63, sensitive: 0.02 } },
    ] as unknown as AgentEvent[];
    const rendered = projectTranscript(events, {}).map((b) => (b.kind === "chrome" ? b.type : b.kind));
    // The low band is silence: the log keeps the record, the transcript
    // does not gain a line for it (the whole point of the threshold).
    // #843: a guardrail pass is silence for the same reason.
    expect(rendered).toEqual(["jev · injection · warn (injection 0.63)"]);
  });

  test("an anti-injection judgment reads as what happened to the turn (#791)", () => {
    const line = (payload: Record<string, unknown>) => extensionEventLine("jev_judgment", payload);
    // The mid band is the visible warning: it exists to be read.
    expect(line({ useCase: "injection", decision: "warn", injection: 0.63, sensitive: 0.02 })).toBe(
      "jev · injection · warn (injection 0.63)",
    );
    // A fired sensitive signal carries the advice the record brought.
    expect(
      line({
        useCase: "injection",
        decision: "warn",
        injection: 0.03,
        sensitive: 0.71,
        advice: "do not commit or share this content",
      }),
    ).toBe("jev · injection · warn (sensitive 0.71 — do not commit or share this content)");
    // No advice in the record: the injection probability explains the warn.
    expect(line({ useCase: "injection", decision: "warn", injection: 0.55, sensitive: 0.71 })).toBe(
      "jev · injection · warn (injection 0.55)",
    );
    expect(line({ useCase: "injection", decision: "cancelled", injection: 0.97, sensitive: 0.1 })).toBe(
      "jev · injection · cancelled — nothing was sent",
    );
    expect(line({ useCase: "injection", decision: "refused-headless", injection: 0.99, sensitive: 0.1 })).toBe(
      "jev · injection · refused — possible injection, nothing was sent",
    );
    expect(line({ useCase: "injection", decision: "confirmed", injection: 0.96, sensitive: 0.1 })).toBe(
      "jev · injection · sent anyway (injection 0.96)",
    );
    expect(
      line({ useCase: "injection", decision: "withheld", injection: 0.98, sensitive: 0.1, source: "tool:fetch" }),
    ).toBe("jev · injection · withheld (fetch result withheld) (injection 0.98)");
    expect(line({ useCase: "injection", decision: "pass", injection: 0.02, sensitive: 0.01, source: "tool:fetch" })).toBe(
      "jev · injection · pass (injection 0.02)",
    );
    // A payload this renderer does not recognize never throws.
    expect(line({ useCase: "injection" })).toBe("jev · injection · judgment (injection 0.00)");
  });

  test("a client command renders as one line naming the extension (#787, ADR-0038)", () => {
    const events = [
      { type: "extension_control", extension: "jev-guard", payload: { cmd: "off" } },
      { type: "extension_control", extension: "jev-guard", payload: {} },
    ] as unknown as AgentEvent[];
    const blocks = projectTranscript(events, {});
    const rendered = blocks.map((b) => (b.kind === "chrome" ? b.type : b.kind));
    expect(rendered).toEqual(["jev-guard · off", "jev-guard · control"]);
    expect(blocks.every((b) => b.kind === "chrome")).toBe(true);
  });

  test("both variants land as chrome blocks, never as errors", () => {
    const events = [
      { type: "extension_event", extension: "jev-guard", name: "jev_judgment", payload: { useCase: "guardrail", decision: "deny", keyDimension: "destructive", keyProbability: 0.9 } },
      { type: "session_note", text: "jev: inactive (no api key)" },
    ] as unknown as AgentEvent[];
    const blocks = projectTranscript(events, {});
    const rendered = blocks.map((b) => (b.kind === "chrome" ? b.type : b.kind));
    expect(rendered).toContain("jev · guardrail · deny (destructive 0.90)");
    expect(rendered).toContain("jev: inactive (no api key)");
    expect(blocks.every((b) => b.kind === "chrome")).toBe(true);
  });
});

describe("vibe mode keeps only the Jev lines that earn their keep (#845)", () => {
  const ev = (name: string, payload: unknown) =>
    ({ type: "extension_event", extension: "jev-guard", name, payload }) as unknown as AgentEvent;

  test("a turn whose Jev activity is all noise shows no Jev block at all", () => {
    const events = [
      ev("jev_judgment", { useCase: "injection", decision: "pass", injection: 0.01 }),
      ev("jev_judgment", { useCase: "guardrail", decision: "pass", callId: "c1" }),
      ev("jev_judgment", { useCase: "classification", decision: "in_scope", questions: { destructive: 0.1 } }),
      ev("jev_judgment", { useCase: "rerank", decision: "ok", questions: { top: 0.9 } }),
      ev("jev_judgment", { useCase: "routing", decision: "stay", reason: "low-confidence" }),
      ev("jev_judgment", { useCase: "lint", decision: "pass" }),
      ev("jev_routing", { kind: "inert" }),
      ev("jev_routing", { kind: "unpriced", count: 2 }),
      ev("jev_routing", { kind: "ignored-label", ref: "b/nope" }),
      ev("jev_routing", { kind: "mismatch", current: "a/x", expected: "a/y" }),
      ev("jev_skill_suggest", { useCase: "skill_suggest", call: "rank", ok: true, needsSkill: 0.1, skills: 3 }),
    ];
    const rendered = projectTranscript(events, { mode: "vibe" }).map((b) => (b.kind === "chrome" ? b.type : b.kind));
    expect(rendered.filter((t) => typeof t === "string" && t.startsWith("jev"))).toEqual([]);
  });

  test("the lines that earn their keep still show in vibe mode", () => {
    const events = [
      ev("jev_judgment", { useCase: "injection", decision: "warn", injection: 0.7 }),
      ev("jev_judgment", { useCase: "injection", decision: "withheld", injection: 0.9 }),
      ev("jev_judgment", { useCase: "injection", decision: "cancelled" }),
      ev("jev_judgment", { useCase: "injection", decision: "refused-headless" }),
      ev("jev_judgment", { useCase: "injection", decision: "confirmed", injection: 0.8 }),
      ev("jev_judgment", { useCase: "guardrail", decision: "ask", keyDimension: "destructive", keyProbability: 0.42 }),
      ev("jev_judgment", { useCase: "guardrail", decision: "deny", keyDimension: "destructive", keyProbability: 0.9 }),
      ev("jev_judgment", { useCase: "routing", decision: "switch", target: "a/big", tier: "potente" }),
      ev("jev_judgment", { useCase: "lint", decision: "correct" }),
      ev("jev_skill_suggest", { useCase: "skill_suggest", call: "relevance", ok: true, suggested: "tdd", line: "try tdd" }),
      ev("jev_usecase", { usecase: "injection", action: "on", sessionOnly: true, config: false }),
      ev("jev_usecase", { usecase: "guardrail", action: "nonsense", refused: "unknown-action" }),
    ];
    const rendered = projectTranscript(events, { mode: "vibe" }).map((b) => (b.kind === "chrome" ? b.type : b.kind));
    const jev = rendered.filter((t): t is string => typeof t === "string" && t.startsWith("jev"));
    expect(jev.length).toBe(events.length);
    expect(jev).toContain("jev · injection · warn (injection 0.70)");
    expect(jev).toContain("jev · guardrail · ask (destructive 0.42)");
    expect(jev).toContain("jev · routing · switch to a/big (potente)");
    expect(jev).toContain("jev · injection · sent anyway (injection 0.80)");
  });

  test("the filter is on the event name + payload, not the rendered string", () => {
    // An unknown extension event name passes through in both modes.
    const events = [ev("other_extension_event", { any: 1 })];
    for (const mode of [{}, { mode: "vibe" as const }]) {
      expect(projectTranscript(events, mode).length).toBe(1);
    }
  });
});

describe("the uniform control line (#832)", () => {
  test("a warm change says what changed and that the config still disagrees", () => {
    expect(
      extensionEventLine("jev_usecase", {
        usecase: "injection",
        action: "on",
        status: "on",
        config: false,
        sessionOnly: true,
      }),
    ).toBe("jev · injection · on for this session — the config still says off");
    expect(
      extensionEventLine("jev_usecase", {
        usecase: "classification",
        action: "off",
        status: "off",
        config: true,
        sessionOnly: true,
      }),
    ).toBe("jev · classification · off for this session — the config still says on");
  });

  test("a change that matches the config does not invent an asymmetry", () => {
    expect(
      extensionEventLine("jev_usecase", { usecase: "lint", action: "on", status: "on", config: true }),
    ).toBe("jev · lint · on for this session");
  });

  test("the guardrail's own note replaces the config contrast it does not have", () => {
    expect(
      extensionEventLine("jev_usecase", {
        usecase: "guardrail",
        action: "off",
        status: "off",
        config: true,
        sessionOnly: true,
        note: "the guardrail has no persistent switch",
      }),
    ).toBe("jev · guardrail · off for this session — the guardrail has no persistent switch");
  });

  test("every refusal reads as a refusal, never as a change", () => {
    expect(
      extensionEventLine("jev_usecase", { usecase: "guardrail", action: "off", status: "on", config: true, refused: "yolo" }),
    ).toBe("jev · guardrail · off refused — yolo keeps the lethal checks on");
    expect(extensionEventLine("jev_usecase", { usecase: "skills", action: "on", refused: "unavailable" })).toBe(
      "jev · skills · on refused — not available in this session",
    );
    expect(extensionEventLine("jev_usecase", { usecase: "teleport", action: "on", refused: "unknown-usecase" })).toBe(
      "jev · teleport · not a Jev use case",
    );
    expect(extensionEventLine("jev_usecase", { usecase: "injection", action: "maybe", refused: "unknown-action" })).toBe(
      'jev · injection · "maybe" is not a command (on, off)',
    );
    expect(extensionEventLine("jev_usecase", { usecase: "routing", action: "auto", refused: "unsupported" })).toBe(
      'jev · routing · "auto" belongs to model routing',
    );
  });

  test("the client's own command line names the use case, not just the grammar", () => {
    // ADR-0038 renders every `extension_control` chrome line; #832 makes it
    // readable for the uniform grammar (`injection off`, not `usecase`).
    const events = [
      {
        type: "extension_control",
        extension: "jev-guard",
        payload: { cmd: "usecase", usecase: "injection", action: "off" },
      },
      { type: "extension_control", extension: "jev-guard", payload: { cmd: "off" } },
    ] as unknown as AgentEvent[];
    const rendered = projectTranscript(events, {}).map((b) => (b.kind === "chrome" ? b.type : b.kind));
    expect(rendered).toContain("jev-guard · injection off");
    expect(rendered).toContain("jev-guard · off");
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
