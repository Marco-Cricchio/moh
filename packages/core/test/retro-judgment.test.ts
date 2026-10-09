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
import { RetroStore, retroSignature } from "../src/retro";
import {
  parseJudgmentFindings,
  retroTranscript,
  selectJudgmentBatch,
  RETRO_JUDGMENT_BATCH,
} from "../src/retro-judgment";
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
      mohHome: home,
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
