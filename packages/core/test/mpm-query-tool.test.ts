import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, MockProvider, type AgentEvent } from "../src/index";
import { MpmService } from "../src/mpm/service";
import { MpmStore } from "../src/mpm/store";
import type { MpmFileRecord } from "../src/mpm/types";

/**
 * #663: MPM model-nominated orientation — the `mpm_query` read-only tool
 * (ADR-0028). The model nominates a seed (path, unique path suffix, or
 * symbol name); the core validates everything deterministically and
 * returns the same trusted format as the #616 plan. The full result is
 * persisted in the event log (replay fidelity). Hallucinated candidates
 * are discarded, never invented; an unavailable projection degrades
 * honestly.
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
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-query-"));
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

/** Run one turn where the model calls mpm_query, then finishes. */
async function queryTurn(root: string, service: MpmService | undefined, seed: unknown) {
  const events: AgentEvent[] = [];
  const session = createSession({
    provider: MockProvider.scripted([
      { deltas: [], finish: "tool_calls" as const, toolCalls: [{ name: "mpm_query", args: { seed } }] },
      { deltas: ["done"], finish: "stop" as const },
    ]),
    permissions: { unrestrictedTools: true },
    cwd: root,
    ...(service ? { mpm: { service } } : {}),
    sink: (e: AgentEvent) => events.push(e),
  });
  const result = await session.send("go");
  const toolResult = events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }> | undefined;
  return { result, toolResult };
}

describe("mpm_query tool (#663, ADR-0028)", () => {
  test("an exact mapped path returns its fresh neighborhood", async () => {
    const { root, service } = await setup();
    const { result, toolResult } = await queryTurn(root, service, "src/date.ts");
    expect(result.status).toBe("done");
    expect(toolResult).toBeDefined();
    expect(toolResult!.output).toContain("src/types.ts");
    expect(toolResult!.output).toContain("src/date.ts");
    // Provenance rides along, like the plan.
    expect(toolResult!.output).toContain("line 1");
  });

  test("a symbol name resolves through the symbol index", async () => {
    const { root, service } = await setup();
    const { toolResult } = await queryTurn(root, service, "formatDate");
    expect(toolResult!.output).toContain("src/date.ts");
  });

  test("a unique path suffix resolves like the plan's normalization", async () => {
    const { root, service } = await setup();
    const { toolResult } = await queryTurn(root, service, "date.ts");
    expect(toolResult!.output).toContain("src/types.ts");
  });

  test("a hallucinated seed is honestly discarded, never invented", async () => {
    const { root, service } = await setup();
    const { toolResult } = await queryTurn(root, service, "src/auth/login-service.ts");
    expect(toolResult!.output).toContain("not mapped");
    expect(toolResult!.output).not.toContain("reason: related");
  });

  test("a stale seed (file changed after mapping) is discarded with the entry", async () => {
    const { root, service } = await setup();
    await writeFile(join(root, "src/date.ts"), "export const totally = 'changed';");
    const { toolResult } = await queryTurn(root, service, "src/date.ts");
    expect(toolResult!.output).toContain("stale");
  });

  test("an unavailable projection degrades honestly", async () => {
    const { root } = await setup();
    const empty = new MpmService(join(root, "missing-map"));
    const { toolResult } = await queryTurn(root, empty, "src/date.ts");
    expect(toolResult!.output).toContain("unavailable");
  });

  test("without mpm config the tool is absent from the session", async () => {
    const { root } = await setup();
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      cwd: root,
    });
    expect(session.tools["mpm_query"]).toBeUndefined();
  });

  test("the full result is persisted in the event log for replay", async () => {
    const { root, service } = await setup();
    const { toolResult } = await queryTurn(root, service, "src/date.ts");
    // The persisted tool_result carries the neighborhood itself, not a
    // compaction notice (ADR-0028 decision 3).
    expect(toolResult!.output).toContain("src/types.ts");
  });
});
