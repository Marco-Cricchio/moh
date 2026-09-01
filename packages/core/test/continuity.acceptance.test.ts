import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MockProvider, SessionStore, createSession, listSessionSummaries } from "../src";
import { MemoryStore, scriptedExtractor } from "../src/memory";
import { projectSlug } from "../src/session-store";
import { runtimeRulesFromEvents } from "../src/permissions";

/**
 * #402 acceptance: the vision-note-28 story, end to end, on a simulated
 * machine switch. Two distinct project roots (different paths, same declared
 * identity file) share one fake home: work happens in root A (session +
 * memory + a runtime permission rule), root B continues it.
 *
 * The "machine switch" is the sync channel's job, not moh's (ADR-0018):
 * what moh guarantees is that identity-keyed data lands in the same
 * directories from both paths, and that resuming from root B sees the full
 * history. Sync itself is simulated by copying nothing — both roots read
 * and write the same home directly.
 */
function machineSwitch() {
  const dir = `/tmp/moh-continuity-${process.pid}-${Date.now()}`;
  const home = join(dir, "shared-home");
  const rootA = join(dir, "work-laptop", "moh");
  const rootB = join(dir, "office-pc", "checkouts", "moh");
  mkdirSync(home, { recursive: true });
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  return { home, rootA, rootB };
}

const slugDir = (home: string, slug: string) => join(home, ".moh", "projects", slug);

describe("cross-machine continuity acceptance (#402, spec #396)", () => {
  test("both roots resolve the same declared slug; legacy path slugs differ", () => {
    const { home, rootA, rootB } = machineSwitch();
    // Identity file created silently on first open in root A, then travels
    // with the clone to root B.
    expect(projectSlug(rootA, home)).toMatch(/^project-[0-9a-f]{16}$/);
    const slugA = projectSlug(rootA, home);
    mkdirSync(join(rootB, ".moh"), { recursive: true });
    copyFileSync(join(rootA, ".moh", "project.json"), join(rootB, ".moh", "project.json"));
    expect(projectSlug(rootB, home)).toBe(slugA);
    // The two paths are genuinely different: without the declared identity
    // they would never have found each other (the pre-#398 failure mode).
    const legacy = (cwd: string) =>
      `moh-${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`;
    expect(legacy(rootA)).not.toBe(legacy(rootB));
  });

  test("resume yesterday's session from the other root: full history, memory, rules", async () => {
    const { home, rootA, rootB } = machineSwitch();

    // --- Machine A (yesterday): one turn of real work. ---
    const store = SessionStore.create(rootA, home);
    const ruleTool = (name: string) => ({
      name,
      description: name,
      inputSchema: undefined as undefined,
      async execute() {
        return `${name} ok`;
      },
    });
    const session = createSession({
      cwd: rootA,
      mohHome: join(home, ".moh"),
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "git status" } }] },
        { deltas: ["worked on tickets 12 and 15"], finish: "stop" },
      ]),
      sink: (e) => store.append(e),
      sessionFile: store.file,
      tools: { bash: ruleTool("bash") },
      // A runtime permission rule from yesterday (an "always" answer):
      // replayable because it lives in the event log.
      onPermissionRequest: async () => "always" as const,
      memory: {
        // Extract immediately: the story's memory must exist before the switch.
        intervalTurns: 1,
        extractor: scriptedExtractor([{ topic: "tickets", fact: "Active work: tickets #12 and #15" }]),
      },
    });
    await session.send("continue work on tickets 12 and 15");
    await session.dispose({ timeoutMs: 5_000 });
    const fileA = store.file;
    expect(existsSync(fileA)).toBe(true);
    const raw = readFileSync(fileA, "utf8");
    expect(raw).toContain("tickets 12 and 15");

    // Memory was written under the shared home, keyed by the declared slug.
    const slug = projectSlug(rootA, home);
    const memoryFiles = readdirSync(join(slugDir(home, slug), "memory"));
    expect(memoryFiles).toContain("index.json");
    const memoryA = new MemoryStore(join(slugDir(home, slug), "memory"));
    expect(memoryA.read(4_000)).toContain("tickets #12 and #15");

    // --- The machine switch: the identity file travels with the clone. ---
    mkdirSync(join(rootB, ".moh"), { recursive: true });
    copyFileSync(join(rootA, ".moh", "project.json"), join(rootB, ".moh", "project.json"));
    expect(projectSlug(rootB, home)).toBe(slug);

    // --- Machine B (today): discovery sees yesterday's session. ---
    const summaries = listSessionSummaries(rootB, home);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.file).toBe(fileA);
    expect(summaries[0]!.title).toContain("tickets 12 and 15");

    // Memory reads from root B through the same identity-keyed directory.
    const memoryB = MemoryStore.forProject(rootB, join(home, ".moh"));
    expect(memoryB.dir).toBe(memoryA.dir);
    expect(memoryB.read(4_000)).toContain("tickets #12 and #15");

    // Runtime permission rules replay from the event log (schema check via
    // the same seam the session uses on resume).
    // A runtime rule from yesterday ("always") replays from the log alone:
    // permission decisions survive the machine switch with no extra state.
    const persisted = SessionStore.open(fileA).load();
    expect(persisted[0]!.type).toBe("session_start");
    expect(runtimeRulesFromEvents(persisted)).toMatchObject([
      { tool: "bash", effect: "allow", tokens: ["git", "status"], tier: "runtime" },
    ]);

    // --- Resume in root B: the turn appends to the same file. ---
    const storeB = SessionStore.open(fileA);
    const appendB = (e: import("../src").AgentEvent) => storeB.append(e);
    const resumed = createSession({
      cwd: rootB,
      mohHome: join(home, ".moh"),
      provider: MockProvider.scripted([{ deltas: ["picking up where we left off"], finish: "stop" }]),
      sink: appendB,
      sessionFile: fileA,
      externalGrowth: () => storeB.externalGrowth(),
      resume: { events: persisted },
    });
    await resumed.send("what was I working on?");
    await resumed.dispose({ timeoutMs: 5_000 });
    const after = readFileSync(fileA, "utf8");
    expect(after.startsWith(raw)).toBe(true); // append-only: history intact
    expect(after).toContain("picking up where we left off");
    expect((after.match(/session_start/g) ?? []).length).toBe(1);
    // Yesterday's "always" rule was restored into the live session.
    expect(resumed.permissionRules).toContainEqual(
      expect.objectContaining({ tool: "bash", effect: "allow", tokens: ["git", "status"] }),
    );

    // One slug directory total: nothing path-keyed was left behind.
    const projects = readdirSync(join(home, ".moh", "projects"));
    expect(projects).toEqual([slug]);
  });

  test("no local-by-construction artifact blocks the shared home (ignore-list audit)", async () => {
    const { home, rootA, rootB } = machineSwitch();
    mkdirSync(join(rootB, ".moh"), { recursive: true });

    // Root A works first.
    const storeA = SessionStore.create(rootA, home);
    const a = createSession({
      cwd: rootA,
      mohHome: join(home, ".moh"),
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => storeA.append(e),
      sessionFile: storeA.file,
      memory: { intervalTurns: 1, extractor: scriptedExtractor([{ topic: "t", fact: "f" }]) },
    });
    await a.send("hello");
    await a.dispose({ timeoutMs: 5_000 });

    // The memory lock (if one lingers) is content-based: a foreign-machine
    // lock never blocks root B's writes — it is reclaimed by content, not
    // by mtime. Simulate the crash leftover: a lock owned by a dead pid on
    // another machine.
    const slug = projectSlug(rootA, home);
    const lockFile = join(slugDir(home, slug), "memory", ".lock");
    mkdirSync(join(slugDir(home, slug), "memory"), { recursive: true });
    writeFileSync(
      lockFile,
      JSON.stringify({ v: 1, pid: 999_999, machineId: "another-machine", boot: 1 }),
    );
    const before = statSync(storeA.file).size;

    // Root B resumes and its memory write path still works.
    copyFileSync(join(rootA, ".moh", "project.json"), join(rootB, ".moh", "project.json"));
    const storeC = SessionStore.open(storeA.file);
    const appendC = (e: import("../src").AgentEvent) => storeC.append(e);
    const persisted = storeC.load();
    const b = createSession({
      cwd: rootB,
      mohHome: join(home, ".moh"),
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: appendC,
      sessionFile: storeA.file,
      externalGrowth: () => storeC.externalGrowth(),
      resume: { events: persisted },
      memory: {
        intervalTurns: 1,
        extractor: scriptedExtractor([{ topic: "t2", fact: "from machine B" }]),
      },
    });
    await b.send("more work");
    await b.dispose({ timeoutMs: 5_000 });
    // The append proceeded on the tail; the file only grew.
    expect(statSync(storeA.file).size).toBeGreaterThan(before);
    expect(new MemoryStore(join(slugDir(home, slug), "memory")).read(4_000)).toContain(
      "from machine B",
    );
  });
});
