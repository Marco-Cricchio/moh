/**
 * #1444 characterization: the hook-timeout races of `ExtensionRuntime`
 * (ADR-0056 `#runCapped`, the #979 compaction window, the ADR-0054 +
 * ADR-0056 two-clock `beforeModelCall`) and the dispatches that stay
 * unbounded (C11). Pinned on the implementation before the races share
 * one primitive: every record's reason and exact text, what a late answer
 * or late throw does, which bucket a late error lands in, and where the
 * extension scope is active. Shrunk clocks; waits poll state.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRuntime } from "../src/extensions";
import { currentExtensionScope } from "../src/extension-scope";
import { defineExtension, MOH_EXTENSION_API_VERSION } from "@moh/extension";
import type { ExtensionSetupContext } from "@moh/extension";
import type { AgentEvent } from "../src/types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CEILING = 80;
const WINDOW = 40;

async function runtimeWith(name: string, setup: (ctx: ExtensionSetupContext) => void): Promise<ExtensionRuntime> {
  const dir = mkdtempSync(join(tmpdir(), "moh-hook-race-"));
  dirs.push(dir);
  const rt = new ExtensionRuntime({
    mohHome: dir,
    consent: () => true,
    authorizeDependencies: () => true,
    hookTimeoutMs: CEILING,
    replacementWindowMs: WINDOW,
  });
  await rt.register(defineExtension({ name, version: "1.0.0", apiVersion: MOH_EXTENSION_API_VERSION, setup }));
  return rt;
}

/** Polls `cond` until it holds or the deadline names the stuck step. */
async function waitFor(cond: () => boolean, step: string, deadlineMs = 3_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`stuck waiting for: ${step}`);
    await Bun.sleep(5);
  }
}

/** Drains the owner bucket through a dispatch no hook listens to. */
async function drain(rt: ExtensionRuntime): Promise<AgentEvent[]> {
  return rt.dispatchEvent({ type: "hook_race_probe" } as unknown as AgentEvent);
}

/** Drains until something arrives (the late record lands a few microtasks
 * after the hook's own promise settles). */
async function drainUntil(rt: ExtensionRuntime, step: string, deadlineMs = 3_000): Promise<AgentEvent[]> {
  const until = Date.now() + deadlineMs;
  const got: AgentEvent[] = [];
  while (got.length === 0) {
    got.push(...(await drain(rt)));
    if (got.length > 0) break;
    if (Date.now() > until) throw new Error(`stuck waiting for: ${step}`);
    await Bun.sleep(5);
  }
  return got;
}

const bmcCtx = { prompt: { sections: {}, system: "", version: "x" }, messages: [] } as any;
const turnCtx = { text: "hi", turnIndex: 0, model: "m", endpointCooldowns: [] } as any;
const compactionCtx = { sections: [{ id: "s0", bytes: 10 }] } as any;

describe("#runCapped: a throw after the ceiling is one timeout, then one late error (#1143)", () => {
  type Case = {
    label: string;
    register: (ctx: ExtensionSetupContext, hook: () => Promise<any>) => void;
    dispatch: (rt: ExtensionRuntime) => Promise<{ errors: AgentEvent[]; contributed: unknown }>;
  };
  const cases: Case[] = [
    {
      label: "beforeTurn",
      register: (ctx, hook) => ctx.beforeTurn(hook),
      dispatch: async (rt) => {
        const d = await rt.dispatchBeforeTurn(turnCtx);
        return { errors: d.errors, contributed: d.model ?? d.confirm };
      },
    },
    {
      label: "onToolResult",
      register: (ctx, hook) => ctx.onToolResult(["echo"], hook),
      dispatch: async (rt) => {
        const d = await rt.checkToolResultHooks({ callId: "c1", name: "echo", args: {}, output: "x" });
        return { errors: d.errors, contributed: d.withheld };
      },
    },
    {
      label: "onToolCall",
      register: (ctx, hook) => ctx.onToolCall(hook),
      dispatch: async (rt) => {
        const d = await rt.checkToolHooks({ callId: "c1", name: "echo", args: {} });
        return { errors: d.errors, contributed: d.veto || d.ask ? d : undefined };
      },
    },
    {
      label: "afterTurn",
      register: (ctx, hook) => ctx.afterTurn(hook),
      dispatch: async (rt) => ({ errors: await rt.dispatchAfterTurn({ status: "done" }), contributed: undefined }),
    },
  ];

  for (const c of cases) {
    test(`${c.label}: the late value never lands; the late throw is recorded once, after the timeout`, async () => {
      let ended = false;
      const rt = await runtimeWith("late", (ctx) =>
        c.register(ctx, async () => {
          await Bun.sleep(CEILING * 3);
          ended = true;
          throw new Error("late boom");
        }),
      );
      const first = await c.dispatch(rt);
      expect(first.contributed).toBeUndefined();
      expect(first.errors).toEqual([
        {
          type: "extension_failed",
          name: "late",
          reason: "hook_timeout",
          message: `the ${c.label} hook did not answer within ${CEILING}ms; it contributed nothing`,
        },
      ]);
      await waitFor(() => ended, "hook end");
      const later = await drainUntil(rt, "late error");
      await Bun.sleep(20);
      later.push(...(await drain(rt)));
      expect(later).toEqual([
        {
          type: "extension_failed",
          name: "late",
          reason: "hook_late_error",
          message: `the ${c.label} hook threw after its ${CEILING}ms timeout: late boom`,
        },
      ]);
    });
  }

  test("a late value (no throw) after the ceiling records nothing more", async () => {
    let ended = false;
    const rt = await runtimeWith("late-value", (ctx) =>
      ctx.onToolCall(async () => {
        await Bun.sleep(CEILING * 3);
        ended = true;
        return { veto: true, reason: "too late" };
      }),
    );
    const verdict = await rt.checkToolHooks({ callId: "c1", name: "echo", args: {} });
    expect(verdict.veto).toBe(false);
    expect(verdict.errors.map((e) => (e as { reason?: string }).reason)).toEqual(["hook_timeout"]);
    await waitFor(() => ended, "hook end");
    await Bun.sleep(20);
    expect(await drain(rt)).toEqual([]);
  });

  test("the late error lands in the bucket captured at timeout time (borrowed session), not the owner's", async () => {
    let ended = false;
    const rt = await runtimeWith("borrowed-late", (ctx) =>
      ctx.onToolCall(async () => {
        await Bun.sleep(CEILING * 3);
        ended = true;
        throw new Error("late in child");
      }),
    );
    const scope = { id: "child", write: () => {}, errors: [] as AgentEvent[] };
    const verdict = await rt.withSession(scope, () => rt.checkToolHooks({ callId: "c1", name: "echo", args: {} }));
    expect(verdict.errors.map((e) => (e as { reason?: string }).reason)).toEqual(["hook_timeout"]);
    expect(scope.errors).toEqual([]);
    await waitFor(() => ended, "hook end");
    await waitFor(() => scope.errors.length > 0, "late error in the child bucket");
    expect(scope.errors).toEqual([
      {
        type: "extension_failed",
        name: "borrowed-late",
        reason: "hook_late_error",
        message: `the onToolCall hook threw after its ${CEILING}ms timeout: late in child`,
      },
    ]);
    expect(await drain(rt)).toEqual([]);
  });
});

describe("C11: the unbounded dispatches stay unbounded", () => {
  test("onEvent runs past the ceiling, is awaited, and records nothing", async () => {
    let finished = false;
    const rt = await runtimeWith("slow-observer", (ctx) =>
      ctx.onEvent(async () => {
        await Bun.sleep(CEILING * 2);
        finished = true;
      }),
    );
    const errors = await rt.dispatchEvent({ type: "x" } as unknown as AgentEvent);
    expect(finished).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a throwing onEvent is one fail-open hook record", async () => {
    const rt = await runtimeWith("bad-observer", (ctx) =>
      ctx.onEvent(() => {
        throw new Error("observer boom");
      }),
    );
    expect(await rt.dispatchEvent({ type: "x" } as unknown as AgentEvent)).toEqual([
      { type: "extension_failed", name: "bad-observer", reason: "hook", message: "observer boom" },
    ]);
  });

  test("onModelError answering past the ceiling still counts", async () => {
    const rt = await runtimeWith("slow-retry", (ctx) =>
      ctx.onModelError(async () => {
        await Bun.sleep(CEILING * 2);
        return { model: "fallback/model" };
      }),
    );
    const out = await rt.dispatchModelError({} as any);
    expect(out).toEqual({ model: "fallback/model", by: "slow-retry", errors: [] });
  });
});

describe("dispatchCompaction: the #979 window", () => {
  const timeoutRecord = (name: string, ms: number) => ({
    type: "extension_failed" as const,
    name,
    reason: "hook",
    message: `the compaction hook did not answer within ${ms}ms; no drops were applied`,
  });

  test("a hook past its window is one exact record and no drops", async () => {
    const rt = await runtimeWith("slow-cut", (ctx) =>
      ctx.onCompaction(async () => {
        await Bun.sleep(200);
        return { drop: ["s0"] };
      }),
    );
    const out = await rt.dispatchCompaction(compactionCtx, 30);
    expect(out.drop).toEqual([]);
    expect(out.onApplied).toEqual([]);
    expect(out.errors).toEqual([timeoutRecord("slow-cut", 30)]);
  });

  test("a throw after the window is never recorded and never reaches onApplied", async () => {
    let ended = false;
    const rt = await runtimeWith("late-cut", (ctx) =>
      ctx.onCompaction(async () => {
        await Bun.sleep(120);
        ended = true;
        throw new Error("late cut boom");
      }),
    );
    const out = await rt.dispatchCompaction(compactionCtx, 30);
    expect(out.errors).toEqual([timeoutRecord("late-cut", 30)]);
    await waitFor(() => ended, "hook end");
    await Bun.sleep(20);
    expect(await drain(rt)).toEqual([]);
  });

  test("a hook rejecting synchronously on abort is recorded as the timeout, not as its own error", async () => {
    const rt = await runtimeWith("abort-reject", (ctx) =>
      ctx.onCompaction(
        (c) =>
          new Promise((_, reject) => {
            c.signal?.addEventListener("abort", () => reject(new Error("stopped by abort")));
          }),
      ),
    );
    const out = await rt.dispatchCompaction(compactionCtx, 30);
    expect(out.drop).toEqual([]);
    expect(out.errors).toEqual([timeoutRecord("abort-reject", 30)]);
    await Bun.sleep(20);
    expect(await drain(rt)).toEqual([]);
  });

  test("a hook resolving synchronously on abort: timeout record, no drops, onApplied(applied:false) once, outside the extension scope", async () => {
    const applied: { a: unknown; scope: string | null }[] = [];
    const rt = await runtimeWith("abort-resolve", (ctx) =>
      ctx.onCompaction(
        (c) =>
          new Promise((resolve) => {
            c.signal?.addEventListener("abort", () =>
              resolve({ drop: ["s0"], onApplied: (a) => applied.push({ a, scope: currentExtensionScope() }) }),
            );
          }),
      ),
    );
    const out = await rt.dispatchCompaction(compactionCtx, 30);
    expect(out.drop).toEqual([]);
    expect(out.onApplied).toEqual([]);
    expect(out.errors).toEqual([timeoutRecord("abort-resolve", 30)]);
    await waitFor(() => applied.length > 0, "late onApplied");
    await Bun.sleep(20);
    expect(applied).toEqual([
      { a: { keptByFloor: false, bytesAfter: 10, droppedIds: [], applied: false }, scope: null },
    ]);
  });

  test("a hook answering in time runs in its scope and its signal never aborts", async () => {
    let signal: AbortSignal | undefined;
    let scope = null as string | null;
    const rt = await runtimeWith("quick-cut", (ctx) =>
      ctx.onCompaction((c) => {
        signal = c.signal;
        scope = currentExtensionScope();
        return { drop: ["s0"] };
      }),
    );
    const out = await rt.dispatchCompaction(compactionCtx, 30);
    expect(out.drop).toEqual(["s0"]);
    expect(out.errors).toEqual([]);
    expect(scope).toBe("quick-cut");
    await Bun.sleep(60); // past the window: the cleared timer never aborts
    expect(signal?.aborted).toBe(false);
  });
});

describe("dispatchBeforeModelCall: past the ceiling", () => {
  test("a late answer or late throw after the ceiling adds nothing", async () => {
    let ended = 0;
    const dir = mkdtempSync(join(tmpdir(), "moh-hook-race-"));
    dirs.push(dir);
    const rt = new ExtensionRuntime({
      mohHome: dir,
      consent: () => true,
      authorizeDependencies: () => true,
      hookTimeoutMs: CEILING,
      replacementWindowMs: WINDOW,
    });
    await rt.register(
      defineExtension({
        name: "gone-value",
        version: "1.0.0",
        apiVersion: MOH_EXTENSION_API_VERSION,
        setup: (ctx) =>
          ctx.beforeModelCall(async () => {
            await Bun.sleep(CEILING * 3);
            ended += 1;
            return { sections: { memory: "never" } };
          }),
      }),
    );
    await rt.register(
      defineExtension({
        name: "gone-throw",
        version: "1.0.0",
        apiVersion: MOH_EXTENSION_API_VERSION,
        setup: (ctx) =>
          ctx.beforeModelCall(async () => {
            await Bun.sleep(CEILING * 3);
            ended += 1;
            throw new Error("after the ceiling");
          }),
      }),
    );
    const dispatch = await rt.dispatchBeforeModelCall(bmcCtx);
    expect(dispatch.replacements).toEqual([]);
    expect(dispatch.timeouts).toEqual([
      { by: "gone-value", window: "replacement" },
      { by: "gone-value", window: "hook" },
      { by: "gone-throw", window: "replacement" },
      { by: "gone-throw", window: "hook" },
    ]);
    expect(dispatch.errors.map((e) => `${(e as { name: string }).name}:${(e as { reason: string }).reason}`)).toEqual([
      "gone-value:replacement_timeout",
      "gone-value:hook_timeout",
      "gone-throw:replacement_timeout",
      "gone-throw:hook_timeout",
    ]);
    await waitFor(() => ended === 2, "both hooks end");
    await Bun.sleep(20);
    expect(await drain(rt)).toEqual([]);
  });
});

describe("the extension scope is active inside every capped hook", () => {
  test("runCapped and beforeModelCall run the hook marked", async () => {
    const seen: Record<string, string | null> = {};
    const rt = await runtimeWith("marked", (ctx) => {
      ctx.onToolCall(() => {
        seen.onToolCall = currentExtensionScope();
      });
      ctx.beforeModelCall(async () => {
        await Promise.resolve();
        seen.beforeModelCall = currentExtensionScope();
      });
    });
    await rt.checkToolHooks({ callId: "c1", name: "echo", args: {} });
    await rt.dispatchBeforeModelCall(bmcCtx);
    expect(seen).toEqual({ onToolCall: "marked", beforeModelCall: "marked" });
    expect(currentExtensionScope()).toBeNull();
  });
});
