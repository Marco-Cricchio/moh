/**
 * ADR-0035 / #792: the onCompaction seam end-to-end at the runner level.
 * Segmentation (user messages and chrome never become sections), the
 * dispatch through an ExtensionRuntime (unknown ids recorded, fail-open),
 * the 60% survival floor (smallest restored first), and the dropped
 * turn's one-line marker in the rendered transcript.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRuntime } from "../src/extensions";
import { defineExtension } from "@moh/extension";
import {
  COMPACTION_SECTION_FLOOR,
  CompactionRunner,
  applySectionDrops,
  compactionSections,
  compactionTranscript,
  type CompactionSectionView,
  type CompactionSummarizer,
} from "../src/compaction";
// ADR-0004: the section vocabulary is internal — tests import the
// modules directly, never through the package index.
import type { AgentEvent } from "../src/types";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "moh-compaction-cut-"));
}

/** 4 turns; turn 0 and 2 carry heavy tool bodies, 1 and 3 light text. */
function log(): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (let i = 0; i < 12; i++) {
    events.push({ type: "user_message", text: `turn ${i}` });
    if (i % 2 === 0) {
      events.push({ type: "tool_call", callId: `c${i}`, name: "bash", args: { cmd: "bun test" } });
      events.push({ type: "tool_result", callId: `c${i}`, ok: true, output: "x".repeat(2000) });
    } else {
      events.push({ type: "assistant_delta", text: `brief reply ${i}` });
    }
    events.push({ type: "done", usage: { inputTokens: 100, outputTokens: 10 } });
    events.push({ type: "model_call", model: "mock", usage: { inputTokens: 100, outputTokens: 10 } });
  }
  return events;
}

describe("compaction segmentation (ADR-0035)", () => {
  test("one section per turn body; user messages and chrome absent", () => {
    const events = log();
    const { sections } = compactionSections(events, 0, events.length, (i) => `s${i}`);
    expect(sections.length).toBe(12);
    expect(sections[0]!.kind).toBe("tool_result");
    expect(sections[1]!.kind).toBe("assistant");
    expect(sections.map((s) => s.id)).toEqual(sections.map((_, i) => `s${i}`));
  });

  test("chrome between turns never yields a section", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "one" },
      { type: "assistant_delta", text: "ans" },
      { type: "session_mode", mode: "yolo" },
      { type: "model_switched", from: "a", to: "b" },
      { type: "user_message", text: "two" },
      { type: "assistant_delta", text: "ans2" },
    ];
    const { sections } = compactionSections(events, 0, events.length, (i) => `s${i}`);
    expect(sections.length).toBe(2);
    expect(sections.every((s) => s.kind === "assistant")).toBe(true);
  });
});

describe("the survival floor", () => {
  const sections: CompactionSectionView[] = [
    { id: "s0", kind: "tool_result", bytes: 1000, preview: "" },
    { id: "s1", kind: "assistant", bytes: 100, preview: "" },
    { id: "s2", kind: "tool_result", bytes: 900, preview: "" },
  ];

  test("floor constant is the ratified 60%", () => {
    expect(COMPACTION_SECTION_FLOOR).toBe(0.6);
  });

  test("a full drop is reduced to what the budget admits (largest claims first)", () => {
    const { droppedIds, keptByFloor } = applySectionDrops(sections, ["s0", "s1", "s2"]);
    expect(keptByFloor).toBe(true);
    // Total 2000; at most 40% (800 bytes) may be dropped. Greedy over the
    // sorted request: s0 (1000) and s2 (900) each exceed the whole budget,
    // so only s1 (100) is admitted.
    expect([...droppedIds]).toEqual(["s1"]);
  });

  test("a drop within the budget passes untouched", () => {
    const { droppedIds, keptByFloor } = applySectionDrops(sections, ["s1"]);
    expect(keptByFloor).toBe(false);
    expect([...droppedIds]).toEqual(["s1"]);
  });

  test("a cut that would break the floor on its own is restored", () => {
    // s0 alone is 50% of the offered text: above the 40% drop budget.
    const { droppedIds, keptByFloor } = applySectionDrops(sections, ["s0"]);
    expect(keptByFloor).toBe(true);
    expect(droppedIds.size).toBe(0);
  });
});

describe("transcript with drops", () => {
  test("a dropped turn's body becomes one marker line; users and chrome stay", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "q1" },
      { type: "tool_call", callId: "c1", name: "bash", args: { cmd: "ls" } },
      { type: "tool_result", callId: "c1", ok: true, output: "out" },
      { type: "user_message", text: "q2" },
      { type: "assistant_delta", text: "kept answer" },
    ];
    const text = compactionTranscript(events, 0, events.length, (t) => t === 0);
    expect(text).toContain("user: q1");
    expect(text).toContain("[section dropped: turn 0]");
    expect(text).not.toContain("tool bash");
    expect(text).toContain("user: q2");
    expect(text).toContain("assistant: kept answer");
  });

  test("without drops the transcript is byte-identical to the legacy render", () => {
    const events = log();
    expect(compactionTranscript(events, 0, events.length)).toBe(
      compactionTranscript(events, 0, events.length, () => false),
    );
  });
});

describe("dispatch through a runtime", () => {
  test("unknown ids are recorded and ignored; drops flow through", async () => {
    const dir = tempDir();
    const rt = new ExtensionRuntime({ mohHome: dir, bundledTrust: true });
    await rt.register(
      defineExtension({
        name: "cut-everything",
        version: "0.0.1",
        apiVersion: "1.4",
        setup(ctx) {
          ctx.onCompaction(() => ({ drop: ["s0", "ghost", "s1"] }));
        },
      }),
    );
    const events = log();
    const { sections } = compactionSections(events, 0, events.length, (i) => `s${i}`);
    const { drop, errors } = await rt.dispatchCompaction({ sections });
    expect(drop).toEqual(["s0", "s1"]);
    expect(errors.filter((e) => e.type === "extension_failed" && e.reason === "unknown_section").length).toBe(1);
    rt.stopWatch();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a hook that never answers times out: no drops, one visible hook failure", async () => {
    const dir = tempDir();
    const rt = new ExtensionRuntime({ mohHome: dir, bundledTrust: true });
    await rt.register(
      defineExtension({
        name: "sleepy",
        version: "0.0.1",
        apiVersion: "1.4",
        setup(ctx) {
          ctx.onCompaction(() => new Promise(() => {})); // never settles
        },
      }),
    );
    const { sections } = compactionSections(log(), 0, 8, (i) => `s${i}`);
    const { drop, errors } = await rt.dispatchCompaction({ sections }, 30);
    expect(drop).toEqual([]);
    const failed = errors.filter((e) => e.type === "extension_failed" && e.reason === "hook");
    expect(failed.length).toBe(1);
    expect((failed[0] as { message: string }).message).toContain("did not answer within");
    rt.stopWatch();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a throwing hook is fail-open: no drops, one hook error", async () => {
    const dir = tempDir();
    const rt = new ExtensionRuntime({ mohHome: dir, bundledTrust: true });
    await rt.register(
      defineExtension({
        name: "explosive",
        version: "0.0.1",
        apiVersion: "1.4",
        setup(ctx) {
          ctx.onCompaction(() => {
            throw new Error("boom");
          });
        },
      }),
    );
    const { sections } = compactionSections(log(), 0, 8, (i) => `s${i}`);
    const { drop, errors } = await rt.dispatchCompaction({ sections }, 50);
    expect(drop).toEqual([]);
    expect(errors.filter((e) => e.type === "extension_failed" && e.reason === "hook").length).toBe(1);
    rt.stopWatch();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the runner applies the floor and renders the cut transcript", async () => {
    const dir = tempDir();
    const rt = new ExtensionRuntime({ mohHome: dir, bundledTrust: true });
    // Drop every offered section: the floor must reduce it.
    await rt.register(
      defineExtension({
        name: "cut-everything",
        version: "0.0.1",
        apiVersion: "1.4",
        setup(ctx) {
          ctx.onCompaction(({ sections: offered }) => ({ drop: offered.map((s) => s.id) }));
        },
      }),
    );
    const events = log();
    const appended: AgentEvent[] = [];
    const summarizer: CompactionSummarizer = async ({ transcript }) => `S:${transcript}`;
    const runner = new CompactionRunner({
      sessionId: "s",
      provider: () => ({ name: "mock" } as never),
      append: (e) => appended.push(e),
      onCompacted: () => {},
      summarizer,
      sectionFilter: (ctx) => rt.dispatchCompaction(ctx),
      tailTurns: 10,
      fallbackWindowTokens: 180_000,
    });
    const result = await runner.compactNow(events);
    expect(result.ok).toBe(true);
    // The runner logged one visible floor notice.
    expect(appended.some((e) => e.type === "extension_failed" && (e as { reason?: string }).reason === "section_floor")).toBe(true);
    // And the transcript the summarizer saw still holds most content.
    const marker = appended.find((e) => e.type === "compaction") as { summary: string; keptByFloor?: true } | undefined;
    expect(marker!.summary).toContain("user: turn 0");
    expect(marker!.summary).toContain("user: turn 1");
    // The marker itself records the floor application (ADR-0035 §4).
    expect(marker!.keptByFloor).toBe(true);
    rt.stopWatch();
    rmSync(dir, { recursive: true, force: true });
  });
});
