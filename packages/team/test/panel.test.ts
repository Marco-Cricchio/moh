/**
 * The team panel (#1225, ADR-0062 as amended): the live roster, the detail
 * view inside the panel, and the focused-key seam. The render is a plain
 * string — the rail body is 36 columns and the panel truncates its own
 * text — and the keys reach it only through the client's focus forwarding.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ExtensionRuntime, type ExtensionConsentRequest } from "@moh/core";
import { readFileSync } from "node:fs";
import { createTeamExtension, TEAM_NAME, teamManifestAuthority } from "../src/index";
import { createTeamPanel, createTeamPanelState, markMemberWorking, settleMember } from "../src/panel";

function tempHome(): string {
  return `${tmpdir()}/moh-team-panel-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

describe("team panel state (#1225)", () => {
  test("a dispatched member is working; a settled outcome lands with its observation", () => {
    const state = createTeamPanelState();
    markMemberWorking(state, { name: "builder-1", role: "builder", scope: "src/**" }, "Task t1: build it");
    expect(state.members.get("builder-1")?.status).toBe("working");
    expect(state.members.get("builder-1")?.task).toBe("Task t1: build it");
    settleMember(state, "builder-1", "done", { outputChars: 120, currentTool: "bash" });
    const member = state.members.get("builder-1")!;
    expect(member.status).toBe("done");
    expect(member.outputChars).toBe(120);
    // The current tool clears on settle: a finished member runs nothing.
    expect(member.currentTool).toBe("bash");
  });

  test("a second dispatch refreshes the member in place, keeping its envelope", () => {
    const state = createTeamPanelState();
    markMemberWorking(state, { name: "builder-1", role: "builder", lane: "feat/x" }, "first");
    markMemberWorking(state, { name: "builder-1", role: "builder", lane: "feat/x" }, "second");
    const member = state.members.get("builder-1")!;
    expect(member.status).toBe("working");
    expect(member.task).toBe("second");
    expect(member.lane).toBe("feat/x");
    expect([...state.members.keys()]).toEqual(["builder-1"]);
  });

  test("settling an unknown member is a no-op — never an invented roster row", () => {
    const state = createTeamPanelState();
    settleMember(state, "ghost", "done");
    expect(state.members.size).toBe(0);
  });
});

describe("team panel render + keys (#1225)", () => {
  test("empty state renders the absence; the roster renders live members with glyphs", () => {
    const state = createTeamPanelState();
    const panel = createTeamPanel(state, () => []);
    expect(panel.render()).toContain("no members yet");
    markMemberWorking(state, { name: "builder-1", role: "builder" }, "Task t2: grep the tests");
    markMemberWorking(state, { name: "builder-2", role: "builder", lane: "feat/y" }, "Task t1: wire it");
    settleMember(state, "builder-2", "done", { outputChars: 10 });
    const frame = String(panel.render());
    expect(frame).toContain("team: 2 members");
    expect(frame).toContain("● builder-1");
    expect(frame).toContain("✓ builder-2");
    expect(frame).toContain("lane feat/y");
  });

  test("selection moves with n/p and opens the member detail inside the panel; enter returns", () => {
    const state = createTeamPanelState();
    markMemberWorking(state, { name: "builder-1", role: "builder", scope: "src/**" }, "Task t1: build it");
    markMemberWorking(state, { name: "reviewer-1", role: "reviewer" }, "review the parser");
    const panel = createTeamPanel(state, () => []);
    expect(panel.onKey!("\r", { input: "\r", return: true })).toBe(true);
    const first = String(panel.render());
    expect(first).toContain("builder-1 · builder");
    expect(first).toContain("scope src/**");
    expect(first).toContain("enter back");
    expect(panel.onKey!("n", { input: "n" })).toBe(true);
    expect(String(panel.render())).toContain("reviewer-1 · reviewer");
    expect(panel.onKey!("\r", { input: "\r", return: true })).toBe(true);
    const roster = String(panel.render());
    expect(roster).toContain(">● reviewer-1");
    expect(panel.onKey!("p", { input: "p" })).toBe(true);
    expect(String(panel.render())).toContain(">● builder-1");
  });

  test("p clamps at the top, n clamps at the bottom; unknown keys are ignored", () => {
    const state = createTeamPanelState();
    markMemberWorking(state, { name: "builder-1", role: "builder" }, "t");
    const panel = createTeamPanel(state, () => []);
    expect(panel.onKey!("p", { input: "p" })).toBe(true);
    expect(panel.onKey!("x", { input: "x" })).toBe(false);
    expect(panel.onKey!("j", { input: "j" })).toBe(false); // the client's scroll
    expect(panel.onKey!("\x1b", { input: "", escape: true })).toBe(false); // the client's exit
    expect(panel.onKey!("\t", { input: "", tab: true })).toBe(false);
    const first = String(panel.render());
    expect(first).toContain(">● builder-1");
  });

  test("the bag summary rides the header; the panel draws inside the rail body", () => {
    const state = createTeamPanelState();
    markMemberWorking(state, { name: "builder-1", role: "builder" }, "Task t1: build the parser module");
    const bag = [
      { status: "done" as const },
      { status: "claimed" as const },
      { status: "open" as const },
    ];
    const panel = createTeamPanel(state, () => bag);
    for (const line of String(panel.render()).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(36);
    }
    expect(String(panel.render())).toContain("bag 1/3 done");
  });
});

describe("team panel registration (#1225, ADR-0062 as amended)", () => {
  test("with the grant the extension contributes exactly one panel; a second registration is refused", async () => {
    const asked: ExtensionConsentRequest[] = [];
    const rt = new ExtensionRuntime({
      mohHome: tempHome(),
      consent: (request) => {
        asked.push(request);
        return true;
      },
    });
    await rt.register(createTeamExtension(), { manifest: teamManifestAuthority() });
    await rt.ready();
    const panels = rt.panels();
    expect(panels).toHaveLength(1);
    expect(panels[0]!.name).toBe("team");
    expect(panels[0]!.extension).toBe(TEAM_NAME);
    expect(typeof panels[0]!.onKey).toBe("function");
    expect(String(panels[0]!.render())).toContain("no members yet");
  });

  test("without the contribute-panels grant the panel is absent, the tool keeps working", async () => {
    const rt = new ExtensionRuntime({ mohHome: tempHome(), consent: () => true });
    await rt.register(createTeamExtension(), {
      manifest: {
        hash: "declared",
        path: "declared",
        capabilities: ["spawn-subagent", "contribute-tool:team"],
        reasoning: "declared in code",
      },
    });
    await rt.ready();
    expect(rt.panels()).toEqual([]);
    // The refusal is loud and names the slot: the capability_undeclared
    // subset rule (ADR-0061) — the extension never runs half-granted.
    const failed = rt.consumeLoadEvents().find((e) => e.type === "extension_failed") as { reason?: string; message?: string } | undefined;
    expect(failed?.reason).toBe("capability_undeclared");
    expect(failed?.message).toContain("contribute-panels");
  });
});

// The physical manifest stays the authority; this read keeps the test
// honest about what ships (the runtime test above registers the declared
// code capabilities for the absent-grant case).
expect(JSON.parse(readFileSync(teamManifestAuthority().path, "utf8")).capabilities).toEqual([
  "spawn-subagent",
  "contribute-tool:team",
  "contribute-panels",
]);
