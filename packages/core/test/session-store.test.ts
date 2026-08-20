import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createSession,
  MockProvider,
  replayMessages,
  runtimeRulesFromEvents,
  MIN_SUPPORTED_SCHEMA_VERSION,
  SessionStore,
} from "../src/index";
import type { AgentEvent } from "../src/index";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "moh-store-"));
}

const SORTABLE_ID = /^\d{8}T\d{6}\d{3}Z-[0-9a-f]{8}$/;

describe("session store", () => {
  test("create() writes a new JSONL under <home>/.moh/projects/<slug>/ with a sortable id", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);

    expect(basename(store.file, ".jsonl")).toMatch(SORTABLE_ID);
    expect(store.file.startsWith(join(home, ".moh", "projects"))).toBe(true);
    // Never inside the project's .moh/
    expect(store.file.startsWith(cwd)).toBe(false);
    expect(statSync(store.file).size).toBe(0);
  });

  test("same-named project dirs get distinct slugs; same cwd gets the same slug", () => {
    const home = tempHome();
    const a = mkdtempSync(join(tmpdir(), "moh-same-"));
    const b = mkdtempSync(join(tmpdir(), "moh-same-"));
    const dirA = SessionStore.create(a, home).file;
    const dirB = SessionStore.create(b, home).file;
    const dirA2 = SessionStore.create(a, home).file;
    expect(join(dirA, "..")).not.toBe(join(dirB, ".."));
    expect(join(dirA, "..")).toBe(join(dirA2, ".."));
  });

  test("append is one JSON line per event; load() round-trips a real session log", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    const store = SessionStore.create(cwd, home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["Hello"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await session.send("hi");

    const raw = readFileSync(store.file, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines.length).toBe(session.history().length);
    expect(lines.map((l) => JSON.parse(l))).toEqual(session.history());

    // Append-only: existing bytes unchanged after more events.
    const before = raw;
    await session.send("again"); // error turn (script exhausted) still logs events
    const after = readFileSync(store.file, "utf8");
    expect(after.startsWith(before)).toBe(true);

    expect(store.load()).toEqual(session.history());
  });

  test("ids are strictly increasing within a process and latest() finds the newest", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    const a = SessionStore.create(cwd, home);
    await Bun.sleep(5);
    const b = SessionStore.create(cwd, home);
    expect(b.file > a.file).toBe(true);

    const latest = SessionStore.latest(cwd, home);
    expect(latest!.file).toBe(b.file);
    expect(SessionStore.latest(join(tmpdir(), "nowhere"), home)).toBeNull();
  });

  test("fork() creates a new file inheriting the full history; the original is untouched", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    const store = SessionStore.create(cwd, home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["one"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await session.send("first");
    const originalBytes = readFileSync(store.file, "utf8");

    const fork = store.fork();
    expect(fork.file).not.toBe(store.file);
    expect(basename(fork.file, ".jsonl")).toMatch(SORTABLE_ID);
    expect(readFileSync(fork.file, "utf8")).toBe(originalBytes);
    expect(readFileSync(store.file, "utf8")).toBe(originalBytes);

    // The fork keeps appending to its own file.
    const forked = createSession({
      provider: MockProvider.scripted([{ deltas: ["two"], finish: "stop" }]),
      sink: (e) => fork.append(e),
    });
    await forked.send("second");
    expect(readFileSync(fork.file, "utf8").startsWith(originalBytes)).toBe(true);
    expect(readFileSync(store.file, "utf8")).toBe(originalBytes);
  });

  test("resume appends to the same file and restores runtime permission rules from the log", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    const store = SessionStore.create(cwd, home);
    // Hand-craft a log that contains a runtime rule grant.
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "session_mode", mode: "normal" },
      { type: "permission_rule_added", rule: { tier: "runtime", tool: "bash", effect: "allow", tokens: ["git", "status"] } },
      { type: "done" },
    ];
    for (const e of events) store.append(e);

    const latest = SessionStore.latest(cwd, home)!;
    expect(latest.file).toBe(store.file);
    const loaded = latest.load();
    expect(loaded).toEqual(events);

    const runtimeRules = runtimeRulesFromEvents(loaded);
    expect(runtimeRules).toEqual([
      { tier: "runtime", tool: "bash", effect: "allow", tokens: ["git", "status"] },
    ]);

    // The resumed session reuses the same file and the restored rules apply.
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      permissions: { runtimeRules },
      sink: (e) => latest.append(e),
    });
    expect(session.permissionRules.filter((r) => r.tier === "runtime")).toEqual(runtimeRules);
    await session.send("continue");
    const full = latest.load();
    // The resumed session re-appends session_start/session_mode plus the turn events.
    expect(full.length).toBe(events.length + 5); // session_start, session_mode, user_message, assistant_delta, done
    expect(full.slice(0, events.length)).toEqual(events);
  });

  test("load() rejects too-old and too-new schema versions with clear errors", () => {
    const home = tempHome();
    const dir = join(home, ".moh", "projects", "x");
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "20260101T000000000Z-old.jsonl");
    writeFileSync(old, JSON.stringify({ type: "session_start", schemaVersion: 0, promptVersion: "x" }) + "\n");
    expect(() => SessionStore.open(old).load()).toThrow(/too old/i);

    const future = join(dir, "20260101T000000001Z-new.jsonl");
    writeFileSync(future, JSON.stringify({ type: "session_start", schemaVersion: 99, promptVersion: "x" }) + "\n");
    expect(() => SessionStore.open(future).load()).toThrow(/newer/i);
  });

  test("load() tolerates a trailing empty line", () => {
    const home = tempHome();
    const store = SessionStore.create(process.cwd(), home);
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" });
    appendFileSync(store.file, "\n");
    expect(store.load()).toEqual([{ type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" }]);
  });

  test("replayMessages() rebuilds the provider-facing conversation from the log", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "session_mode", mode: "normal" },
      { type: "user_message", text: "hi" },
      { type: "assistant_delta", text: "Hello" },
      { type: "assistant_delta", text: " world" },
      { type: "done" },
      { type: "user_message", text: "again" },
      { type: "assistant_delta", text: "Bye" },
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "ls" } },
      { type: "tool_result", callId: "c1", ok: true, output: "file.txt" },
      { type: "assistant_delta", text: "Done" },
      { type: "done" },
    ];
    const messages = replayMessages(events);
    expect(messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Hello world" }] },
      { role: "user", parts: [{ kind: "text", text: "again" }] },
      {
        role: "assistant",
        parts: [
          { kind: "text", text: "Bye" },
          { kind: "tool_call", callId: "c1", name: "bash", args: { command: "ls" } },
        ],
      },
      { role: "user", parts: [{ kind: "tool_result", callId: "c1", ok: true, output: "file.txt" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Done" }] },
    ]);
  });
});
