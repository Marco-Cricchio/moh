/**
 * #767: single-session analysis report tests. Fixture session files on
 * disk; every assertion stays on metadata (tokens, counts, durations) —
 * never message content.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeSession, type AgentEvent } from "../src/index";
import type { ToolErrorKind } from "../src/types";
import { projectSessionsDir } from "../src/session-store";
import { ENCODING } from "../src/session/ulid";

/** Deterministic ULID at a fixed epoch ms (random part fixed). */
function id(ms: number): string {
  let time = "";
  let m = ms;
  for (let i = 9; i >= 0; i--) {
    time = ENCODING[m % 32] + time;
    m = Math.floor(m / 32);
  }
  return time + "AAAAAAAAAAAAAAAA";
}

function jsonl(file: string, events: AgentEvent[]): void {
  const chained = events.map((e, i) => (i === 0 ? e : { ...e, parentId: events[i - 1]!.id }));
  writeFileSync(file, chained.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** One assistant turn: user_message → tool pair → model_call → tail. */
function turn(opts: {
  start: number;
  model?: string;
  tool?: { name: string; ok: boolean; errorKind?: ToolErrorKind };
  status?: "done" | "error" | "cancelled";
  input?: number;
  output?: number;
}): AgentEvent[] {
  const events: AgentEvent[] = [];
  let t = opts.start;
  const uid = () => id(t++);
  events.push({ id: uid(), type: "user_message", text: "work" });
  if (opts.tool) {
    const callId = `call-${opts.start}`;
    events.push({ id: uid(), type: "tool_call", callId, name: opts.tool.name, args: {} });
    events.push({
      id: uid(),
      type: "tool_result",
      callId,
      ok: opts.tool.ok,
      output: opts.tool.ok ? "ok" : "bash: timed out after 100ms: some output",
      ...(opts.tool.errorKind !== undefined ? { errorKind: opts.tool.errorKind } : {}),
    });
  }
  events.push({
    id: uid(),
    type: "model_call",
    model: opts.model ?? "prov/alpha",
    usage: { inputTokens: opts.input ?? 10, outputTokens: opts.output ?? 5 },
  });
  const status = opts.status ?? "done";
  if (status === "error") events.push({ id: uid(), type: "error", reason: "rate_limited", message: "x" });
  else if (status === "cancelled") events.push({ id: uid(), type: "cancelled" });
  else events.push({ id: uid(), type: "done", usage: { inputTokens: opts.input ?? 10, outputTokens: opts.output ?? 5 }, models: [opts.model ?? "prov/alpha"] });
  return events;
}

/** Creates a temp project with one fixture session file; returns paths. */
function fixtureSession(events: AgentEvent[]): { home: string; cwd: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), "moh-analyze-"));
  const dir = projectSessionsDir(home, home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "01JTESTAAAAAAAAAAAAAAAAAAAAA.jsonl");
  jsonl(file, events);
  return { home, cwd: home, file };
}

describe("analyzeSession", () => {
  it("reports usage, tool health, permissions, shape and durations for one session", () => {
    const { home, file } = fixtureSession([
      { id: id(1000), type: "session_start", schemaVersion: 2, promptVersion: "p" },
      ...turn({ start: 2000, model: "prov/alpha", input: 100, output: 50, tool: { name: "bash", ok: false, errorKind: "timeout" } }),
      ...turn({ start: 9000, model: "prov/beta", input: 20, output: 4, status: "error" }),
      { id: id(11000), type: "permission_requested", callId: "c1", tool: "bash" },
      { id: id(12000), type: "permission_denied", callId: "c1", tool: "bash", reason: "rule" },
      { id: id(13000), type: "model_switched", from: "prov/alpha", to: "prov/beta" },
    ]);
    try {
      const report = analyzeSession(file);
      if ("error" in report) throw new Error(`unexpected error: ${report.error}`);

      expect(report.models).toHaveLength(2);
      const alpha = report.models.find((m) => m.model === "prov/alpha")!;
      expect(alpha.calls).toBe(1);
      expect(alpha.inputTokens).toBe(100);
      expect(alpha.outputTokens).toBe(50);

      expect(report.tools).toHaveLength(1);
      expect(report.tools[0]!.tool).toBe("bash");
      expect(report.tools[0]!.calls).toBe(1);
      expect(report.tools[0]!.fail).toBe(1);
      expect(report.tools[0]!.errorKinds).toEqual({ timeout: 1 });

      expect(report.permissions).toEqual({ requested: 1, granted: 0, denied: 1 });

      expect(report.shape).toEqual({
        turns: 2,
        done: 1,
        error: 1,
        cancelled: 0,
        userMessages: 2,
        compactions: 0,
        compactionFailures: 0,
        modelSwitches: 1,
        fallbacks: 0,
      });

      // Wall time: first → last event ULID time (1000 → 13000).
      expect(report.wallTimeMs).toBe(12000);
      // Tool duration: call at t=2001+? — call ULID 2001, result 2002 → 1ms per pairing.
      expect(report.toolDurationMs).toBe(1);
      expect(report.file).toBe(file);

      // Unpriced convention: tokens always, cost only when priced.
      const priced = report.models.filter((m) => m.estimatedCostUsd !== undefined);
      const unpriced = report.models.filter((m) => m.estimatedCostUsd === undefined);
      for (const m of unpriced) expect(m.inputTokens + m.outputTokens).toBeGreaterThan(0);
      expect(priced.length + unpriced.length).toBe(report.models.length);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("counts only the active branch when the session has forks", () => {
    const t1 = turn({ start: 2000, model: "prov/alpha", input: 100, output: 50 });
    const t2 = turn({ start: 9000, model: "prov/beta", input: 20, output: 4 });
    const t3 = turn({ start: 16000, model: "prov/gamma", input: 7, output: 2 });
    // Real fork shape (#575): t2 branches off t1's tail (parentId = t1's
    // tail, an off-path sibling of t3); the head points at t3. Written
    // raw — no sequential chaining, parentIds are explicit here.
    const home = mkdtempSync(join(tmpdir(), "moh-analyze-"));
    const dir = projectSessionsDir(home, home);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "01JTESTAAAAAAAAAAAAAAAAAAAAA.jsonl");
    const events: AgentEvent[] = [
      { id: id(1000), type: "session_start", schemaVersion: 2, promptVersion: "p" },
      ...t1.map((e, i) => (i === 0 ? { ...e, parentId: id(1000) } : { ...e, parentId: t1[i - 1]!.id })),
      ...t2.map((e, i) => (i === 0 ? { ...e, parentId: t1[t1.length - 1]!.id } : { ...e, parentId: t2[i - 1]!.id })),
      { id: id(8000), type: "branch_switched", to: t3[0]!.id!, parentId: t1[t1.length - 1]!.id },
      ...t3.map((e, i) => (i === 0 ? { ...e, parentId: id(8000) } : { ...e, parentId: t3[i - 1]!.id })),
    ];
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    try {
      const report = analyzeSession(file);
      if ("error" in report) throw new Error(`unexpected error: ${report.error}`);

      // Only t1 + t3 count; t2 is off-path and never parsed into stats.
      expect(report.shape.turns).toBe(2);
      expect(report.models.map((m) => m.model).sort()).toEqual(["prov/alpha", "prov/gamma"]);
      // Tree stats describe the full topology: 2 branches (t2's off-path
      // tip and t3's active tip).
      expect(report.tree.branchCount).toBe(2);
      expect(report.tree.activePathTurns).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns an explicit error for a missing, corrupt or empty log", () => {
    expect("error" in analyzeSession(join(tmpdir(), "moh-analyze-missing.jsonl"))).toBe(true);

    const { home, file } = fixtureSession([{ id: id(1000), type: "session_start", schemaVersion: 2, promptVersion: "p" }]);
    // Corrupt: a non-JSON line is rejected by the store reader.
    writeFileSync(file, "{not json\n");
    expect("error" in analyzeSession(file)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});
