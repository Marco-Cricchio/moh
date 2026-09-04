import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createSession, MockProvider, SessionStore } from "../src/index";
import { legacyProjectSlug, listSessionSummaries, MIN_SUPPORTED_SCHEMA_VERSION, projectSlug, replayMessages } from "../src/session-store";
import { runtimeRulesFromEvents } from "../src/permissions";
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

  test("fresh moh-home session artifacts are owner-only without changing the injected home", () => {
    const home = tempHome();
    const homeMode = statSync(home).mode & 0o777;
    const store = SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), home);
    for (const path of [join(home, ".moh"), join(home, ".moh", "projects"), join(home, ".moh", "projects", basename(join(store.file, "..")))]) {
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(homeMode);
  });

  test("does not retroactively chmod existing moh-home directories", () => {
    const home = tempHome();
    const mohHome = join(home, ".moh");
    mkdirSync(mohHome, { mode: 0o755 });
    SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), home);
    expect(statSync(mohHome).mode & 0o777).toBe(0o755);
  });

  test("first open creates an opaque project identity and shared clones resolve to one slug", () => {
    const home = tempHome();
    const a = mkdtempSync(join(tmpdir(), "moh-same-"));
    const b = mkdtempSync(join(tmpdir(), "moh-same-"));
    const first = SessionStore.create(a, home);
    const identity = readFileSync(join(a, ".moh", "project.json"), "utf8");
    expect(JSON.parse(identity)).toEqual({ id: expect.any(String) });
    expect(identity).not.toContain(a);
    mkdirSync(join(b, ".moh"), { recursive: true });
    writeFileSync(join(b, ".moh", "project.json"), identity);
    const second = SessionStore.create(b, home);
    expect(join(first.file, "..")).toBe(join(second.file, ".."));
    expect(SessionStore.list(b, home).map((store) => store.file)).toContain(first.file);
  });

  test("projects without an identity retain their legacy slug when identity creation fails", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-legacy-"));
    mkdirSync(join(cwd, ".moh", "project.json"), { recursive: true });
    expect(projectSlug(cwd, home)).toBe(legacyProjectSlug(cwd));
  });

  test("declared identity atomically migrates an existing legacy directory once and records a note", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-migrate-"));
    const legacy = legacyProjectSlug(cwd);
    const legacyDir = join(home, ".moh", "projects", legacy);
    mkdirSync(join(legacyDir, "memory"), { recursive: true });
    writeFileSync(join(legacyDir, "old.jsonl"), "session");
    writeFileSync(join(legacyDir, "memory", "facts.md"), "fact");
    const slug = projectSlug(cwd, home);
    const target = join(home, ".moh", "projects", slug);
    expect(existsSync(legacyDir)).toBe(false);
    expect(readFileSync(join(target, "old.jsonl"), "utf8")).toBe("session");
    expect(readFileSync(join(target, "memory", "facts.md"), "utf8")).toBe("fact");
    expect(readFileSync(join(target, "migration.log"), "utf8")).toContain("Migrated legacy project directory");
    projectSlug(cwd, home);
    expect(readFileSync(join(target, "migration.log"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
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

  test("list() returns the project's session files, newest first", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    expect(SessionStore.list(cwd, home)).toEqual([]);
    const a = SessionStore.create(cwd, home);
    await Bun.sleep(5);
    const b = SessionStore.create(cwd, home);
    expect(SessionStore.list(cwd, home).map((s) => s.file)).toEqual([b.file, a.file]);
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
    // The inherited history is byte-identical, then the fork's born-consumed
    // `session_resumed` marker (ADR-0021); the original file stays untouched.
    expect(readFileSync(fork.file, "utf8")).toBe(originalBytes + '{"type":"session_resumed"}\n');
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
    expect(full.length).toBe(events.length + 6); // session_start, session_mode, user_message, assistant_delta, model_call, done
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

  test("replayMessages() repairs a tool_call whose tool_result never arrived (aborted turn) #237", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "user_message", text: "run" },
      { type: "assistant_delta", text: "starting" },
      { type: "tool_call", callId: "c9", name: "bash", args: { command: "sleep 99" } },
      // turn aborted mid-tool: user_message + error, no tool_result for c9
      { type: "user_message", text: "come procede?" },
      { type: "error", reason: "invalid_request", message: "x" },
    ];
    const messages = replayMessages(events);
    // The orphan tool_call must be followed by a failed synthetic
    // tool_result so the replayed conversation satisfies the tool-use
    // protocol every provider requires.
    const idx = messages.findIndex(
      (m) => m.parts.some((p) => p.kind === "tool_call" && p.callId === "c9"),
    );
    expect(idx).toBeGreaterThan(-1);
    const follow = messages[idx + 1]!;
    expect(follow.role).toBe("user");
    expect(follow.parts[0]).toMatchObject({ kind: "tool_result", callId: "c9", ok: false });
  });

  test("replayMessages() never emits an orphan tool_result after a discarded assistant message #371", () => {
    // Completed tool call, then the following model call fails and the
    // turn is cancelled: the tool_result must not survive the discard of
    // its assistant tool_call, or every later OpenAI-wire request fails
    // with "No tool call found for function call output".
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "user_message", text: "run" },
      { type: "assistant_delta", text: "starting" },
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "ls" } },
      { type: "model_call", model: "glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "tool_result", callId: "c1", ok: true, output: "file.txt" },
      { type: "model_call", model: "glm-5.3", usage: { inputTokens: 1, outputTokens: 1 }, failed: true },
      { type: "cancelled" },
      { type: "user_message", text: "continue" },
      { type: "assistant_delta", text: "ok" },
      { type: "done" },
    ];
    const messages = replayMessages(events);
    const callIds = new Set(
      messages.flatMap((m) => m.parts.flatMap((p) => (p.kind === "tool_call" ? [p.callId] : []))),
    );
    const orphans = messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.kind === "tool_result" && !callIds.has(p.callId) ? [p.callId] : [])),
    );
    expect(orphans).toEqual([]);
    expect(messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "run" }] },
      { role: "user", parts: [{ kind: "text", text: "continue" }] },
      { role: "assistant", parts: [{ kind: "text", text: "ok" }] },
    ]);
  });

  test("replayMessages() drops a completed tool pair when a fallback discards the call #371", () => {
    // Same invariant through the fallback path: the failed stop's
    // assistant message (carrying the tool_call) is discarded, so its
    // already-settled tool_result must not leak into the conversation.
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "user_message", text: "run" },
      { type: "assistant_delta", text: "starting" },
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "ls" } },
      { type: "tool_result", callId: "c1", ok: true, output: "file.txt" },
      { type: "fallback", from: "glm-5.3", to: "gpt-5.6-terra", reason: "rate_limited" },
      { type: "model_call", model: "glm-5.3", usage: { inputTokens: 1, outputTokens: 1 }, failed: true },
      { type: "assistant_delta", text: "resumed" },
      { type: "done" },
    ];
    const messages = replayMessages(events);
    expect(messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "run" }] },
      { role: "assistant", parts: [{ kind: "text", text: "resumed" }] },
    ]);
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

// #400: single-writer semantics — an open session detects that its JSONL
// file grew from elsewhere (sync channel / second process) at append
// boundaries. Tested at the session-store seam by mutating the file
// externally between open and append.
describe("single-writer guard (#400)", () => {
  const START: AgentEvent = { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" };

  test("externalGrowth() reports growth between open and append, once, with both sizes", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append(START);
    expect(store.externalGrowth()).toBeNull();

    // External writer appends to the same file (e.g. a synced machine).
    const before = statSync(store.file).size;
    appendFileSync(store.file, JSON.stringify({ type: "user_message", text: "from elsewhere" }) + "\n");
    const after = statSync(store.file).size;

    const growth = store.externalGrowth();
    expect(growth).not.toBeNull();
    expect(growth!.expectedBytes).toBe(before);
    expect(growth!.actualBytes).toBe(after);
    // Consuming: one incident, one warning — acknowledged until new
    // external growth (the local append has not happened yet).
    expect(store.externalGrowth()).toBeNull();
  });

  test("after the local append the expectation refreshes; local bytes stay intact", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append(START);
    appendFileSync(store.file, JSON.stringify({ type: "user_message", text: "from elsewhere" }) + "\n");
    const bytesBeforeLocalAppend = readFileSync(store.file, "utf8");

    // The session flow probes before appending: the incident is observed
    // (consumed) here, then the local append proceeds on the tail with
    // the refreshed baseline. Nothing is rewritten; the external line
    // survives; no silent corruption.
    expect(store.externalGrowth()).not.toBeNull();
    store.append({ type: "user_message", text: "local" });
    const raw = readFileSync(store.file, "utf8");
    expect(raw.startsWith(bytesBeforeLocalAppend)).toBe(true);
    expect(store.externalGrowth()).toBeNull();
  });

  test("a local append that never probed does not swallow the external growth", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append(START);
    const before = statSync(store.file).size;
    appendFileSync(store.file, JSON.stringify({ type: "user_message", text: "from elsewhere" }) + "\n");
    const after = statSync(store.file).size;

    // The append's arithmetic baseline (no re-stat) never observed the
    // foreign bytes: the next probe still reports them, unswallowed —
    // exactly once, then consumed.
    store.append({ type: "user_message", text: "local" });
    const growth = store.externalGrowth();
    expect(growth).not.toBeNull();
    const localLine = JSON.stringify({ type: "user_message", text: "local" }) + "\n";
    expect(growth!.expectedBytes).toBe(before + Buffer.byteLength(localLine));
    expect(growth!.actualBytes).toBe(statSync(store.file).size);
    expect(store.externalGrowth()).toBeNull();
  });

  test("an open (resumed) store baselines at open time, not at the history's end", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const original = SessionStore.create(cwd, home);
    original.append(START);
    const originalBytes = readFileSync(original.file, "utf8");

    const reopened = SessionStore.open(original.file);
    expect(reopened.externalGrowth()).toBeNull();
    appendFileSync(original.file, JSON.stringify({ type: "user_message", text: "from elsewhere" }) + "\n");
    expect(reopened.externalGrowth()).not.toBeNull();

    // The original writer also notices the reopened writer's appends.
    reopened.append({ type: "user_message", text: "local" });
    expect(original.externalGrowth()).not.toBeNull();
  });

  test("shrinking or same-size external rewrites are not reported (growth-only signal)", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append(START);
    writeFileSync(store.file, readFileSync(store.file, "utf8"));
    expect(store.externalGrowth()).toBeNull();
  });
});

describe("pertinent session (ADR-0021)", () => {
  test("fork() is born consumed: the new file opens with one session_resumed", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const original = SessionStore.create(cwd, home);
    original.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc" });
    const forked = original.fork();
    const events = forked.load().map((e) => e.type);
    expect(events).toEqual(["session_start", "session_resumed"]);
    // The original file is untouched.
    expect(original.load().map((e) => e.type)).toEqual(["session_start"]);
  });

  test("listSessionSummaries: never-resumed session is not consumed", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc" });
    store.append({ type: "user_message", text: "hello" });
    store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
    const [summary] = listSessionSummaries(cwd, home);
    expect(summary.consumed).toBe(false);
    expect(summary.title).toBe("hello");
  });

  test("listSessionSummaries: resumed then closed is consumed", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc" });
    store.append({ type: "user_message", text: "hello" });
    store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
    store.append({ type: "session_resumed" });
    const [summary] = listSessionSummaries(cwd, home);
    expect(summary.consumed).toBe(true);
  });

  test("listSessionSummaries: resumed then worked on is suggestible again (consumption re-openable)", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc" });
    store.append({ type: "session_resumed" });
    store.append({ type: "user_message", text: "back to work" });
    store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
    const [summary] = listSessionSummaries(cwd, home);
    expect(summary.consumed).toBe(false);
    expect(summary.title).toBe("back to work");
  });
});
