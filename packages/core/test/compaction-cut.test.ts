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
    const rt = new ExtensionRuntime({ mohHome: dir });
    await rt.register(
      defineExtension({
        name: "cut-everything",
        version: "0.0.1",
        apiVersion: "1.4",
        setup(ctx) {
          ctx.onCompaction(() => ({ drop: ["s0", "ghost", "s1"] }));
        },
      }),
      { bundled: true },
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
    const rt = new ExtensionRuntime({ mohHome: dir });
    await rt.register(
      defineExtension({
        name: "sleepy",
        version: "0.0.1",
        apiVersion: "1.4",
        setup(ctx) {
          ctx.onCompaction(() => new Promise(() => {})); // never settles
        },
      }),
      { bundled: true },
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

  test("#979: the hook is told its window and carries a signal that fires with it", async () => {
    const dir = tempDir();
    const rt = new ExtensionRuntime({ mohHome: dir });
    let seen: { hookTimeoutMs?: number; signal?: AbortSignal } | undefined;
    await rt.register(
      defineExtension({
        name: "watcher",
        version: "0.0.1",
        apiVersion: "1.4",
        setup(ctx) {
          ctx.onCompaction((c) => {
            seen = c;
            return { drop: [] };
          });
        },
      }),
      { bundled: true },
    );
    const { sections } = compactionSections(log(), 0, 8, (i) => `s${i}`);
    await rt.dispatchCompaction({ sections }, 1_234);
    expect(seen?.hookTimeoutMs).toBe(1_234);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.signal?.aborted).toBe(false);
    rt.stopWatch();
    rmSync(dir, { recursive: true, force: true });
  });

  test("#979: an abandoned dispatch is aborted and reports `applied: false` to its author", async () => {
    const dir = tempDir();
    const rt = new ExtensionRuntime({ mohHome: dir });
    let aborted: boolean | undefined;
    const applied: { keptByFloor: boolean; bytesAfter: number; droppedIds?: readonly string[]; applied?: boolean }[] = [];
    let settled: () => void = () => {};
    const done = new Promise<void>((r) => {
      settled = r;
    });
    await rt.register(
      defineExtension({
        name: "slow-but-honest",
        version: "0.0.1",
        apiVersion: "1.9",
        setup(ctx) {
          ctx.onCompaction(async (c) => {
            await new Promise((r) => setTimeout(r, 60));
            aborted = c.signal?.aborted === true;
            settled();
            return {
              drop: ["s0"],
              onApplied: (a) => applied.push(a),
            };
          });
        },
      }),
      { bundled: true },
    );
    const { sections } = compactionSections(log(), 0, 8, (i) => `s${i}`);
    const { drop, errors } = await rt.dispatchCompaction({ sections }, 20);
    // The late drops never apply...
    expect(drop).toEqual([]);
    expect(errors.some((e) => e.type === "extension_failed" && e.reason === "hook")).toBe(true);
    await done;
    await Bun.sleep(5);
    // ...the hook was told to stop...
    expect(aborted).toBe(true);
    // ...and its judgment reaches its author as "never applied" — with the
    // offered bytes kept: nothing was dropped — not as a cut that happened
    // to drop nothing. The two must not look alike.
    const offeredBytes = sections.reduce((sum, s) => sum + s.bytes, 0);
    expect(applied).toEqual([
      { keptByFloor: false, bytesAfter: offeredBytes, droppedIds: [], applied: false },
    ]);
    rt.stopWatch();
    rmSync(dir, { recursive: true, force: true });
  });

  test("#979: a hook that answers in time is never handed the abandoned outcome", async () => {
    const dir = tempDir();
    const rt = new ExtensionRuntime({ mohHome: dir });
    const applied: { keptByFloor: boolean; bytesAfter: number; droppedIds?: readonly string[]; applied?: boolean }[] = [];
    await rt.register(
      defineExtension({
        name: "quick",
        version: "0.0.1",
        apiVersion: "1.9",
        setup(ctx) {
          ctx.onCompaction((c) => ({
            drop: ["s0"],
            onApplied: (a) => applied.push(a),
          }));
        },
      }),
      { bundled: true },
    );
    const { sections } = compactionSections(log(), 0, 8, (i) => `s${i}`);
    const { drop, onApplied } = await rt.dispatchCompaction({ sections }, 200);
    expect(drop).toEqual(["s0"]);
    // The runner (here, the test) owns the callback: exactly once, applied.
    for (const cb of onApplied) cb({ keptByFloor: false, bytesAfter: 1_000 });
    await Bun.sleep(5);
    expect(applied).toEqual([{ keptByFloor: false, bytesAfter: 1_000 }]);
    rt.stopWatch();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a throwing hook is fail-open: no drops, one hook error", async () => {
    const dir = tempDir();
    const rt = new ExtensionRuntime({ mohHome: dir });
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
      { bundled: true },
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
    const rt = new ExtensionRuntime({ mohHome: dir });
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
      { bundled: true },
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
