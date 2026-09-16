/**
 * #714: multi-session telemetry aggregator tests. Fixture session files on
 * disk; every assertion stays on metadata (calls, tokens, statuses,
 * durations) — never message content.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateTelemetry, aggregateLocalUsage, type AgentEvent } from "../src/index";
import { projectSessionsDir } from "../src/session-store";
import { ENCODING } from "../src/session/ulid";

/** Deterministic ULID at a fixed epoch ms (random part fixed): immune to
 * the process-monotonic clamp in `newUlid`, which a prior test's real-time
 * mint would trigger. */
function id(ms: number): string {
  let time = "";
  let m = ms;
  for (let i = 9; i >= 0; i--) {
    time = ENCODING[m % 32] + time;
    m = Math.floor(m / 32);
  }
  return time + "AAAAAAAAAAAAAAAA"; // 16 zero random chars
}

function jsonl(file: string, events: AgentEvent[]): void {
  // Chains parentIds exactly like the real writer (#575): each event
  // follows the previous one.
  const chained = events.map((e, i) => (i === 0 ? e : { ...e, parentId: events[i - 1]!.id }));
  writeFileSync(file, chained.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** One assistant turn: user_message → tool pair → model_call → done/error/cancelled. */
function turn(opts: {
  start: number;
  model?: string;
  thinkingLevel?: string;
  tool?: { name: string; ok: boolean; timeoutMs?: number };
  status?: "done" | "error" | "cancelled";
  errorReason?: string;
  input?: number;
  output?: number;
}): AgentEvent[] {
  const events: AgentEvent[] = [];
  let t = opts.start;
  const uid = () => id(t++);
  events.push({ id: uid(), type: "user_message", text: "work" });
  if (opts.tool) {
    const callId = `call-${opts.start}`;
    events.push({
      id: uid(),
      type: "tool_call",
      callId,
      name: opts.tool.name,
      args: {},
      ...(opts.tool.timeoutMs !== undefined ? { timeoutMs: opts.tool.timeoutMs } : {}),
    });
    events.push({
      id: uid(),
      type: "tool_result",
      callId,
      ok: opts.tool.ok,
      output: opts.tool.ok ? "ok" : "bash: timed out after 100ms: some output",
    });
  }
  events.push({
    id: uid(),
    type: "model_call",
    model: opts.model ?? "prov/alpha",
    usage: { inputTokens: opts.input ?? 10, outputTokens: opts.output ?? 5 },
    ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel as any } : {}),
  });
  const status = opts.status ?? "done";
  if (status === "error") events.push({ id: uid(), type: "error", reason: opts.errorReason ?? "rate_limited", message: "x" });
  else if (status === "cancelled") events.push({ id: uid(), type: "cancelled" });
  else events.push({ id: uid(), type: "done", usage: { inputTokens: opts.input ?? 10, outputTokens: opts.output ?? 5 }, models: [opts.model ?? "prov/alpha"] });
  return events;
}

/** Creates a temp project with the fixture sessions; returns { home, cwd }. */
function fixtureProject(): { home: string; cwd: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), "moh-telemetry-"));
  const dir = projectSessionsDir(home, home);
  mkdirSync(dir, { recursive: true });
  return { home, cwd: home, dir };
}

describe("aggregateTelemetry", () => {
  it("aggregates models, tools, route health, and per-session rollups across sessions", () => {
    const { home, cwd, dir } = fixtureProject();
    try {
      // Session A: two turns, one model with thinking, a failing tool, a fallback.
      jsonl(join(dir, "01JTESTAAAAAAAAAAAAAAAAAAAAA.jsonl"), [
        { id: id(1000), type: "session_start", schemaVersion: 2, promptVersion: "p" },
        ...turn({ start: 2000, model: "prov/alpha", thinkingLevel: "high", input: 100, output: 50, tool: { name: "bash", ok: false, timeoutMs: 100 } }),
        ...turn({ start: 9000, model: "prov/beta", input: 20, output: 4, status: "error", errorReason: "rate_limited" }),
        { id: id(11000), type: "fallback", from: "prov/alpha", to: "prov/beta", reason: "rate_limited" },
        { id: id(12000), type: "route_serving", selected: "prov/alpha", serving: "prov/beta", previous: "prov/alpha" },
      ]);

      // Session B: one clean turn, one subagent.
      jsonl(join(dir, "01JTESTBBBBBBBBBBBBBBBBBBBB.jsonl"), [
        { id: id(2000), type: "session_start", schemaVersion: 2, promptVersion: "p" },
        ...turn({ start: 3000, model: "prov/alpha", input: 7, output: 3 }),
        {
          id: id(4000),
          type: "subagent_result",
          callId: "sa-1",
          name: "research",
          status: "done",
          usage: { inputTokens: 11, outputTokens: 2 },
          log: "child.jsonl",
        },
      ]);

      // A corrupt file: skipped, never fatal.
      writeFileSync(join(dir, "01JTESTCCCCCCCCCCCCCCCCCCCC.jsonl"), "{not json\n");

      const report = aggregateTelemetry({ cwd, home });
      expect(report.sessionsScanned).toBe(3);
      expect(report.sessionsSkipped).toBe(1);

      // Per-model usage: failed calls excluded (none here), thinking audited.
      const alpha = report.models.find((m) => m.model === "prov/alpha")!;
      expect(alpha.calls).toBe(2);
      expect(alpha.inputTokens).toBe(107);
      expect(alpha.outputTokens).toBe(53);
      expect(alpha.thinkingLevels).toEqual({ high: 1 });
      const beta = report.models.find((m) => m.model === "prov/beta")!;
      expect(beta.calls).toBe(1);
      expect(beta.inputTokens).toBe(20);

      // Tool stats: bash 1 call, fail, timed out; call at t=2001, result at t=2002.
      expect(report.tools).toEqual([
        { tool: "bash", calls: 1, ok: 0, fail: 1, timeouts: 1, totalDurationMs: 1 },
      ]);

      // Route health.
      expect(report.route.fallbacks).toEqual([{ from: "prov/alpha", to: "prov/beta", reason: "rate_limited", count: 1 }]);
      expect(report.route.routeServing).toEqual([{ selected: "prov/alpha", serving: "prov/beta", previous: "prov/alpha", count: 1 }]);
      expect(report.route.turnErrors).toEqual({ rate_limited: 1 });

      // Per-session rollups.
      expect(report.sessions).toHaveLength(2);
      const a = report.sessions.find((s) => s.id === "01JTESTAAAAAAAAAAAAAAAAAAAAA")!;
      expect(a.turns).toEqual({ done: 1, error: 1, cancelled: 0 });
      expect(a.tokens).toEqual({ inputTokens: 120, outputTokens: 54 });
      expect(a.modelsServed.sort()).toEqual(["prov/alpha", "prov/beta"]);
      expect(a.durationMs).toBe(11000); // last event 12000, first 1000
      expect(a.subagents).toEqual([]);
      const b = report.sessions.find((s) => s.id === "01JTESTBBBBBBBBBBBBBBBBBBBB")!;
      expect(b.turns).toEqual({ done: 1, error: 0, cancelled: 0 });
      expect(b.subagents).toEqual([{ name: "research", status: "done", calls: 1, inputTokens: 11, outputTokens: 2 }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns an empty report when the project has no sessions", () => {
    const home = mkdtempSync(join(tmpdir(), "moh-telemetry-empty-"));
    try {
      const report = aggregateTelemetry({ cwd: home, home });
      expect(report.sessionsScanned).toBe(0);
      expect(report.models).toEqual([]);
      expect(report.tools).toEqual([]);
      expect(report.sessions).toEqual([]);
      expect(report.route.fallbacks).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("matches aggregateLocalUsage per model on the same fixture", () => {
    const { home, cwd, dir } = fixtureProject();
    try {
      jsonl(join(dir, "01JTESTDDDDDDDDDDDDDDDDDDDDDD.jsonl"), [
        { id: id(1000), type: "session_start", schemaVersion: 2, promptVersion: "p" },
        ...turn({ start: 2000, model: "prov/alpha", input: 100, output: 50 }),
        // A failed call consumes nothing measurable and is excluded by both.
        {
          id: id(3000),
          type: "model_call",
          model: "prov/beta",
          usage: { inputTokens: 999, outputTokens: 999 },
          failed: true,
        },
        ...turn({ start: 4000, model: "prov/alpha", input: 20, output: 4 }),
      ]);
      const report = aggregateTelemetry({ cwd, home });
      const raw = readFileSync(join(dir, "01JTESTDDDDDDDDDDDDDDDDDDDDDD.jsonl"), "utf8");
      const events: AgentEvent[] = raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
      const local = aggregateLocalUsage(events);
      expect(local.length).toBeGreaterThan(0);
      for (const row of local) {
        const agg = report.models.find((m) => m.model === row.model);
        expect(agg?.calls).toBe(row.calls);
        expect(agg?.inputTokens).toBe(row.inputTokens);
        expect(agg?.outputTokens).toBe(row.outputTokens);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("sums call→result ULID deltas per tool, skipping unpaired sides", () => {
    const { home, cwd, dir } = fixtureProject();
    try {
      const events: AgentEvent[] = [
        { id: id(1000), type: "session_start", schemaVersion: 2, promptVersion: "p" },
        // read: 10 → 25 (15ms), 30 → 40 (10ms) — two pairs summed.
        { id: id(1000), type: "tool_call", callId: "r1", name: "read", args: {} },
        { id: id(1005), type: "user_message", text: "work" },
        { id: id(1025), type: "tool_result", callId: "r1", ok: true, output: "ok" },
        { id: id(1030), type: "tool_call", callId: "r2", name: "read", args: {} },
        { id: id(1040), type: "tool_result", callId: "r2", ok: false, output: "nope" },
        // bash: call with no result — counts in calls, not in duration.
        { id: id(1050), type: "tool_call", callId: "b1", name: "bash", args: {} },
        // edit: result with no call — ignored entirely.
        { id: id(1060), type: "tool_result", callId: "e1", ok: true, output: "ok" },
      ];
      jsonl(join(dir, "01JTESTEEEEEEEEEEEEEEEEEEEE.jsonl"), events);
      const report = aggregateTelemetry({ cwd, home });
      expect(report.tools).toEqual([
        { tool: "read", calls: 2, ok: 1, fail: 1, timeouts: 0, totalDurationMs: 35 },
        { tool: "bash", calls: 1, ok: 0, fail: 0, timeouts: 0, totalDurationMs: 0 },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("aggregateTelemetry maxSessions (#718)", () => {
  it("keeps only the N most recent sessions by mtime, dropped files unscanned", () => {
    const { home, cwd, dir } = fixtureProject();
    try {
      for (const [name, start] of [
        ["01JTESTAAAAAAAAAAAAAAAAAAAAA.jsonl", 1000],
        ["01JTESTBBBBBBBBBBBBBBBBBBBB.jsonl", 2000],
        ["01JTESTCCCCCCCCCCCCCCCCCCCC.jsonl", 3000],
      ] as const) {
        jsonl(join(dir, name), [
          { id: id(start), type: "session_start", schemaVersion: 2, promptVersion: "p" },
          ...turn({ start: start + 100, model: `prov/${name[7]!.toLowerCase()}`, input: 5, output: 1 }),
        ]);
        // Distinct mtimes: newest last (A→day 1, B→day 2, C→day 3).
        const t = new Date(Date.UTC(2026, 0, 1 + ["A", "B", "C"].indexOf(name[7]!)));
        utimesSync(join(dir, name), t, t);
      }
      const report = aggregateTelemetry({ cwd, home, maxSessions: 2 });
      expect(report.sessionsScanned).toBe(2);
      expect(report.sessions.map((s) => s.id).sort()).toEqual([
        "01JTESTBBBBBBBBBBBBBBBBBBBB",
        "01JTESTCCCCCCCCCCCCCCCCCCCC",
      ]);
      // Only the kept sessions' models aggregate.
      expect(report.models.map((m) => m.model).sort()).toEqual(["prov/b", "prov/c"]);
      // N larger than the file count scans everything.
      const all = aggregateTelemetry({ cwd, home, maxSessions: 10 });
      expect(all.sessionsScanned).toBe(3);
      expect(all.sessionsSkipped).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
