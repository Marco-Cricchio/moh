import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childTailLine, tailChildLog, CHILD_TAIL_MAX_LINES, type ChildTailLine } from "../src/child-tail";
import type { AgentEvent } from "../src/types";

describe("childTailLine", () => {
  test("projects tool calls with a short arg summary", () => {
    const line = childTailLine(1, {
      type: "tool_call",
      callId: "c1",
      name: "bash",
      args: { command: "git status --short" },
    });
    expect(line).toEqual({ id: 1, text: "● bash · git status --short" });
  });

  test("truncates long args", () => {
    const line = childTailLine(2, {
      type: "tool_call",
      callId: "c2",
      name: "bash",
      args: { command: "x".repeat(100) },
    });
    expect(line!.text.length).toBeLessThanOrEqual("● bash · ".length + 40);
    expect(line!.text.endsWith("…")).toBe(true);
  });

  test("tool results settle to done or a bounded failure", () => {
    expect(childTailLine(3, { type: "tool_result", callId: "c1", ok: true, output: "ok" }))
      .toEqual({ id: 3, text: "✓ done" });
    const line = childTailLine(4, { type: "tool_result", callId: "c2", ok: false, output: "boom ".repeat(50) });
    expect(line!.text.startsWith("✗ failed")).toBe(true);
    expect(line!.text.length).toBeLessThan(80);
  });

  test("chrome events produce no line", () => {
    expect(childTailLine(5, { type: "session_start", schemaVersion: 1, promptVersion: "1" })).toBeNull();
    expect(childTailLine(6, { type: "model_call", model: "m", usage: { inputTokens: 1, outputTokens: 1 } })).toBeNull();
    expect(childTailLine(7, { type: "assistant_delta", text: "" })).toBeNull();
  });

  test("assistant deltas carry bounded text", () => {
    const line = childTailLine(8, { type: "assistant_delta", text: "hello world from the model" });
    expect(line!.text.startsWith("· ")).toBe(true);
  });
});

describe("tailChildLog", () => {
  const events: AgentEvent[] = [
    { type: "session_start", schemaVersion: 1, promptVersion: "1" },
    { type: "user_message", text: "do it" },
    { type: "tool_call", callId: "c1", name: "bash", args: { command: "git status" } },
    { type: "tool_result", callId: "c1", ok: true, output: "clean" },
    { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
  ];

  test("returns projected lines and advances the offset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "child-tail-"));
    try {
      const file = join(dir, "child.jsonl");
      await writeFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const first = await tailChildLog(file, 0);
      expect(first.eventCount).toBe(5);
      expect(first.nextOffset).toBeGreaterThan(0);
      expect(first.activity.currentTool).toBe("bash");
      expect(first.activity.lastActivityAt).not.toBeNull();
      const texts = first.lines.map((l: ChildTailLine) => l.text);
      expect(texts).toContain("▸ task");
      expect(texts).toContain("● bash · git status");
      expect(texts).toContain("✓ done");
      // No chrome lines.
      expect(texts.some((t) => t.includes("session_start"))).toBe(false);
      // A second poll at the advanced offset is empty and stable.
      const second = await tailChildLog(file, first.nextOffset);
      expect(second.lines).toEqual([]);
      expect(second.nextOffset).toBe(first.nextOffset);
      expect(second.eventCount).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tolerates a truncated trailing line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "child-tail-"));
    try {
      const file = join(dir, "child.jsonl");
      const full = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      // Cut mid final line.
      await writeFile(file, full.slice(0, full.length - 10));
      const result = await tailChildLog(file, 0);
      // Only the 4 complete events count.
      expect(result.eventCount).toBe(4);
      // The offset stops at the start of the partial line.
      const complete = events.slice(0, 4).map((e) => JSON.stringify(e)).join("\n") + "\n";
      expect(result.nextOffset).toBe(Buffer.byteLength(complete));
      // Appending the rest makes the next poll see it.
      await writeFile(file, full);
      const next = await tailChildLog(file, result.nextOffset);
      expect(next.eventCount).toBe(1);
      expect(next.lines.map((l) => l.text)).toEqual(["✓ done"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing file yields an empty result at the same offset", async () => {
    const result = await tailChildLog("/nonexistent/child.jsonl", 128);
    expect(result.lines).toEqual([]);
    expect(result.nextOffset).toBe(128);
    expect(result.eventCount).toBe(0);
    expect(result.activity.currentTool).toBeNull();
  });

  test("caps returned lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "child-tail-"));
    try {
      const file = join(dir, "child.jsonl");
      const many = Array.from({ length: CHILD_TAIL_MAX_LINES + 50 }, () =>
        JSON.stringify({ type: "tool_result", callId: "c", ok: true, output: "" }),
      ).join("\n") + "\n";
      await writeFile(file, many);
      const result = await tailChildLog(file, 0);
      expect(result.lines.length).toBe(CHILD_TAIL_MAX_LINES);
      expect(result.eventCount).toBe(CHILD_TAIL_MAX_LINES + 50);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
