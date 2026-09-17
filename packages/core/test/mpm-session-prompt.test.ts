import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, type Provider } from "../src/index";
import { MpmService } from "../src/mpm/service";
import { MpmStore } from "../src/mpm/store";
import type { MpmFileRecord } from "../src/mpm/types";
import type { Message } from "../src/types";

/**
 * #616: MPM orientation in the session prompt flow — source-cited injection
 * for eligible tasks, omission for stale/unsupported scopes, and unchanged
 * tool availability.
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
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-session-"));
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

/** Capture provider: records the system prompt seen by the model. */
function capture(): { provider: Provider; seen: () => string } {
  let system = "";
  const provider: Provider = {
    name: "capture",
    async *stream(messages: Message[]) {
      system = (messages[0]!.parts[0] as { text: string }).text;
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  return { provider, seen: () => system };
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("MPM orientation in the session prompt (#616)", () => {
  test("an eligible task gets a source-cited plan in the system prompt", async () => {
    const { root, service } = await setup();
    const { provider, seen } = capture();
    const session = createSession({ provider, cwd: root, mpm: { service, } });
    await session.send("please work on src/date.ts");
    const system = seen();
    expect(system).toContain("## Project map orientation");
    expect(system).toContain("src/types.ts");
    // Coordinates ride along.
    expect(system).toMatch(/src\/types\.ts at line 1/);
    // Never source excerpts.
    expect(system).not.toContain("formatDate(");
    // Tools availability unchanged.
    expect(system).toContain("## Tools");
  });

  test("an ineligible task gets no mpm section at all", async () => {
    const { root, service } = await setup();
    const { provider, seen } = capture();
    const session = createSession({ provider, cwd: root, mpm: { service, } });
    await session.send("update the changelog please");
    expect(seen()).not.toContain("Project map orientation");
  });

  test("a stale projection (file changed after mapping) gets no plan", async () => {
    const { root, service } = await setup();
    await writeFile(join(root, "src/date.ts"), "export const totally = 'changed';");
    const { provider, seen } = capture();
    const session = createSession({ provider, cwd: root, mpm: { service, } });
    await session.send("please work on src/date.ts");
    expect(seen()).not.toContain("Project map orientation");
  });

  test("without mpm config nothing changes; the plan lives one turn only", async () => {
    const { root } = await setup();
    const { provider, seen } = capture();
    const session = createSession({ provider, cwd: root });
    await session.send("work on src/date.ts");
    expect(seen()).not.toContain("Project map orientation");
  });

  test("the plan is turn-scoped: cleared after the turn settles", async () => {
    const { root, service } = await setup();
    const { provider, seen } = capture();
    const session = createSession({ provider, cwd: root, mpm: { service, } });
    await session.send("please work on src/date.ts");
    expect(seen()).toContain("Project map orientation");
    await session.send("now update the changelog");
    expect(seen()).not.toContain("Project map orientation");
  });
});

/** #759: capture provider that emits one reasoning block before finishing. */
function reasoningCapture(reasoningText: string): { provider: Provider; seen: () => string } {
  let system = "";
  const provider: Provider = {
    name: "capture-reasoning",
    async *stream(messages: Message[]) {
      system = (messages[0]!.parts[0] as { text: string }).text;
      yield { type: "model_call_start" as const, model: "capture-reasoning" };
      yield { type: "reasoning_start" as const };
      yield { type: "reasoning_delta" as const, text: reasoningText };
      yield { type: "reasoning_end" as const };
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  return { provider, seen: () => system };
}

// #759: seed eligibility extension at the session level — reasoning from
// the previous model call seeds the next prompt assembly (including
// mid-turn), suppressed after a successful mpm_query.
describe("MPM orientation reasoning seeds in the session (#759)", () => {
  test("a symbol named in the task text yields a medium-tier plan", async () => {
    const { root, service } = await setup();
    const { provider, seen } = capture();
    const session = createSession({ provider, cwd: root, mpm: { service } });
    await session.send("please refactor formatDate");
    expect(seen()).toContain("## Project map orientation");
    expect(seen()).toContain("matches symbol `formatDate`");
  });

  test("reasoning-only mention seeds the next assembly", async () => {
    const { root, service } = await setup();
    // Turn 1 emits reasoning mentioning formatDate; the task text names
    // nothing mappable → no plan in that call's prompt.
    const provider: Provider = {
      name: "capture-seeded",
      async *stream(messages: Message[]) {
        const system = (messages[0]!.parts[0] as { text: string }).text;
        seen.push(system.includes("Project map orientation"));
        yield { type: "model_call_start" as const, model: "capture-seeded" };
        yield { type: "reasoning_start" as const };
        yield { type: "reasoning_delta" as const, text: "We could touch formatDate for this." };
        yield { type: "reasoning_end" as const };
        yield { type: "finish" as const, reason: "stop" as const };
      },
    };
    const seen: boolean[] = [];
    const session = createSession({ provider, cwd: root, mpm: { service } });
    await session.send("continue the task");
    expect(seen).toEqual([false]);
    // The reasoning is now persisted; the next send's assembly seeds from it.
    await session.send("continue the task");
    expect(seen).toEqual([false, true]);
    expect(session.mpmSnapshot()?.fallbackReason).toBe("reasoning-seeded");
  });

  test("thinking off / no reasoning → behavior identical to today", async () => {
    const { root, service } = await setup();
    const { provider, seen } = capture();
    const session = createSession({ provider, cwd: root, mpm: { service } });
    await session.send("continue the task");
    expect(seen()).not.toContain("Project map orientation");
    expect(session.mpmSnapshot()?.fallbackReason).toBe("no-eligible-seed");
  });
});
