/**
 * #1131: the read-only `/extensions` state tests. Fold over fixture
 * event arrays for the pure seam; one on-disk fixture for the file door.
 * Every assertion stays on metadata — names, versions, reasons.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extensionsScreenStateFromEvents,
  readExtensionsScreenState,
  mergeExtensionLiveInfo,
  type AgentEvent,
} from "../src/index";

describe("extensionsScreenStateFromEvents", () => {
  it("returns empty state for an event-free log", () => {
    expect(extensionsScreenStateFromEvents([])).toEqual({ extensions: [], refusals: [] });
  });

  it("lists loaded extensions with their latest version", () => {
    const events: AgentEvent[] = [
      { type: "extension_loaded", name: "jev", version: "0.1.0" },
      { type: "extension_loaded", name: "jev", version: "0.2.0" },
    ];
    const state = extensionsScreenStateFromEvents(events);
    expect(state.extensions).toHaveLength(1);
    expect(state.extensions[0]).toMatchObject({ name: "jev", version: "0.2.0", failureCount: 0 });
  });

  it("keeps the last failure per extension and counts them all", () => {
    const events: AgentEvent[] = [
      { type: "extension_loaded", name: "a", version: "1.0.0" },
      { type: "extension_failed", name: "a", reason: "hook", message: "one" },
      { type: "extension_failed", name: "a", reason: "setup_failed", message: "two" },
      { type: "extension_loaded", name: "b", version: "1.0.0" },
    ];
    const [a, b] = extensionsScreenStateFromEvents(events).extensions;
    expect(a.lastFailure).toEqual({ reason: "setup_failed", message: "two" });
    expect(a.failureCount).toBe(2);
    expect(b.lastFailure).toBeUndefined();
    expect(b.failureCount).toBe(0);
  });

  it("replays prompt_override into the composition in force", () => {
    const events: AgentEvent[] = [
      { type: "extension_loaded", name: "jev", version: "0.2.0" },
      { type: "prompt_override", section: "mpm", extension: "jev", version: "0.1.0", mode: "replaced" },
      { type: "prompt_override", section: "memory", extension: "jev", version: "0.2.0", mode: "hidden" },
    ];
    const [row] = extensionsScreenStateFromEvents(events).extensions;
    expect(row.sections).toEqual([
      { section: "memory", version: "0.2.0", mode: "hidden" },
      { section: "mpm", version: "0.1.0", mode: "replaced" },
    ]);
  });

  it("restores remove only the restoring extension's own ownership", () => {
    const events: AgentEvent[] = [
      { type: "extension_loaded", name: "jev", version: "0.2.0" },
      { type: "extension_loaded", name: "other", version: "1.0.0" },
      { type: "prompt_override", section: "mpm", extension: "jev", version: "0.2.0", mode: "replaced" },
      // A stale restore from another extension changes nothing.
      { type: "prompt_override", section: "mpm", extension: "other", version: "1.0.0", mode: "restored" },
      { type: "prompt_override", section: "mpm", extension: "jev", version: "0.2.0", mode: "restored" },
    ];
    const [jev] = extensionsScreenStateFromEvents(events).extensions;
    expect(jev.sections).toEqual([]);
  });

  it("hands a restored section to its next owner, not to nobody", () => {
    const events: AgentEvent[] = [
      { type: "extension_loaded", name: "first", version: "1.0.0" },
      { type: "extension_loaded", name: "second", version: "2.0.0" },
      { type: "prompt_override", section: "tools", extension: "first", version: "1.0.0", mode: "replaced" },
      { type: "prompt_override", section: "tools", extension: "second", version: "2.0.0", mode: "replaced" },
    ];
    const state = extensionsScreenStateFromEvents(events);
    const first = state.extensions.find((e) => e.name === "first")!;
    const second = state.extensions.find((e) => e.name === "second")!;
    expect(first.sections).toEqual([]);
    expect(second.sections).toEqual([{ section: "tools", version: "2.0.0", mode: "replaced" }]);
  });

  it("lists refused command registrations from command_refused failures", () => {
    const events: AgentEvent[] = [
      { type: "extension_loaded", name: "jev", version: "0.2.0" },
      { type: "extension_failed", name: "jev", reason: "command_refused", message: 'command "/status" refused: reserved' },
      { type: "extension_failed", name: "other", reason: "hook", message: "not a refusal" },
    ];
    const state = extensionsScreenStateFromEvents(events);
    expect(state.refusals).toEqual([{ extension: "jev", message: 'command "/status" refused: reserved' }]);
  });

  it("lists refused panel and overlay registrations too (#1132)", () => {
    const events: AgentEvent[] = [
      { type: "extension_loaded", name: "ops", version: "1.0.0", panels: ["status"], overlays: ["board"] },
      { type: "extension_failed", name: "fifth", reason: "panel_refused", message: "panel \"slot\" refused: panel slot exhausted (4/4) — disable a panel in /extensions" },
      { type: "extension_failed", name: "ops", reason: "overlay_refused", message: 'overlay "board" refused: the overlay name is already taken by this extension' },
    ];
    const state = extensionsScreenStateFromEvents(events);
    expect(state.refusals).toEqual([
      { extension: "fifth", message: "panel \"slot\" refused: panel slot exhausted (4/4) — disable a panel in /extensions" },
      { extension: "ops", message: 'overlay "board" refused: the overlay name is already taken by this extension' },
    ]);
    const ops = state.extensions.find((e) => e.name === "ops")!;
    expect(ops.panels).toEqual(["status"]);
    expect(ops.overlays).toEqual(["board"]);
  });

  it("attributes a section to its owner even without a prior load event", () => {
    const events: AgentEvent[] = [
      { type: "prompt_override", section: "mpm", extension: "ghost", version: "9.9.9", mode: "replaced" },
    ];
    const [row] = extensionsScreenStateFromEvents(events).extensions;
    expect(row).toMatchObject({ name: "ghost", version: "9.9.9" });
  });
});

describe("mergeExtensionLiveInfo", () => {
  it("attaches live facts to matching rows and invents none", () => {
    const state = extensionsScreenStateFromEvents([{ type: "extension_loaded", name: "jev", version: "0.2.0" }]);
    const merged = mergeExtensionLiveInfo(state, [
      {
        name: "jev",
        file: "/proj/jev/index.ts",
        capabilities: ["replace-prompt-section:mpm", "contribute-commands"],
        commands: [{ name: "status", description: "show status" }],
        panels: [{ name: "status", description: "live status", maxHeight: 5 }],
        overlays: [{ name: "board", description: "board" }],
      },
      { name: "not-yet-in-log", capabilities: [], commands: [], panels: [], overlays: [] },
    ]);
    expect(merged.extensions).toHaveLength(1);
    expect(merged.extensions[0]).toMatchObject({
      file: "/proj/jev/index.ts",
      capabilities: ["replace-prompt-section:mpm", "contribute-commands"],
      commands: [{ name: "status", description: "show status" }],
      panels: [{ name: "status", description: "live status", maxHeight: 5 }],
      overlays: [{ name: "board", description: "board" }],
    });
  });
});

describe("readExtensionsScreenState", () => {
  it("returns an explicit error for an unreadable file", () => {
    const result = readExtensionsScreenState("/nonexistent/session.jsonl");
    expect("error" in result ? result.error : "").toContain("ENOENT");
  });

  it("folds a session file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-1131-"));
    try {
      const file = join(dir, "s.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({ type: "session_start" }),
          JSON.stringify({ type: "extension_loaded", name: "jev", version: "0.2.0" }),
          JSON.stringify({ type: "prompt_override", section: "mpm", extension: "jev", version: "0.2.0", mode: "replaced" }),
        ].join("\n") + "\n",
      );
      const state = readExtensionsScreenState(file);
      if ("error" in state) throw new Error(state.error);
      expect(state.extensions[0]).toMatchObject({ name: "jev", version: "0.2.0" });
      expect(state.extensions[0].sections).toEqual([{ section: "mpm", version: "0.2.0", mode: "replaced" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
