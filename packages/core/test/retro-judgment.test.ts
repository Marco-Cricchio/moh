/**
 * The judgement pipeline (ADR-0075, #1275): deterministic coverage of the
 * parser, the batch selection and the threshold trigger. The subagent
 * itself is a model call — it is never exercised here; the extractor seam
 * stands in for it, exactly as the memory tests do.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { RETRO_DIGEST_INTERVAL_MS, RetroStore, retroSignature } from "../src/retro";
import {
  closedSessions,
  parseJudgmentFindings,
  retroTranscript,
  selectJudgmentBatch,
  RETRO_JUDGMENT_BATCH,
} from "../src/retro-judgment";
import { projectSessionsDir, newSessionId } from "../src/session-store";
import { MockProvider } from "../src/mock-provider";
import { AgentSession } from "../src/session/session";
import { SessionStore } from "../src/session-store";
import type { AgentEvent } from "../src/types";

const dirs: string[] = [];

function tempDir(): string {
  const dir = join(tmpdir(), `moh-retro-judgment-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("judgement parser", () => {
  test("keeps valid findings, clamps confidence, drops unknown session tags", () => {
    const text = `Here you go:\n[{"category":"navigation","evidence":"spent 12 calls locating the session store","confidence":0.7,"session":"s-a"},{"category":"coding-standards","evidence":"added a rule-shaped comment","confidence":5,"session":"s-b"},{"category":"navigation","evidence":"tagged to nobody","confidence":0.9,"session":"ghost"}]`;
    const findings = parseJudgmentFindings(text, ["s-a", "s-b"]);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      category: "navigation",
      evidence: "spent 12 calls locating the session store",
      confidence: 0.7,
      session: "s-a",
    });
    expect(findings[1]?.confidence).toBe(1);
  });

  test("a missing confidence defaults to the judgement floor, not certainty", () => {
    const findings = parseJudgmentFindings(`[{"category":"navigation","evidence":"x","session":"s-a"}]`, ["s-a"]);
    expect(findings[0]?.confidence).toBe(0.5);
  });

  test("unparseable output throws (the caller fails silent)", () => {
    expect(() => parseJudgmentFindings("no array here", ["s-a"])).toThrow();
  });
});

describe("judgement batch selection", () => {
  test("closedSessions speaks mohHome: resolves the project sessions under <mohHome>/projects/<slug>", () => {
    const home = tempDir();
    const mohHome = join(home, ".moh");
    const project = tempDir();
    // Production layout: SessionStore writes under <userHome>/.moh/projects/<slug>;
    // projectSessionsDir speaks user home, so derive it the same way the fix does.
    // Production layout: SessionStore.create writes under <userHome>/.moh/projects/<slug>
    // with a valid session id; closedSessions must find it from the moh dotdir alone.
    const dir = projectSessionsDir(project, join(mohHome, ".."));
    mkdirSync(dir, { recursive: true });
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "p" },
      { type: "user_message", text: "closed session body" },
    ] as unknown as AgentEvent[];
    writeFileSync(join(dir, `${newSessionId()}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const summaries = closedSessions(project, mohHome);
    expect(summaries.length).toBe(1);
  });

  test("reads closed sessions newest-first, skips the open one and unreadable files", () => {
    const dir = tempDir();
    const good = join(dir, "session-aaa.jsonl");
    const other = join(dir, "session-bbb.jsonl");
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "p" },
      { type: "user_message", text: "find the retro store" },
      { type: "tool_call", callId: "c1", name: "grep", args: {} },
    ] as unknown as AgentEvent[];
    writeFileSync(good, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(other, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const summaries = [
      { file: good, id: "session-aaa", title: "a", derivedTitle: "a", mtimeMs: 2, consumed: false, pinned: false },
      { file: join(dir, "missing.jsonl"), id: "session-gone", title: "g", derivedTitle: "g", mtimeMs: 1, consumed: false, pinned: false },
      { file: other, id: "session-bbb", title: "b", derivedTitle: "b", mtimeMs: 3, consumed: false, pinned: false },
    ];
    const batch = selectJudgmentBatch(summaries, { exclude: "session-bbb" });
    expect(batch.map((entry) => entry.id)).toEqual(["session-aaa"]);
    expect(batch[0]?.transcript).toContain("find the retro store");
  });

  test("a session with no user turn contributes nothing", () => {
    const dir = tempDir();
    const file = join(dir, "session-empty.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session_start", schemaVersion: 1, promptVersion: "p" }) + "\n");
    const batch = selectJudgmentBatch(
      [{ file, id: "session-empty", title: "e", derivedTitle: "e", mtimeMs: 1, consumed: false, pinned: false }],
      {},
    );
    expect(batch).toEqual([]);
  });
});

describe("judgement threshold", () => {
  test("counts closed sessions durably and fires on the batch boundary", () => {
    const store = new RetroStore(tempDir());
    expect(store.judgmentDue(RETRO_JUDGMENT_BATCH)).toBe(false);
    for (let i = 0; i < RETRO_JUDGMENT_BATCH - 1; i++) store.noteClosedSession();
    expect(store.closedSinceBatch()).toBe(RETRO_JUDGMENT_BATCH - 1);
    expect(store.judgmentDue(RETRO_JUDGMENT_BATCH)).toBe(false);
    store.noteClosedSession();
    expect(store.judgmentDue(RETRO_JUDGMENT_BATCH)).toBe(true);
    store.markJudgmentRun();
    expect(store.closedSinceBatch()).toBe(0);
    expect(store.judgmentDue(RETRO_JUDGMENT_BATCH)).toBe(false);
  });
});

describe("judgement batch skip reporting", () => {
  test("noteJudgmentSkip emits at most once per digest interval, durably", () => {
    const store = new RetroStore(tempDir());
    const now = new Date("2026-10-11T12:00:00Z");
    expect(store.noteJudgmentSkip(now)).toBe(true);
    expect(store.noteJudgmentSkip(new Date(now.getTime() + 1000))).toBe(false);
    expect(store.noteJudgmentSkip(new Date(now.getTime() + RETRO_DIGEST_INTERVAL_MS))).toBe(true);
  });

  test("a full batch due with an empty selection emits one retro_batch_skipped, rate-limited across sessions", async () => {
    const dir = tempDir();
    const store = new RetroStore(join(dir, "retro"));
    for (let i = 0; i < RETRO_JUDGMENT_BATCH; i++) store.noteClosedSession();
    const session = new AgentSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" as const }]),
      cwd: dir,
      mohHome: join(dir, "moh"),
      retro: { dir: store.dir },
      retroJudgment: async () => [],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await session.dispose();
    const skipped = session.history().filter((e) => e.type === "retro_batch_skipped");
    expect(skipped).toHaveLength(1);
    const second = new AgentSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" as const }]),
      cwd: dir,
      mohHome: join(dir, "moh"),
      retro: { dir: store.dir },
      retroJudgment: async () => [],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await second.dispose();
    expect(second.history().filter((e) => e.type === "retro_batch_skipped")).toHaveLength(0);
  });
});

describe("judgement session integration", () => {
  test("runs the batch once the threshold is reached and appends its findings", async () => {
    const home = tempDir();
    const cwd = tempDir();
    const store = new RetroStore(join(home, "retro"));
    // One real closed session on disk: the batch is selected from the
    // project's session directory, not from a fixture.
    const closed = SessionStore.create(cwd, home);
    closed.append({ type: "session_start", schemaVersion: 2, promptVersion: "p" });
    closed.append({ type: "user_message", text: "why is this module so hard to find" });
    closed.dispose();
    for (let i = 0; i < RETRO_JUDGMENT_BATCH; i++) store.noteClosedSession();
    const seen: string[][] = [];
    const session = new AgentSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" as const }]),
      cwd,
      mohHome: join(home, ".moh"),
      retro: { dir: store.dir },
      retroJudgment: async (input) => {
        seen.push(input.sessions.map((entry) => entry.id));
        return [{
          category: "navigation",
          evidence: "the agent re-read the same module three times",
          confidence: 0.7,
          session: input.sessions[0]!.id,
          signature: retroSignature("navigation", "the agent re-read the same module three times"),
        }];
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await session.dispose();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(store.read().map((finding) => finding.category)).toEqual(["navigation"]);
    expect(store.closedSinceBatch()).toBe(1);
  });

  // #1443 characterization: the judgement run under a dispose budget.
  function dueJudgmentSession(judge: () => Promise<void>) {
    const home = tempDir();
    const cwd = tempDir();
    const store = new RetroStore(join(home, "retro"));
    const closed = SessionStore.create(cwd, home);
    closed.append({ type: "session_start", schemaVersion: 2, promptVersion: "p" });
    closed.append({ type: "user_message", text: "why is this module so hard to find" });
    closed.dispose();
    for (let i = 0; i < RETRO_JUDGMENT_BATCH; i++) store.noteClosedSession();
    const session = new AgentSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" as const }]),
      cwd,
      mohHome: join(home, ".moh"),
      retro: { dir: store.dir },
      retroJudgment: async (input) => {
        await judge();
        return [{
          category: "navigation",
          evidence: "the agent re-read the same module three times",
          confidence: 0.7,
          session: input.sessions[0]!.id,
          signature: retroSignature("navigation", "the agent re-read the same module three times"),
        }];
      },
    });
    return { session, store };
  }

  test("dispose({timeoutMs}) stops waiting a slow judgement run at the budget", async () => {
    let release!: () => void;
    let started = false;
    const { session, store } = dueJudgmentSession(() => {
      started = true;
      return new Promise<void>((resolve) => { release = resolve; });
    });
    const t0 = performance.now();
    await session.dispose({ timeoutMs: 150 });
    const elapsed = performance.now() - t0;
    expect(started).toBe(true);
    expect(elapsed).toBeLessThan(1500);
    // Returned at the budget: the run had not appended anything yet.
    expect(store.read()).toEqual([]);
    release();
  });

  test("dispose({timeoutMs}) still awaits a judgement run that settles within the budget", async () => {
    const { session, store } = dueJudgmentSession(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
    await session.dispose({ timeoutMs: 5_000 });
    expect(store.read().map((finding) => finding.category)).toEqual(["navigation"]);
  });

  test("below the threshold nothing runs", async () => {
    const dir = tempDir();
    const store = new RetroStore(dir);
    let called = 0;
    const session = new AgentSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" as const }]),
      cwd: dir,
      retro: { dir },
      retroJudgment: async () => {
        called += 1;
        return [];
      },
    });
    await session.dispose();
    expect(called).toBe(0);
    expect(store.closedSinceBatch()).toBe(1);
  });
});

describe("transcript projection", () => {
  test("keeps user messages, tool names and errors, and is bounded", () => {
    const events = [
      { type: "user_message", text: "  do the thing  " },
      { type: "tool_call", callId: "c", name: "bash", args: {} },
      { type: "error", message: "boom" },
    ] as unknown as AgentEvent[];
    expect(retroTranscript(events)).toBe("user: do the thing\ntool: bash\nerror: boom");
  });
});
