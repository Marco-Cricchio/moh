/**
 * #1487: an `onEvent` hook that appends while the session is appending.
 *
 * With the dispatch queue idle, `EventLog.append` dispatches the event it
 * just stored synchronously — the hook runs inside the session's append,
 * re-entrantly. With the queue busy (an earlier event's dispatch still in
 * flight) the hook runs later, from the drain chain. Either way every
 * event of the turn must chain on the turn's path, and the recorded tree
 * must not depend on which of the two happened.
 *
 * The provider holds its stream until the hook has flooded, so the turn's
 * own events land at the same position in both variants; a probe on the
 * sink tells the two variants apart, so each test checks its own premise.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, ExtensionRuntime, MockProvider } from "../src/index";
import { activePath } from "../src/session/event-log";
import { defineExtension, MOH_EXTENSION_API_VERSION } from "@moh/extension";
import type { ExtensionSetupContext } from "@moh/extension";
import type { AgentEvent, Provider } from "../src/index";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtime(): ExtensionRuntime {
  const dir = mkdtempSync(join(tmpdir(), "moh-reentrant-"));
  dirs.push(dir);
  return new ExtensionRuntime({ mohHome: dir, consent: () => true, authorizeDependencies: () => true });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** The ids reached walking `parentId` back from `from`. */
function walk(log: ReadonlyArray<AgentEvent>, from: AgentEvent): Set<string> {
  const byId = new Map(log.map((e) => [e.id!, e]));
  const reached = new Set<string>();
  let cursor: AgentEvent | undefined = from;
  while (cursor !== undefined && !reached.has(cursor.id!)) {
    reached.add(cursor.id!);
    cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
  }
  return reached;
}

/** The index of the log's last `done`: the turn's final event. */
function lastDone(log: ReadonlyArray<AgentEvent>): number {
  for (let i = log.length - 1; i >= 0; i--) if (log[i]!.type === "done") return i;
  return -1;
}

/** A label per event (`extension_event` by name) — what a shape compares. */
function label(e: AgentEvent): string {
  return e.type === "extension_event" ? `extension_event:${(e as { name: string }).name}` : e.type;
}

/** The tree as `label <- parent label`, in file order: ids are minted per run. */
function shape(log: ReadonlyArray<AgentEvent>): string[] {
  const byId = new Map(log.map((e) => [e.id!, e]));
  return log.map((e) => `${label(e)} <- ${e.parentId === undefined ? "(root)" : label(byId.get(e.parentId)!)}`);
}

/**
 * One turn whose `onEvent` hook appends `flood` events on `user_message`.
 * `busy` keeps the dispatch queue busy at the `user_message` append: the
 * `beforeTurn` record's own dispatch waits until the provider is read.
 */
async function floodTurn(options: {
  busy: boolean;
  flood: number;
  throwOnUserMessage?: boolean;
  /** `beforeTurn` records before the `pre` marker (budget tests). */
  preRecords?: number;
}): Promise<{ log: AgentEvent[]; before: number; reentrant: boolean | undefined }> {
  const queueBusy = deferred();
  const flooded = deferred();
  // The sink runs inside `EventLog.append`, before the dispatch: a hook
  // that still sees `inAppend` ran in the same synchronous stack.
  let inAppend = false;
  let reentrant: boolean | undefined;
  const rt = runtime();
  await rt.register(
    defineExtension({
      name: "flooder",
      version: "1.0.0",
      apiVersion: MOH_EXTENSION_API_VERSION,
      setup: (ctx: ExtensionSetupContext) => {
        ctx.beforeTurn(async () => {
          for (let i = 0; i < (options.preRecords ?? 0); i++) ctx.appendEvent({ name: "early", payload: { i } });
          ctx.appendEvent({ name: "pre" });
          // A macrotask boundary: the `pre` dispatch (no wait when idle)
          // has fully drained before the turn logs its `user_message`.
          await new Promise((r) => setTimeout(r, 0));
        });
        ctx.onEvent(async ({ event }) => {
          if (event.type === "extension_event" && (event as unknown as { name: string }).name === "pre" && options.busy) {
            await queueBusy.promise;
            return;
          }
          if (event.type !== "user_message") return;
          reentrant = inAppend;
          try {
            if (options.throwOnUserMessage) throw new Error("onEvent boom");
            for (let i = 0; i < options.flood; i++) ctx.appendEvent({ name: "flood", payload: { i } });
          } finally {
            flooded.resolve();
          }
        });
      },
    }),
  );
  const inner = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
  const provider: Provider = {
    name: inner.name,
    async *stream(...args: Parameters<Provider["stream"]>) {
      // Reading the provider ends the busy window, then waits for the flood:
      // the turn's own events land after it in both variants.
      queueBusy.resolve();
      await flooded.promise;
      yield* inner.stream(...args);
    },
  };
  const session = createSession({
    provider,
    extensions: rt,
    sink: (event) => {
      if (event.type !== "user_message") return;
      inAppend = true;
      queueMicrotask(() => (inAppend = false));
    },
  });
  // The load chrome's own dispatches drain before the turn starts.
  await new Promise((r) => setTimeout(r, 0));
  const before = session.history().length;
  expect(await session.send("go")).toMatchObject({ status: "done" });
  const log = session.history();
  await session.dispose();
  return { log, before, reentrant };
}

describe("#1487: re-entrant onEvent appends stay on the turn's path", () => {
  for (const busy of [false, true]) {
    const variant = busy ? "busy queue (deferred dispatch)" : "idle queue (re-entrant dispatch)";

    test(`${variant}: walking parentId from the final done reaches every event of the turn`, async () => {
      const { log, before, reentrant } = await floodTurn({ busy, flood: 5 });
      // The premise: the hook ran inside the append exactly when the queue was idle.
      expect(reentrant).toBe(!busy);
      const doneIndex = lastDone(log);
      expect(doneIndex).toBeGreaterThan(before);
      const reached = walk(log, log[doneIndex]!);
      const missed = log.slice(before, doneIndex + 1).filter((e) => !reached.has(e.id!)).map(label);
      expect(missed).toEqual([]);
      expect(log.filter((e) => label(e) === "extension_event:flood")).toHaveLength(5);
      // The flood chains on the user_message it answers.
      const firstFlood = log.find((e) => label(e) === "extension_event:flood")!;
      expect(log.find((e) => e.id === firstFlood.parentId)?.type).toBe("user_message");
      // Every event of the log is on the active path: no side branch.
      expect(activePath(log).map((e) => e.id)).toEqual(log.map((e) => e.id));
    });

    test(`${variant}: a capped flood keeps its event_cap failure on the path`, async () => {
      const { log, before, reentrant } = await floodTurn({ busy, flood: 60 });
      expect(reentrant).toBe(!busy);
      const doneIndex = lastDone(log);
      const reached = walk(log, log[doneIndex]!);
      const turn = log.slice(before, doneIndex + 1);
      const cap = turn.filter((e) => e.type === "extension_failed" && (e as { reason: string }).reason === "event_cap");
      expect(cap).toHaveLength(1);
      expect(turn.filter((e) => !reached.has(e.id!)).map(label)).toEqual([]);
    });

    test(`${variant}: a throwing hook's extension_failed is on the path`, async () => {
      const { log, before, reentrant } = await floodTurn({ busy, flood: 0, throwOnUserMessage: true });
      expect(reentrant).toBe(!busy);
      const failed = log.filter((e) => e.type === "extension_failed" && (e as { reason: string }).reason === "hook");
      expect(failed).toHaveLength(1);
      const doneIndex = lastDone(log);
      const reached = walk(log, log[doneIndex]!);
      expect(log.slice(before, doneIndex + 1).filter((e) => !reached.has(e.id!)).map(label)).toEqual([]);
    });
  }

  test("idle and busy queues record the same tree shape", async () => {
    const idle = await floodTurn({ busy: false, flood: 60 });
    const busy = await floodTurn({ busy: true, flood: 60 });
    expect(idle.reentrant).toBe(true);
    expect(busy.reentrant).toBe(false);
    expect(shape(busy.log)).toEqual(shape(idle.log));
  });
});

describe("#1487: the per-turn appendEvent budget resets once per turn", () => {
  test("with beforeTurn, the 51st event of the turn is capped", async () => {
    // 49 `early` + `pre` in beforeTurn (50: the whole budget), then the
    // user_message's hook records one more — the turn's 51st.
    for (const busy of [false, true]) {
      const { log, before } = await floodTurn({ busy, flood: 1, preRecords: 49 });
      const turn = log.slice(before);
      expect(turn.filter((e) => e.type === "extension_event")).toHaveLength(50);
      expect(turn.filter((e) => label(e) === "extension_event:flood")).toHaveLength(0);
      const cap = turn.filter((e) => e.type === "extension_failed" && (e as { reason: string }).reason === "event_cap");
      expect(cap).toHaveLength(1);
    }
  });

  test("a synthetic turn (no beforeTurn dispatch) still gets its own reset", async () => {
    const rt = runtime();
    await rt.register(
      defineExtension({
        name: "flooder",
        version: "1.0.0",
        apiVersion: MOH_EXTENSION_API_VERSION,
        setup: (ctx: ExtensionSetupContext) => {
          ctx.beforeTurn(() => {
            for (let i = 0; i < 60; i++) ctx.appendEvent({ name: "early", payload: { i } });
          });
          ctx.onEvent(({ event }) => {
            if (event.type === "user_message" && event.synthetic === true) {
              for (let i = 0; i < 10; i++) ctx.appendEvent({ name: "synthetic", payload: { i } });
            }
          });
        },
      }),
    );
    const session = createSession({ provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]), extensions: rt });
    await session.send("cap out"); // the user turn exhausts its budget
    expect(await session.runSyntheticTurn("follow up")).toMatchObject({ ok: true });
    // The synthetic user_message's dispatch may queue behind the first
    // turn's: dispose drains the queue before the log is read.
    await session.dispose();
    const records = session.history().filter((e) => label(e) === "extension_event:synthetic");
    expect(records).toHaveLength(10);
  });
});
