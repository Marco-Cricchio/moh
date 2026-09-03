/**
 * Session Handoff T1 (#434): the raw, non-LLM handoff artifact updated
 * post-turn under the project's local state directory, and the
 * `handoff.transport` moh.json setting (absent = Not Set = off).
 *
 * Post-turn prior art: the MemoryRunner trigger tests in memory.test.ts
 * (#88) — fail-silent, crash-safe, never blocking the turn.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AgentSession, MockProvider } from "../src/index";
import {
  HandoffRunner,
  buildRawHandoff,
  gitAnchor,
  handoffConfigSchema,
  transportActive,
  type RawHandoff,
} from "../src/handoff";

const TMP = join(import.meta.dir, "tmp-handoff");

function tmpDir(name: string): string {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function readHandoff(file: string): RawHandoff {
  return JSON.parse(readFileSync(file, "utf8")) as RawHandoff;
}

describe("handoff config", () => {
  test("absent handoff.transport parses and is Not Set/off", () => {
    const config = handoffConfigSchema.parse({});
    expect(transportActive(config)).toBe(false);
  });

  test("transport: none is explicit full-off", () => {
    expect(transportActive({ transport: "none" })).toBe(false);
  });

  test("transport: gist is active", () => {
    expect(transportActive({ transport: "gist" })).toBe(true);
  });

  test("an unknown transport value is a config error", () => {
    expect(handoffConfigSchema.safeParse({ transport: "sftp" }).success).toBe(false);
  });

  test("moh.json schema accepts a handoff block", async () => {
    const { mohConfigSchema } = await import("../src/config");
    const parsed = mohConfigSchema.parse({ handoff: { transport: "none" } });
    expect(parsed.handoff?.transport).toBe("none");
  });
});

describe("buildRawHandoff", () => {
  test("distills events, files, tests and counts from the log", () => {
    const dir = tmpDir("build");
    const events = [
      { type: "session_start", schemaVersion: 1, promptVersion: "v1" },
      { type: "user_message", text: "fix the bug" },
      { type: "tool_call", callId: "1", name: "write", args: { path: "src/a.ts", content: "x" } },
      { type: "tool_result", callId: "1", ok: true, output: "done" },
      { type: "tool_call", callId: "2", name: "edit", args: { path: "src/b.ts" } },
      { type: "tool_call", callId: "3", name: "bash", args: { command: "bun test src/a.test.ts" } },
      { type: "tool_call", callId: "4", name: "bash", args: { command: "git status" } },
      { type: "assistant_delta", text: "fixed" },
      { type: "error", reason: "boom", message: "boom" },
      { type: "done" },
    ] as any;
    const h = buildRawHandoff(events, "session-x", 1, dir, new Date("2026-09-02T10:00:00Z"), {});
    expect(h.kind).toBe("raw");
    expect(h.sessionId).toBe("session-x");
    expect(h.turns).toBe(1);
    expect(h.updatedAt).toBe("2026-09-02T10:00:00.000Z");
    expect(h.lastUserMessage).toBe("fix the bug");
    expect(h.lastAssistantMessage).toBe("fixed");
    expect(h.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(h.tests).toEqual(["bun test src/a.test.ts"]);
    expect(h.counts).toEqual({ toolCalls: 4, errors: 1, cancelled: 0 });
    expect(h.git).toEqual({}); // not a git repo: fields absent, never fake
  });

  test("records successful Wayfinder claims and message citations without tool output", () => {
    const h = buildRawHandoff([
      { type: "user_message", text: "continue #42 and https://github.com/o/r/issues/43" },
      { type: "tool_call", callId: "claim", name: "tracker_claim", args: { id: "42" } },
      { type: "tool_result", callId: "claim", ok: true, output: "claimed #42" },
      { type: "tool_call", callId: "failed", name: "tracker_claim", args: { id: "99" } },
      { type: "tool_result", callId: "failed", ok: false, output: "#98 must stay private" },
      { type: "assistant_delta", text: "working on #42" },
    ] as any, "s", 1, tmpDir("links"), new Date(), {});
    expect(h.wayfinderLinks).toEqual([
      { id: "42", relations: ["mentioned", "claimed"] },
      { id: "43", relations: ["mentioned"] },
    ]);
  });

  test("caps messages, files and tests", () => {
    const dir = tmpDir("caps");
    const events: any[] = [{ type: "user_message", text: "x".repeat(2000) }];
    for (let i = 0; i < 250; i++) {
      events.push({ type: "tool_call", callId: `f${i}`, name: "write", args: { path: `f${i}.ts` } });
    }
    for (let i = 0; i < 60; i++) {
      events.push({ type: "tool_call", callId: `t${i}`, name: "bash", args: { command: `run test ${i}` } });
    }
    const h = buildRawHandoff(events, "s", 1, dir);
    expect(h.lastUserMessage.length).toBe(500);
    expect(h.files).toHaveLength(200);
    expect(h.tests).toHaveLength(50);
  });

  test("gitAnchor reads branch, HEAD and dirty from a real repo", () => {
    const dir = tmpDir("git");
    const run = (...args: string[]) => Bun.spawnSync(args, { cwd: dir, stdout: "ignore", stderr: "ignore" });
    run("git", "init", "-q");
    run("git", "config", "user.email", "t@t");
    run("git", "config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "a");
    const anchor = gitAnchor(dir);
    expect(anchor.branch).toBe("master"); // fresh init: no detach, default name
    expect(anchor.dirty).toBe(true); // untracked file
    expect(anchor.head).toBeUndefined(); // no commits yet: no fake SHA
    run("git", "add", ".");
    run("git", "commit", "-qm", "init");
    const committed = gitAnchor(dir);
    expect(committed.head).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.dirty).toBe(false);
  });
});

describe("HandoffRunner", () => {
  test("writes the artifact atomically and fail-silent", () => {
    const dir = tmpDir("runner");
    const file = join(dir, "handoff.json");
    const runner = new HandoffRunner({ file, sessionId: "session-1", cwd: dir });
    const events = [
      { type: "user_message", text: "hi" },
      { type: "assistant_delta", text: "hello" },
      { type: "done" },
    ] as any;
    runner.turnSettled(1, events);
    expect(existsSync(file)).toBe(true);
    const h = readHandoff(file);
    expect(h.sessionId).toBe("session-1");
    expect(h.turns).toBe(1);
    expect(h.lastAssistantMessage).toBe("hello");
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false); // renamed away
  });

  test("an unwritable path never throws", () => {
    const runner = new HandoffRunner({
      file: join(tmpDir("runner-fail"), "no-such-dir", "sub", "handoff.json"),
      sessionId: "s",
      cwd: "/tmp",
    });
    // mkdirSync with recursive would succeed here, so force failure via a
    // path under a regular file instead.
    const dir = tmpDir("runner-fail2");
    writeFileSync(join(dir, "blocker"), "x");
    const failing = new HandoffRunner({ file: join(dir, "blocker", "handoff.json"), sessionId: "s", cwd: "/tmp" });
    expect(() => runner.turnSettled(1, [])).not.toThrow();
    expect(() => failing.turnSettled(1, [])).not.toThrow();
  });

  test("retains the accepted handoff as its chain predecessor", () => {
    const dir = tmpDir("runner-chain");
    const file = join(dir, "handoff.json");
    const runner = new HandoffRunner({
      file,
      sessionId: "session-b",
      cwd: dir,
      supersedes: { sessionId: "session-a", updatedAt: "2026-09-02T10:00:00.000Z" },
    });
    runner.turnSettled(1, []);
    expect(readHandoff(file).supersedes).toEqual({ sessionId: "session-a", updatedAt: "2026-09-02T10:00:00.000Z" });
  });

  test("artifactFile lands under projects/<slug>/", () => {
    const dir = tmpDir("path");
    const file = HandoffRunner.artifactFile(dir, join(dir, "moh-home"));
    expect(file.startsWith(join(dir, "moh-home", "projects"))).toBe(true);
    expect(file.endsWith("handoff.json")).toBe(true);
  });
});

describe("session integration", () => {
  test("post-turn: artifact exists and reflects the turn (events, files, tests)", async () => {
    const dir = tmpDir("session");
    const file = join(dir, "handoff.json");
    const session = new AgentSession({
      provider: MockProvider.scripted([
        {
          deltas: ["fixed it"],
          finish: "tool_calls" as const,
          toolCalls: [{ name: "bash", args: { command: "bun test packages/core/test/x.test.ts" } }],
        },
        { deltas: ["done and green"], finish: "stop" as const },
      ]),
      cwd: dir,
      permissions: { mode: "auto-accept" },
      tools: {
        bash: {
          name: "bash",
          description: "run",
          inputSchema: z.object({ command: z.string() }),
          async execute() {
            return "ok";
          },
        },
      },
      handoff: { file },
    });
    await session.send("fix the bug");
    await session.send("thanks");
    await session.dispose();
    const h = readHandoff(file);
    expect(h.kind).toBe("raw");
    expect(h.sessionId).toBeTruthy();
    expect(h.turns).toBe(2);
    expect(h.lastUserMessage).toBe("thanks");
    expect(h.lastAssistantMessage).toContain("done and green");
    expect(h.tests).toEqual(["bun test packages/core/test/x.test.ts"]);
    expect(h.counts.toolCalls).toBe(1);
  });

  test("a successful git push publishes only after this turn's artifact is written", async () => {
    const dir = tmpDir("push-publish");
    const file = join(dir, "handoff.json");
    let published: RawHandoff | undefined;
    const session = new AgentSession({
      provider: MockProvider.scripted([
        {
          deltas: [],
          finish: "tool_calls" as const,
          toolCalls: [{ name: "bash", args: { command: "git push" } }],
        },
        { deltas: ["pushed"], finish: "stop" as const },
      ]),
      cwd: dir,
      permissions: { mode: "auto-accept" },
      tools: { bash: { name: "bash", description: "run", inputSchema: z.object({ command: z.string() }), execute: () => "ok" } },
      handoff: {
        file,
        onGitPush: () => { published = readHandoff(file); },
      },
    });
    const result = await session.send("push it");
    expect(result.status).toBe("done");
    expect(session.history().find((event) => event.type === "tool_result")).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(published?.lastAssistantMessage).toBe("pushed");
    expect(published?.turns).toBe(1);
  });

  test("crash-safety: the artifact exists immediately after send() resolves", async () => {
    // No dispose(): a killed session still keeps the last completed turn.
    const dir = tmpDir("crash");
    const file = join(dir, "handoff.json");
    const session = new AgentSession({
      provider: MockProvider.scripted([{ deltas: ["partial state"], finish: "stop" as const }]),
      cwd: dir,
      handoff: { file },
    });
    await session.send("do work");
    expect(existsSync(file)).toBe(true);
    expect(readHandoff(file).lastAssistantMessage).toBe("partial state");
  });

  test("absent handoff option: no artifact, zero behavioral change", async () => {
    const dir = tmpDir("off");
    const file = join(dir, "handoff.json");
    const session = new AgentSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" as const }]),
      cwd: dir,
    });
    await session.send("hi");
    await session.dispose();
    expect(existsSync(file)).toBe(false);
    expect(session.history().filter((e) => e.type === "done")).toHaveLength(1);
  });
});
