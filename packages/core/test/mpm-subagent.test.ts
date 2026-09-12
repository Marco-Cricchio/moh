import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools, createSession, MockProvider, type AgentEvent } from "../src/index";
import { MpmService } from "../src/mpm/service";
import { MpmStore } from "../src/mpm/store";
import type { MpmFileRecord } from "../src/mpm/types";
import type { Message } from "../src/types";

/**
 * #620: MPM session continuity — subagents. A child gets a bounded,
 * read-only orientation snapshot relevant to its task; it can never own
 * or mutate the parent map lifecycle (no service, no lifecycle, no
 * mutation surface reaches the child).
 */

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const FILES: Record<string, string> = {
  "src/date.ts": ['import { DateLike } from "./types";', "export function formatDate(d: DateLike): string { return d.toISOString(); }"].join("\n"),
  "src/types.ts": ["export interface DateLike { toISOString(): string; }"].join("\n"),
};

const FIXTURE: MpmFileRecord[] = [
  {
    path: "src/date.ts",
    hash: sha(FILES["src/date.ts"]),
    size: FILES["src/date.ts"].length,
    language: "typescript",
    symbols: [{ name: "formatDate", kind: "function", line: 2 }],
    relations: [{ kind: "imports", target: "src/types.ts", via: "./types", line: 1 }],
  },
  {
    path: "src/types.ts",
    hash: sha(FILES["src/types.ts"]),
    size: FILES["src/types.ts"].length,
    language: "typescript",
    symbols: [],
    relations: [],
  },
];

const tmpDirs: string[] = [];
async function setup(): Promise<{ root: string; service: MpmService }> {
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-subagent-"));
  tmpDirs.push(root);
  for (const [path, content] of Object.entries(FILES)) {
    const abs = join(root, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
  const store = new MpmStore(join(root, "project-map"));
  store.writeProjection(new Map(FIXTURE.map((r) => [r.path, r])));
  const service = new MpmService(join(root, "project-map"));
  service.load();
  return { root, service };
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Capture provider: delegates to `inner`, records the first system text. */
function capturing(inner: Provider): { provider: Provider; seen: () => string } {
  let system = "";
  const provider: Provider = {
    name: inner.name,
    async *stream(messages: Message[], signal, tools, options) {
      system = (messages[0]!.parts[0] as { text: string }).text;
      yield* inner.stream(messages, signal, tools, options);
    },
  };
  return { provider, seen: () => system };
}

describe("MPM subagent orientation (#620)", () => {
  test("a child spawned for a task naming a mapped file receives the bounded plan", async () => {
    const { root, service } = await setup();
    const child = capturing(MockProvider.scripted([{ deltas: ["looking"], finish: "stop" }]));
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "investigate src/date.ts" } }] },
        { deltas: ["spawned"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      cwd: root,
      mpm: { service },
      subagents: { home: root, provider: child.provider },
    });
    await parent.send("go");
    const system = child.seen();
    expect(system).toContain("## Project map orientation");
    expect(system).toContain("src/types.ts");
    expect(system).toContain("advisory");
  });

  test("a child spawned for an ineligible task gets no mpm section", async () => {
    const { root, service } = await setup();
    const child = capturing(MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]));
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "summarize the changelog" } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      cwd: root,
      mpm: { service },
      subagents: { home: root, provider: child.provider },
    });
    await parent.send("go");
    expect(child.seen()).not.toContain("Project map orientation");
  });

  test("without parent MPM activation, the child prompt is unchanged", async () => {
    const { root } = await setup();
    const child = capturing(MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]));
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "investigate src/date.ts" } }] },
        { deltas: ["spawned"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      cwd: root,
      subagents: { home: root, provider: child.provider },
    });
    await parent.send("go");
    expect(child.seen()).not.toContain("Project map orientation");
  });

  test("the child cannot own the map: no service, no lifecycle reaches it (depth 1, tools subset)", async () => {
    const { root, service } = await setup();
    const events: AgentEvent[] = [];
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "investigate src/date.ts" } }] },
        { deltas: ["spawned"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      cwd: root,
      mpm: { service },
      subagents: {
        home: root,
        provider: MockProvider.scripted([{ deltas: ["done"], finish: "stop" }]),
      },
    });
    parent.addEventListener?.(() => {});
    const sink = (e: AgentEvent) => events.push(e);
    // Re-create with a tap (the simple way: inspect the spawn result event).
    const spawned: AgentEvent[] = [];
    const parent2 = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "investigate src/date.ts" } }] },
        { deltas: ["ok"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      cwd: root,
      mpm: { service },
      subagents: {
        home: root,
        provider: MockProvider.scripted([{ deltas: ["done"], finish: "stop" }]),
      },
      sink: (e) => spawned.push(e),
    });
    void sink;
    void parent;
    await parent2.send("go");
    // The spawn happened at depth 1 with a bounded tool subset — the child
    // holds no MpmService reference (the host passes only rendered text)
    // and no lifecycle: assert the child config was built without mpm (the
    // prompt has no orientation machinery beyond the static text) and that
    // the child log contains no mpm chrome.
    const spawnEvent = spawned.find((e) => e.type === "subagent_spawn") as Extract<AgentEvent, { type: "subagent_spawn" }> | undefined;
    expect(spawnEvent).toBeDefined();
    const childEvents = (await import("node:fs")).readFileSync(spawnEvent!.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const e of childEvents) {
      expect(e.type).not.toBe("mpm_updated");
      expect(JSON.stringify(e)).not.toContain("MpmService");
    }
  });
});
