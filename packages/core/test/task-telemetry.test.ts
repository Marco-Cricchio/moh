/**
 * #1101: performance and task-outcome telemetry — the explicit client
 * seams (`declareTask` / `recordVerification` / `recordTaskOutcome`),
 * the redaction bound, and the read-only projections. Every assertion
 * reads metadata only; the privacy review is an assertion too.
 */
import { describe, expect, it } from "bun:test";
import { redactSummary, SUMMARY_MAX_CHARS } from "../src/task/telemetry";
import {
  acceptedTaskFixture,
  performanceByModel,
  taskReport,
  concurrencyReport,
} from "../src/performance/telemetry";
import type { AgentEvent } from "../src/types";
import { modelCallOf, sessionOf, textCallEvents } from "./helpers.task-telemetry";

void SUMMARY_MAX_CHARS;

describe("task-outcome client seams (#1101)", () => {
  it("declareTask records a task_declared event; a blank id is refused with a note", async () => {
    const s = sessionOf();
    const generated = s.declareTask();
    expect(generated).toBeString();
    let events = s.history();
    expect(events.some((e) => e.type === "task_declared" && e.taskId === generated)).toBe(true);

    const explicit = s.declareTask("ISSUE-42", { reopens: "ISSUE-17" });
    expect(explicit).toBe("ISSUE-42");
    const declared = s.history().filter((e: AgentEvent) => e.type === "task_declared").at(-1) as Extract<AgentEvent, { type: "task_declared" }>;
    expect(declared.reopens).toBe("ISSUE-17");

    // A blank explicit id: visible refusal note, nothing recorded.
    const refused = s.declareTask("   ");
    expect(refused).toBe("");
    expect(s.history().some((e) => e.type === "session_note" && e.text.includes("refused"))).toBe(true);
    expect(s.history().filter((e) => e.type === "task_declared")).toHaveLength(2);
    void events;
    events = [];
  });

  it("verification and outcome require a declared task — undeclared ids are refused visibly", async () => {
    const s = sessionOf();
    s.recordVerification("GHOST", { category: "test", ok: true });
    s.recordTaskOutcome("GHOST", "accepted");
    const notes = s.history().filter((e) => e.type === "session_note");
    expect(notes).toHaveLength(2);
    expect(s.history().some((e) => e.type === "task_verification")).toBe(false);
    expect(s.history().some((e) => e.type === "task_outcome")).toBe(false);

    s.declareTask("T1");
    s.recordVerification("T1", { category: "test", ok: true, exitStatus: 0, durationMs: 900, summary: "42 pass" });
    s.recordTaskOutcome("T1", "accepted");
    expect(s.history().some((e) => e.type === "task_verification")).toBe(true);
    expect(s.history().some((e) => e.type === "task_outcome" && e.outcome === "accepted")).toBe(true);
  });

  it("repeated verification keeps both runs; the projection reads the latest verdict at outcome time", async () => {
    const s = sessionOf();
    s.declareTask("T1");
    s.recordVerification("T1", { category: "test", ok: false, exitStatus: 1, summary: "3 failing" });
    s.recordVerification("T1", { category: "typecheck", ok: false, exitStatus: 2 });
    s.recordVerification("T1", { category: "test", ok: true, exitStatus: 0 });
    const report = taskReport(s.history());
    expect(report.tasks[0]!.verifications).toHaveLength(3);
    // No outcome yet: unknown — the failed-then-passed verdict does not
    // invent success.
    expect(report.tasks[0]!.outcome).toBeUndefined();
    expect(report.unknown).toBe(1);

    s.recordTaskOutcome("T1", "accepted");
    const after = taskReport(s.history());
    // The last run before the verdict passed.
    expect(after.tasks[0]!.verified).toBe("passed");

    // Failed-then-outcome: the verdict reads the failing run.
    s.declareTask("T2");
    s.recordVerification("T2", { category: "build", ok: true });
    s.recordVerification("T2", { category: "build", ok: false });
    s.recordTaskOutcome("T2", "rejected");
    const rejected = taskReport(s.history()).tasks.find((t) => t.taskId === "T2")!;
    expect(rejected.verified).toBe("failed");
    expect(rejected.outcome).toBe("rejected");
  });

  it("unknown is the default: a task with no outcome event contributes no acceptance", async () => {
    const s = sessionOf();
    s.declareTask("T1");
    const report = taskReport(s.history());
    expect(report.tasks[0]!.outcome).toBeUndefined();
    expect(report.unknown).toBe(1);
    expect(report.accepted).toBe(0);
    // No accepted rollup field without acceptance evidence.
    expect(report.tasks[0]!.accepted).toBeUndefined();
  });

  it("reopened tasks keep the revision relation", async () => {
    const s = sessionOf();
    s.declareTask("T1");
    s.recordTaskOutcome("T1", "revision-needed");
    s.declareTask("T1-r2", { reopens: "T1" });
    const report = taskReport(s.history());
    expect(report.revisionNeeded).toBe(1);
    const reopened = report.tasks.find((t) => t.taskId === "T1-r2")!;
    expect(reopened.reopens).toBe("T1");
  });
});

describe("task projection: contributing calls and accepted rollup (#1101)", () => {
  it("calls between declaration and outcome attribute to the task; accepted carries the rollup", async () => {
    const s = sessionOf(textCallEvents());
    s.declareTask("T1");
    await s.send("do the work");
    s.recordTaskOutcome("T1", "accepted");
    await s.send("after the verdict");

    const report = taskReport(s.history());
    const task = report.tasks[0]!;
    expect(task.outcome).toBe("accepted");
    expect(task.contributingCalls.length).toBeGreaterThanOrEqual(1);
    expect(task.contributingCalls[0]!.servingModel).toBe("gw/auto");
    // Acceptance evidence exists → the rollup is present with real sums.
    expect(task.accepted!.calls).toBeGreaterThanOrEqual(1);
    expect(task.accepted!.inputTokens).toBeGreaterThan(0);
  });

  it("partial call chains: calls before declaration and after the verdict belong to no task", async () => {
    const s = sessionOf(textCallEvents());
    await s.send("before the task existed");
    s.declareTask("T1");
    s.recordTaskOutcome("T1", "rejected");
    await s.send("after the verdict");

    const report = taskReport(s.history());
    expect(report.tasks[0]!.outcome).toBe("rejected");
    expect(report.tasks[0]!.contributingCalls).toHaveLength(0);
    expect(report.tasks[0]!.accepted).toBeUndefined();
  });

  it("no prompt text, completion text or summary content beyond the bound enters the projection", async () => {
    const s = sessionOf(textCallEvents("CLASSIFIED-CONTENT"));
    s.declareTask("T1");
    await s.send("SECRET-PROMPT-TEXT");
    s.recordVerification("T1", { category: "test", ok: true, summary: "failed: see SECRET-DIAG-OUTPUT for details" });
    s.recordTaskOutcome("T1", "accepted");
    const report = JSON.stringify(taskReport(s.history()));
    expect(report).not.toContain("SECRET-PROMPT-TEXT");
    expect(report).not.toContain("CLASSIFIED-CONTENT");
    // The verification summary metadata rides the raw event, redacted and
    // bounded — checked on the event itself below.
  });

  it("redactSummary: credentials redacted, one line, bounded", () => {
    expect(redactSummary("api_key=sk-123 and token: abc")).toBe("api_key=[redacted] and token: [redacted]");
    expect(redactSummary("failed https://x.dev/v1?key=SECRET#frag")).toBe("failed https://x.dev/v1?key=[redacted]");
    expect(redactSummary("a\nb\r\tc")).toBe("a b c");
    const long = redactSummary("x".repeat(5000));
    expect(long.length).toBe(SUMMARY_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("performance projection (#1101)", () => {
  it("TTFC, active duration, wait split, latency percentiles and interrupted rate by model", () => {
    const events: AgentEvent[] = [
      modelCallOf("m1", { outcome: "completed", durationMs: 1000, ttfcMs: 200, callId: "c1", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z" }),
      // Same logical call, same model retry: 500ms wait gap, 300ms active.
      modelCallOf("m1", { outcome: "completed", durationMs: 300, ttfcMs: 100, callId: "c1", startedAt: "2026-01-01T00:00:01.500Z", endedAt: "2026-01-01T00:00:01.800Z" }),
      modelCallOf("m2", { outcome: "aborted", durationMs: 50, callId: "c2" }),
      modelCallOf("m2", { outcome: "completed", durationMs: 400, ttfcMs: 80, callId: "c3" }),
      // A tool-only call: no ttfc sample, still a latency sample.
      modelCallOf("m2", { outcome: "completed", durationMs: 600, callId: "c4" }),
    ];
    const rows = performanceByModel(events);
    const m1 = rows.find((r) => r.model === "m1")!;
    expect(m1.calls).toBe(1);
    expect(m1.completed).toBe(2);
    expect(m1.activeDurationMs).toBe(1300);
    expect(m1.waitDurationMs).toBe(500);
    expect(m1.ttfc!.samples).toBe(2);
    expect(m1.latency!.p50Ms).toBe(300);
    const m2 = rows.find((r) => r.model === "m2")!;
    expect(m2.calls).toBe(3);
    expect(m2.aborted).toBe(1);
    expect(m2.interruptedRate).toBeCloseTo(1 / 3);
    // The aborted attempt contributes no ttfc; the tool-only call none.
    expect(m2.ttfc!.samples).toBe(1);
  });

  it("a fallback move's gap belongs to neither model's wait", () => {
    const events: AgentEvent[] = [
      modelCallOf("primary", { outcome: "failed", durationMs: 100, callId: "c1", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:00.100Z" }),
      modelCallOf("backup", { outcome: "completed", durationMs: 200, callId: "c1", startedAt: "2026-01-01T00:00:01.000Z" }),
    ];
    const rows = performanceByModel(events);
    expect(rows.find((r) => r.model === "primary")!.waitDurationMs).toBe(0);
    expect(rows.find((r) => r.model === "backup")!.waitDurationMs).toBe(0);
    // The call counts on both models it touched.
    expect(rows.find((r) => r.model === "primary")!.calls).toBe(1);
    expect(rows.find((r) => r.model === "backup")!.calls).toBe(1);
  });

  it("concurrency: parent and child intervals overlap — the union is the honest busy time", () => {
    const report = concurrencyReport([
      { session: "parent", startMs: 0, endMs: 1000 },
      { session: "child-a", startMs: 200, endMs: 700 },
      { session: "child-b", startMs: 500, endMs: 1200 },
    ]);
    // sum = 1000 + 500 + 700 = 2200; union = [0,1200] = 1200.
    expect(report.sumMs).toBe(2200);
    expect(report.busyMs).toBe(1200);
    expect(report.concurrentMs).toBe(1000);
    expect(report.maxDepth).toBe(3);
    // Empty input: zeros, never NaN.
    expect(concurrencyReport([])).toEqual({ busyMs: 0, sumMs: 0, concurrentMs: 0, maxDepth: 0 });
  });
});

describe("privacy review (#1101)", () => {
  it("the shipped event and projection shapes carry no content fields", () => {
    const s = sessionOf(textCallEvents("PROMPT-BODY"));
    s.declareTask("T1");
    s.recordVerification("T1", { category: "test", ok: true, summary: "password=hunter2 all 5 tests passed" });
    const verification = s.history().find((e) => e.type === "task_verification") as Extract<AgentEvent, { type: "task_verification" }>;
    // Credential-shaped assignment redacted at the seam.
    expect(verification.summary).not.toContain("hunter2");
    expect(verification.summary).toContain("[redacted]");
    // Task ids only, never prompt text — the projection's JSON has no
    // message field at all.
    const projection = JSON.stringify(performanceByModel(s.history())) + JSON.stringify(taskReport(s.history()));
    expect(projection).not.toContain("PROMPT-BODY");
    expect(projection).not.toContain("message");
  });
});



describe("accepted-task comparison fixture (#1101 follow-up)", () => {
  it("compares accepted tasks only — unknown values are excluded, never imputed", async () => {
    const s = sessionOf(textCallEvents());
    // T1: one turn, a failing then passing verification, accepted.
    s.declareTask("T1");
    await s.send("work on T1");
    s.recordVerification("T1", { category: "test", ok: false });
    s.recordVerification("T1", { category: "test", ok: true });
    s.recordTaskOutcome("T1", "accepted");
    // T2: a revision of T1, accepted first-pass.
    s.declareTask("T2", { reopens: "T1" });
    await s.send("work on T2");
    s.recordVerification("T2", { category: "test", ok: true });
    s.recordTaskOutcome("T2", "accepted");
    // T3: no outcome — must not appear in the fixture.
    s.declareTask("T3");
    await s.send("work on T3");

    const events = s.history();
    const report = taskReport(events);
    const fixture = acceptedTaskFixture(report, events);
    expect(fixture.map((r) => r.taskId).sort()).toEqual(["T1", "T2"]);
    const t1 = fixture.find((r) => r.taskId === "T1")!;
    expect(t1.verifiedFirstPass).toBe(false);
    expect(t1.revisions).toBe(0);
    expect(t1.servingModels).toEqual(["gw/auto"]);
    expect(t1.latencyP50Ms).toBeGreaterThanOrEqual(0);
    expect(t1.calls).toBeGreaterThanOrEqual(1);
    const t2 = fixture.find((r) => r.taskId === "T2")!;
    expect(t2.verifiedFirstPass).toBe(true);
    expect(t2.revisions).toBe(1);
    // No prompt text in the fixture either.
    expect(JSON.stringify(fixture)).not.toContain("work on");
  });
});
