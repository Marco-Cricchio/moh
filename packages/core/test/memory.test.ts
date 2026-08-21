/**
 * Memory (#38): durable per-project facts at ~/.moh/projects/<slug>/memory/
 * (index + append-only topic files under lock, newest-wins consolidation),
 * automatic post-turn extraction every N turns, non-blocking and
 * fail-silent, injected as a system-prompt section, disabled by config.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSession,
  MemoryStore,
  MockProvider,
  createMaintenanceExtractor,
  memoryConfigSchema,
  memoryTranscript,
  parseMemoryEntries,
  type MemoryEntry,
  type MemoryExtractorInput,
} from "../src";
import { SCHEMA_VERSION } from "../src/types";

const TMP = join(import.meta.dir, "tmp-memory");

function tmpDir(name: string): string {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function store(name: string): MemoryStore {
  return new MemoryStore(join(tmpDir(name), "memory"));
}

describe("MemoryStore", () => {
  test("append writes dated, session-signed lines and an index", async () => {
    const s = store("append");
    await s.append([{ topic: "Testing", fact: "owner prefers bun test" }], "session-abc");
    const file = s.topicFile("Testing");
    expect(existsSync(file)).toBe(true);
    const line = readFileSync(file, "utf8").trim();
    expect(line).toMatch(/^- owner prefers bun test \(\d{4}-\d{2}-\d{2}, session-abc\)$/);
    const index = s.readIndex();
    expect(index.topics["Testing"]?.entries).toBe(1);
    expect(s.topics()).toEqual(["Testing"]);
  });

  test("topic files are append-only: bytes only ever grow", async () => {
    const s = store("append-only");
    await s.append([{ topic: "t", fact: "first" }], "session-1");
    const file = s.topicFile("t");
    const after1 = readFileSync(file, "utf8");
    await s.append([{ topic: "t", fact: "second" }], "session-2");
    const after2 = readFileSync(file, "utf8");
    expect(after2.startsWith(after1)).toBe(true);
    expect(after2).toContain("second");
    expect(s.readIndex().topics["t"]?.entries).toBe(2);
  });

  test("read renders topics newest-first with a hard budget", async () => {
    const s = store("read");
    await s.append([{ topic: "old-topic", fact: "old fact" }], "s1", new Date("2025-01-01T00:00:00Z"));
    await s.append([{ topic: "fresh-topic", fact: "fresh fact" }], "s2", new Date("2025-02-01T00:00:00Z"));
    const full = s.read(10_000);
    expect(full.indexOf("fresh-topic")).toBeLessThan(full.indexOf("old-topic"));
    expect(full).toContain("- fresh fact");
    // Tight budget: only the newest topic fits, with a truncation note.
    const tight = s.read(full.indexOf("old-topic") + 10);
    expect(tight).toContain("fresh-topic");
    expect(tight).not.toContain("old-topic");
    expect(tight).toContain("[memory truncated");
  });

  test("read returns empty string with no memory", () => {
    expect(store("empty").read(1000)).toBe("");
  });

  test("concurrent appends serialize under the lock (no lost lines)", async () => {
    const s = store("lock");
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => s.append([{ topic: "concurrency", fact: `fact ${i}` }], `s-${i}`)),
    );
    const lines = readFileSync(s.topicFile("concurrency"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(8);
    expect(s.readIndex().topics["concurrency"]?.entries).toBe(8);
  });

  test("consolidate dedupes newest-wins with a dated note", async () => {
    const s = store("consolidate");
    await s.append([{ topic: "editor", fact: "prefers vim keybindings" }], "s1", new Date("2025-01-01T00:00:00Z"));
    await s.append([{ topic: "editor", fact: "prefers VIM keybindings" }], "s2", new Date("2025-02-01T00:00:00Z"));
    await s.append([{ topic: "editor", fact: "hates mice" }], "s3", new Date("2025-03-01T00:00:00Z"));
    const dropped = await s.consolidate("maint", new Date("2025-04-01T00:00:00Z"));
    expect(dropped).toBe(1);
    const raw = readFileSync(s.topicFile("editor"), "utf8");
    expect(raw).toContain("<!-- consolidated 2025-04-01");
    expect(raw).toContain("hates mice");
    // Newest wins: the s2 signature survives, s1's duplicate is gone.
    expect(raw).toContain("s2)");
    expect(raw).not.toContain("s1)");
    expect(s.readIndex().topics["editor"]?.entries).toBe(2);
  });
});

describe("memoryTranscript / parseMemoryEntries", () => {
  test("transcript collects user and assistant text since an index", () => {
    const events = [
      { type: "session_start", schemaVersion: SCHEMA_VERSION, promptVersion: "x" },
      { type: "user_message", text: "hello" },
      { type: "assistant_delta", text: "hi " },
      { type: "assistant_delta", text: "there" },
      { type: "done" },
      { type: "user_message", text: "bye" },
      { type: "done" },
    ] as const;
    expect(memoryTranscript(events, 1)).toBe("user: hello\nassistant: hi there\nuser: bye");
  });

  test("parse accepts prose-wrapped JSON arrays and caps entries", () => {
    const many = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ topic: `t${i}`, fact: `f${i}` })));
    const parsed = parseMemoryEntries(`Here you go:\n${many}\nDone.`);
    expect(parsed).toHaveLength(25);
    expect(parseMemoryEntries('[]')).toEqual([]);
    expect(() => parseMemoryEntries("no json here")).toThrow();
  });
});

describe("session integration", () => {
  function newSession(dir: string, opts: { extractor: (input: MemoryExtractorInput) => Promise<MemoryEntry[]>; intervalTurns?: number; enabled?: boolean }) {
    return new AgentSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" as const }]),
      cwd: dir,
      memory: {
        dir: join(dir, "memory"),
        intervalTurns: opts.intervalTurns ?? 1,
        enabled: opts.enabled,
        extractor: opts.extractor,
      },
    });
  }

  test("post-turn extraction writes memory, logs one discreet event, injects the section", async () => {
    const dir = tmpDir("session-basic");
    let seenInput: MemoryExtractorInput | null = null;
    const session = newSession(dir, {
      extractor: async (input) => {
        seenInput = input;
        return [{ topic: "prefs", fact: "owner speaks Italian" }];
      },
    });
    await session.send("remember I speak Italian");
    await session.dispose(); // flushes the background run
    const events = session.history();
    const updated = events.filter((e) => e.type === "memory_updated");
    expect(updated).toHaveLength(1);
    expect((updated[0] as any).entries).toBe(1);
    expect((updated[0] as any).topics).toEqual(["prefs"]);
    // The turn itself finished before extraction (non-blocking), and the
    // extractor saw the conversation text.
    expect(seenInput!.transcript).toContain("speak Italian");
    // And the write landed in the store.
    expect(readFileSync(join(dir, "memory", "prefs.md"), "utf8")).toContain("owner speaks Italian");
  });

  test("memory section appears in the assembled prompt only when non-empty", async () => {
    const dir = tmpDir("session-prompt");
    const session = newSession(dir, {
      extractor: async () => [{ topic: "prefs", fact: "likes terse replies" }],
    });
    await session.send("hi"); // triggers extraction (interval 1)
    await session.dispose();
    // A second session over the same store sees the memory section.
    const messages: string[] = [];
    const provider = {
      name: "capture",
      async *stream(list: any[]) {
        messages.push(list[0].parts[0].text);
        yield { type: "finish" as const, reason: "stop" as const };
      },
    };
    const second = new AgentSession({
      provider,
      cwd: dir,
      memory: { dir: join(dir, "memory"), intervalTurns: 99 },
    });
    await second.send("hello");
    await second.dispose();
    expect(messages[0]).toContain("## Memory");
    expect(messages[0]).toContain("likes terse replies");
  });

  test("no memory section when the store is empty", async () => {
    const dir = tmpDir("session-nosection");
    const messages: string[] = [];
    const provider = {
      name: "capture",
      async *stream(list: any[]) {
        messages.push(list[0].parts[0].text);
        yield { type: "finish" as const, reason: "stop" as const };
      },
    };
    const session = new AgentSession({
      provider,
      cwd: dir,
      memory: { dir: join(dir, "memory"), intervalTurns: 99 },
    });
    await session.send("hi");
    await session.dispose();
    expect(messages[0]).not.toContain("## Memory");
    expect(existsSync(join(dir, "memory"))).toBe(false);
  });

  test("interval: extraction only every N completed turns", async () => {
    const dir = tmpDir("session-interval");
    let calls = 0;
    const session = newSession(dir, {
      intervalTurns: 3,
      extractor: async () => {
        calls += 1;
        return [{ topic: "t", fact: "f" }];
      },
    });
    await session.send("1");
    await session.send("2");
    await session.dispose();
    expect(calls).toBe(0);
    const events = session.history().filter((e) => e.type === "memory_updated");
    expect(events).toHaveLength(0);
  });

  test("disabled: no writes, no section, no extractor runs", async () => {
    const dir = tmpDir("session-disabled");
    let calls = 0;
    const session = newSession(dir, {
      enabled: false,
      extractor: async () => {
        calls += 1;
        return [{ topic: "t", fact: "f" }];
      },
    });
    await session.send("hi");
    await session.dispose();
    expect(calls).toBe(0);
    expect(existsSync(join(dir, "memory"))).toBe(false);
    expect(session.history().some((e) => e.type === "memory_updated")).toBe(false);
  });

  test("fail-silent: extractor errors retry once, then give up quietly", async () => {
    const dir = tmpDir("session-fail");
    let calls = 0;
    const session = newSession(dir, {
      extractor: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    const result = await session.send("hi");
    expect(result.status).toBe("done"); // the turn is unaffected
    await session.dispose();
    expect(calls).toBe(2);
    const events = session.history();
    expect(events.some((e) => e.type === "memory_updated")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("non-blocking: send() resolves before the extraction completes", async () => {
    const dir = tmpDir("session-nonblock");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let extracted = false;
    const session = newSession(dir, {
      extractor: async () => {
        await gate;
        extracted = true;
        return [{ topic: "t", fact: "f" }];
      },
    });
    const turn = await session.send("hi");
    expect(turn.status).toBe("done");
    expect(extracted).toBe(false); // still gated
    release();
    await session.dispose();
    expect(extracted).toBe(true);
    expect(session.history().some((e) => e.type === "memory_updated")).toBe(true);
  });

  test("empty extraction: no event, no section", async () => {
    const dir = tmpDir("session-empty");
    const session = newSession(dir, { extractor: async () => [] });
    await session.send("hi");
    await session.dispose();
    expect(session.history().some((e) => e.type === "memory_updated")).toBe(false);
    expect(existsSync(join(dir, "memory", "index.json"))).toBe(false);
  });
});

describe("maintenance extractor (default)", () => {
  test("parses the child's reply into entries", async () => {
    const provider = MockProvider.scripted([
      { deltas: ['[{"topic":"prefs","fact":"dark mode"}]'], finish: "stop" },
    ]);
    const extractor = createMaintenanceExtractor(provider, tmpDir("maint"));
    const entries = await extractor({ transcript: "user: I use dark mode", topics: [], memory: "" });
    expect(entries).toEqual([{ topic: "prefs", fact: "dark mode" }]);
  });

  test("propagates child failures (caller fails silent)", async () => {
    const provider = MockProvider.scripted([{ deltas: ["garbage, no array"], finish: "stop" }]);
    const extractor = createMaintenanceExtractor(provider, tmpDir("maint-fail"));
    await expect(extractor({ transcript: "x", topics: [], memory: "" })).rejects.toThrow();
  });
});

describe("moh.json memory config", () => {
  test("parses the memory block", () => {
    const parsed = memoryConfigSchema.parse({ enabled: false, intervalTurns: 10, budgetTokens: 1000 });
    expect(parsed).toEqual({ enabled: false, intervalTurns: 10, budgetTokens: 1000 });
  });

  test("rejects non-positive intervals", () => {
    expect(memoryConfigSchema.safeParse({ intervalTurns: 0 }).success).toBe(false);
  });
});
