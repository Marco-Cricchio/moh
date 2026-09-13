import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools, createSession, MockProvider, type AgentEvent, type Provider } from "../src/index";
import { MpmService } from "../src/mpm/service";
import { MpmStore } from "../src/mpm/store";
import type { MpmFileRecord } from "../src/mpm/types";
import type { Message } from "../src/types";

/**
 * #663: subagents and mpm_query — a child gets the tool in its repertoire
 * (executed by the parent's tool runner), so it can nominate seeds itself
 * instead of grep/glob sweeps. The MpmService never reaches the child
 * (#620 unchanged); the spawn-time snapshotFor plan is unchanged.
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
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-query-sub-"));
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

function capturing(inner: Provider): { provider: Provider; seen: () => string; seenTools: () => string[] } {
  let system = "";
  let tools: string[] = [];
  const provider: Provider = {
    name: inner.name,
    async *stream(messages: Message[], signal: AbortSignal, t?: readonly import("../src/types").ToolSpec[], options?: import("../src/types").StreamOptions) {
      system = (messages[0]!.parts[0] as { text: string }).text;
      tools = (t ?? []).map((x) => x.name);
      yield* inner.stream(messages, signal, t, options);
    },
  };
  return { provider, seen: () => system, seenTools: () => tools };
}

describe("mpm_query and subagents (#663)", () => {
  test("a child spawned from an MPM-enabled session has mpm_query in its repertoire", async () => {
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
    expect(child.seenTools()).toContain("mpm_query");
    // The spawn-time snapshot is unchanged (#620).
    expect(child.seen()).toContain("## Project map orientation");
  });

  test("a child can call mpm_query; it executes against the parent-owned service", async () => {
    const { root, service } = await setup();
    const spawned: AgentEvent[] = [];
    const child = capturing(
      MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "mpm_query", args: { seed: "formatDate" } }] },
        { deltas: ["found types.ts"], finish: "stop" },
      ]),
    );
    const parent = createSession({
      provider: MockProvider.scripted([
        { deltas: [], finish: "tool_calls", toolCalls: [{ name: "spawn", args: { preset: "research", task: "investigate the formatDate function" } }] },
        { deltas: ["spawned"], finish: "stop" },
      ]),
      tools: builtinTools(),
      permissions: { overrides: { tools: { spawn: "allow" } } },
      cwd: root,
      mpm: { service },
      subagents: { home: root, provider: child.provider },
      sink: (e: AgentEvent) => spawned.push(e),
    });
    await parent.send("go");
    const spawnEvent = spawned.find((e) => e.type === "subagent_spawn") as Extract<AgentEvent, { type: "subagent_spawn" }> | undefined;
    expect(spawnEvent).toBeDefined();
    const childLog = (await import("node:fs")).readFileSync(spawnEvent!.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const result = childLog.find((e) => e.type === "tool_result");
    expect(result).toBeDefined();
    expect(result.output).toContain("src/types.ts");
  });
});
