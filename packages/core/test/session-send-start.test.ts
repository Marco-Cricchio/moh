import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension, MOH_EXTENSION_API_VERSION, type ExtensionSetupContext } from "@moh/extension";
import { ExtensionRuntime } from "../src/extensions";
import { MockProvider } from "../src/mock-provider";
import { MpmService } from "../src/mpm/service";
import { MpmStore } from "../src/mpm/store";
import type { MpmFileRecord } from "../src/mpm/types";
import { AgentSession } from "../src/session/session";
import type { AgentEvent, Message, Provider } from "../src/types";

/**
 * #1443 characterization: when `send()` starts its turn. With nothing to
 * wait for (no rerank hook wired, no pending extension registration) the
 * turn starts in the same tick — `pending()` is true right after `send()`.
 * A rerank hook or a pending registration defers the start; with both,
 * the rerank is consulted while the registration is still in flight.
 */

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const tmpDirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** An MPM projection where `sharedHelper` resolves to six files — one over
 * the ambiguity threshold, so the send-time rerank hook is consulted. */
async function overThreshold(): Promise<{ root: string; service: MpmService }> {
  const root = await tmp("moh-send-start-mpm-");
  const records: MpmFileRecord[] = [];
  for (let i = 0; i < 6; i++) {
    const p = `src/gen${i}.ts`;
    const content = `export function helper${i}(): number { return ${i}; }`;
    await mkdir(join(root, p, ".."), { recursive: true });
    await writeFile(join(root, p), content);
    records.push({ path: p, hash: sha(content), size: content.length, language: "typescript", symbols: [{ name: "sharedHelper", kind: "function", line: 1 }], relations: [] });
  }
  new MpmStore(join(root, "project-map")).writeProjection(new Map(records.map((r) => [r.path, r])));
  const service = new MpmService(join(root, "project-map"));
  service.load();
  return { root, service };
}

/** Capture provider: records every system prompt the model sees. */
function capture(): { provider: Provider; systems: string[] } {
  const systems: string[] = [];
  const provider: Provider = {
    name: "capture",
    async *stream(messages: Message[]) {
      systems.push((messages[0]!.parts[0] as { text: string }).text);
      yield { type: "text_delta" as const, text: "ok" };
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  return { provider, systems };
}

async function runtime(): Promise<ExtensionRuntime> {
  const home = await tmp("moh-send-start-home-");
  return new ExtensionRuntime({ mohHome: home, projectRoot: home, consent: () => true });
}

/** Registers an extension whose setup waits on `gate` before adding a
 * `beforeTurn` hook — a registration pending until the gate opens. */
function gatedExtension(rt: ExtensionRuntime, hookCalls: string[]): { open: () => void; registered: Promise<boolean> } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const registered = rt.register(
    defineExtension({
      name: "late",
      version: "1.0.0",
      apiVersion: MOH_EXTENSION_API_VERSION,
      setup: async (ctx: ExtensionSetupContext) => {
        await gate;
        ctx.beforeTurn(() => {
          hookCalls.push("beforeTurn");
        });
      },
    }),
    { bundled: true },
  );
  return { open, registered };
}

describe("#1443 send() turn start", () => {
  test("no rerank, no pending registration: the turn starts in the same tick", async () => {
    const rt = await runtime();
    await rt.ready();
    expect(rt.hasPendingRegistrations()).toBe(false);
    const session = new AgentSession({ provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]), cwd: await tmp("moh-send-start-cwd-"), extensions: rt });
    const run = session.send("hi");
    expect(session.pending()).toBe(true);
    expect((await run).status).toBe("done");
    expect(session.pending()).toBe(false);
    await session.dispose();
  });

  test("a pending registration defers the start until it settles; its hook sees the first turn", async () => {
    const rt = await runtime();
    const hookCalls: string[] = [];
    const late = gatedExtension(rt, hookCalls);
    expect(rt.hasPendingRegistrations()).toBe(true);
    const session = new AgentSession({ provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]), cwd: await tmp("moh-send-start-cwd-"), extensions: rt });
    const run = session.send("hi");
    expect(session.pending()).toBe(false);
    await Bun.sleep(10);
    expect(session.pending()).toBe(false);
    late.open();
    expect(await late.registered).toBe(true);
    expect((await run).status).toBe("done");
    expect(hookCalls).toEqual(["beforeTurn"]);
    await session.dispose();
  });

  test("a wired rerank hook defers the start (rerank-only path): exact event sequence and plan", async () => {
    const { root, service } = await overThreshold();
    const { provider, systems } = capture();
    let calls = 0;
    const events: AgentEvent[] = [];
    const session = new AgentSession({
      provider,
      cwd: root,
      sink: (e) => events.push(e),
      mpm: {
        service,
        rerank: async () => {
          calls += 1;
          return new Set(["src/gen0.ts", "src/gen2.ts"]);
        },
      },
    });
    const run = session.send("update sharedHelper usage");
    expect(session.pending()).toBe(false);
    expect((await run).status).toBe("done");
    expect(calls).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["session_start", "session_mode", "user_message", "assistant_delta", "done"]);
    expect(systems).toHaveLength(1);
    const plan = systems[0]!.slice(systems[0]!.indexOf("Project map orientation"));
    expect(plan).toBe(
      "Project map orientation (advisory — verify against source)\n\n- src/gen0.ts — matches symbol `sharedHelper` (reranked)\n- src/gen2.ts — matches symbol `sharedHelper` (reranked)\n\nStart near these files; explore and verify as usual.",
    );
    await session.dispose();
  });

  test("rerank and a pending registration: the rerank is consulted while the registration is in flight", async () => {
    const { root, service } = await overThreshold();
    const { provider, systems } = capture();
    const rt = await runtime();
    const hookCalls: string[] = [];
    const late = gatedExtension(rt, hookCalls);
    const order: string[] = [];
    const session = new AgentSession({
      provider,
      cwd: root,
      extensions: rt,
      mpm: {
        service,
        rerank: async () => {
          order.push(rt.hasPendingRegistrations() ? "rerank:registration-pending" : "rerank:registration-settled");
          return new Set(["src/gen0.ts", "src/gen2.ts"]);
        },
      },
    });
    const run = session.send("update sharedHelper usage");
    expect(session.pending()).toBe(false);
    await Bun.sleep(10);
    expect(order).toEqual(["rerank:registration-pending"]);
    expect(session.pending()).toBe(false);
    late.open();
    expect((await run).status).toBe("done");
    expect(hookCalls).toEqual(["beforeTurn"]);
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain("reranked");
    await session.dispose();
  });

  test("a gate returning false with a wired rerank: no rerank call, no plan", async () => {
    const { root, service } = await overThreshold();
    const { provider, systems } = capture();
    let calls = 0;
    const session = new AgentSession({
      provider,
      cwd: root,
      mpm: {
        service,
        turnGate: () => false,
        rerank: async () => {
          calls += 1;
          return new Set(["src/gen0.ts", "src/gen2.ts"]);
        },
      },
    });
    expect((await session.send("update sharedHelper usage")).status).toBe("done");
    expect(calls).toBe(0);
    expect(systems[0]).not.toContain("Project map orientation");
    expect(session.mpmSnapshot()?.fallbackReason).toBe("classifier-gated");
    await session.dispose();
  });
});
