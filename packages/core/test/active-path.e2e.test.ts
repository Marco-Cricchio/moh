/**
 * #577: end-to-end active-path projection — a session with abandoned
 * branches resumes, replays, and shows the model exactly the root→head
 * path; switching branches is how the model sees a different past.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, activePath, createSession } from "../src/index";
import { SessionStore, listSessionSummaries, switchBranch } from "../src/session-store";
import type { AgentEvent } from "../src/types";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "moh-path-"));
}

function load(file: string): AgentEvent[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as AgentEvent);
}

describe("active path end-to-end (#577)", () => {
  test("model context after resume is the root→head path only; abandoned branch excluded", async () => {
    const home = tempHome();
    const dir = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(dir, home);
    const session = createSession({
      provider: MockProvider.scripted([
        { deltas: ["answer one"], finish: "stop" },
        { deltas: ["answer two"], finish: "stop" },
      ]),
      sink: (e) => store.append(e),
    });
    await session.send("first question");
    await session.send("second question");
    await session.dispose({ timeoutMs: 5_000 });

    // Divergence-style foreign line: an identified user_message with no
    // parent chain (a #400 foreign tail, off-path by construction).
    const file = store.file;
    const preGrowth = statSync(file).size;
    writeFileSync(
      file,
      readFileSync(file, "utf8") +
        JSON.stringify({ type: "user_message", text: "orphan", id: "01ZZZZZZZZZZZZZZZZZZZZZZZX" }) + "\n",
    );

    // Resume and work on the session: consumption is computed on the path.
    const resumed = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => store.append(e),
      sessionFile: file,
      externalGrowth: () => {
        const size = statSync(file).size;
        return size > preGrowth ? { expectedBytes: preGrowth, actualBytes: size } : null;
      },
      resume: { events: load(file) },
    });
    await resumed.send("after resume");
    await resumed.dispose({ timeoutMs: 5_000 });

    const path = activePath(load(file));
    // The orphan never rides the path — excluded, never merged.
    expect(path.some((e) => e.type === "user_message" && (e as { text: string }).text === "orphan")).toBe(false);
    // The full pre-divergence history stays on the path (no switch here:
    // the local writer's chain reached the root), plus the resumed turn.
    expect(path.some((e) => e.type === "user_message" && (e as { text: string }).text === "second question")).toBe(true);
    expect(path.some((e) => e.type === "user_message" && (e as { text: string }).text === "after resume")).toBe(true);
    expect(path.some((e) => e.type === "session_resumed")).toBe(true);
    // Consumption: peekSession runs on the path. The resumed-and-worked-on
    // session is suggestible again (work after the resume marker flips the
    // predicate); the off-path orphan turn never counts.
    const summary = listSessionSummaries(dir, home).find((s) => s.file === file);
    expect(summary?.consumed).toBe(false);
  });

  test("a branch switch re-roots the model context: the abandoned sibling branch disappears", async () => {
    const home = tempHome();
    const dir = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(dir, home);
    const session = createSession({
      provider: MockProvider.scripted([
        { deltas: ["answer one"], finish: "stop" },
        { deltas: ["answer two"], finish: "stop" },
      ]),
      sink: (e) => store.append(e),
    });
    await session.send("first question");
    const events = load(store.file);
    // Switch to the node just before the first turn's reply: interior node.
    const forkPoint = events.find((e) => e.type === "user_message")!.id!;
    session.switchBranch(forkPoint);
    await session.send("second question");
    await session.dispose({ timeoutMs: 5_000 });

    // Resume: the model context must be exactly root→head — one turn.
    const resumed = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => store.append(e),
      resume: { events: load(store.file) },
    });
    await resumed.send("after switch");
    await resumed.dispose({ timeoutMs: 5_000 });

    const path = activePath(load(store.file));
    const userTexts = path
      .filter((e) => e.type === "user_message")
      .map((e) => (e as { text: string }).text);
    // The pre-switch "first question" turn was rewritten by the switch:
    // the path holds only the fork point's turn and the resumed one.
    expect(userTexts).toEqual(["first question", "second question", "after switch"]);
  });
});

describe("consumption on the path (#577 acceptance)", () => {
  test("an abandoned branch's turn no longer consumes the head", async () => {
    const home = tempHome();
    const dir = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(dir, home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["a1"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await session.send("only turn");
    await session.dispose({ timeoutMs: 5_000 });
    const file = store.file;
    // Resume once (consumes), then close without further work.
    const r1 = createSession({
      provider: MockProvider.scripted([{ deltas: [], finish: "stop" }]),
      sink: (e) => store.append(e),
      resume: { events: load(file) },
    });
    await r1.dispose({ timeoutMs: 5_000 });
    expect(listSessionSummaries(dir, home).find((s) => s.file === file)?.consumed).toBe(true);

    // A foreign writer appends a turn chained to the resumed marker (a
    // #400-style foreign tail). Another reader then switches the head back
    // to the pre-divergence local tip — the foreign turn becomes an
    // abandoned branch.
    const events = load(file);
    const resumedMarker = [...events].reverse().find((e) => e.type === "session_resumed")!;
    const foreignTurn = {
      type: "user_message",
      text: "foreign work",
      id: "01YYYYYYYYYYYYYYYYYYYYYYYYWX",
      parentId: resumedMarker.id,
    };
    writeFileSync(
      file,
      readFileSync(file, "utf8") + JSON.stringify(foreignTurn) + "\n",
    );
    const tip = [...events].reverse().find((e) => e.type === "done")!.id!;
    switchBranch(file, tip);
    // After the switch, the foreign turn (and the resumed marker, which
    // rode its branch) are off-path: the model path ends at the local
    // tip, and with no on-path resume marker the session is suggestible.
    expect(listSessionSummaries(dir, home).find((s) => s.file === file)?.consumed).toBe(false);
    const path = activePath(load(file));
    expect(path.some((e) => (e as { text?: string }).text === "foreign work")).toBe(false);
  });
});
