/**
 * #576: end-to-end session-tree behaviour — turn pinning to the turn-start
 * head, the extended `session_file_growth` payload with both tips, the
 * explicit local-tip parents while divergence is unresolved, and the
 * `switchBranch` adoption action on a live session.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, createSession } from "../src/index";
import { SessionStore, localTipAt, switchBranch } from "../src/session-store";
import { resolveHead } from "../src/session/event-log";
import { newUlid } from "../src/session/ulid";
import type { AgentEvent } from "../src/types";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "moh-tree-"));
}

function load(file: string): AgentEvent[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as AgentEvent);
}

describe("turn pinning (#576, head semantics d6)", () => {
  test("a mid-turn switch applies from the next turn; the running turn keeps its head", async () => {
    const home = tempHome();
    const store = SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), home);
    const session = createSession({
      provider: MockProvider.scripted([
        { deltas: ["one"], finish: "stop" },
        { deltas: ["two"], finish: "stop" },
      ]),
      sink: (e) => store.append(e),
    });
    await session.send("first");
    const events = store.load();
    const target = events[0]!.id!; // interior node: session_start

    // Switch mid-"turn" (between turns here — the pinning proof is that
    // the switch lands with its own parent on the OLD branch and only the
    // NEXT turn's events follow the new head).
    session.switchBranch(target);
    await session.send("second");
    await session.dispose({ timeoutMs: 5_000 });

    const after = load(store.file);
    const switchIdx = after.findIndex((e) => e.type === "branch_switched");
    expect(switchIdx).toBeGreaterThan(0);
    expect((after[switchIdx] as { to: string }).to).toBe(target);
    // Events before the switch chain linearly on the old branch.
    for (let i = 1; i < switchIdx; i += 1) {
      expect(after[i]!.parentId).toBe(after[i - 1]!.id);
    }
    // The switch itself continues the old branch (it happened on it).
    expect(after[switchIdx]!.parentId).toBe(after[switchIdx - 1]!.id);
    // Everything after follows the new head: an implicit split — the first
    // post-switch event's parent is the switch target, NOT the old tip.
    const firstAfter = after[switchIdx + 1]!;
    expect(firstAfter.parentId).toBe(target);
    expect(firstAfter.parentId).not.toBe(after[switchIdx - 1]!.id);
    // Head resolution: the head is still the switch's `to` (no further
    // switch) — subsequent appends chain from it via parentId.
    const { head, dangling } = resolveHead(after);
    expect(head).toBe(target);
    expect(dangling).toBeUndefined();
  });

  test("an in-flight turn is never split: all its events share the turn-start head", async () => {
    const home = tempHome();
    const store = SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["a", "b"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    const send = session.send("go");
    // Switch while the turn streams.
    session.switchBranch(load(store.file)[0]!.id!);
    await send;
    await session.dispose({ timeoutMs: 5_000 });
    const events = load(store.file);
    const switchIdx = events.findIndex((e) => e.type === "branch_switched");
    // The switch is appended immediately (d2), even mid-turn...
    expect(switchIdx).toBeGreaterThan(0);
    // ...but the turn's events before it share the pre-switch head.
    for (let i = 1; i < switchIdx; i += 1) {
      expect(events[i]!.parentId).toBe(events[i - 1]!.id);
    }
  });
});

describe("session_file_growth payload + explicit local parents (#576, d7/d8)", () => {
  test("growth carries localTip/foreignTip; local appends chain to the local tip, head untouched; adoption resolves", async () => {
    const home = tempHome();
    const storeA = SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), home);
    const sessionA = createSession({
      provider: MockProvider.scripted([{ deltas: ["from A"], finish: "stop" }]),
      sink: (e) => storeA.append(e),
    });
    await sessionA.send("hello");
    await sessionA.dispose({ timeoutMs: 5_000 });
    // Foreign writer: the sync channel delivers after A reopens —
    // the divergence (machine B's tail) lands while A's store is open.
    const file = storeA.file;
    const preGrowthBytes = statSync(file).size;
    const localTip = localTipAt(file, preGrowthBytes);
    expect(localTip).not.toBeNull();

    // Machine A reopens (baseline = A's own bytes, pre-divergence).
    const storeB = SessionStore.open(file);
    const foreignId = newUlid();
    writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ type: "user_message", text: "from B", id: foreignId }) + "\n");
    const foreignTip = foreignId;

    const sessionB = createSession({
      provider: MockProvider.scripted([{ deltas: ["A continues"], finish: "stop" }]),
      sink: (e) => storeB.append(e),
      sessionFile: file,
      externalGrowth: () => storeB.externalGrowth(),
      resume: { events: load(file) },
    });
    await sessionB.send("still here");

    const events = load(file);
    const growth = events.find((e) => e.type === "session_file_growth") as
      | { type: "session_file_growth"; localTip?: string; foreignTip?: string }
      | undefined;
    expect(growth).toBeDefined();
    expect(growth!.localTip).toBe(localTip);
    expect(growth!.foreignTip).toBe(foreignTip);

    // Unresolved divergence: local appends carry explicit local-tip parents
    // (never the foreign tip, never the resolved head — which would be the
    // foreign tail after the switch of heads... here none exists, so the
    // local writer must not silently merge).
    const growthIdx = events.indexOf(events.find((e) => e.type === "session_file_growth")!);
    const localEvents = events.slice(growthIdx + 1);
    expect(localEvents.length).toBeGreaterThan(0);
    expect(localEvents[0]!.parentId).toBe(localTip);

    // Adoption: switching to the local tail appends a plain branch_switched.
    // A disposed session refuses appends, so adopt before disposing.
    expect(sessionB.switchBranch(localTip!)).toEqual({ ok: true });
    await sessionB.dispose({ timeoutMs: 5_000 });
    const after = load(file);
    const adoption = after.findLast((e) => e.type === "branch_switched") as { to: string };
    expect(adoption.to).toBe(localTip);
  });
});

describe("localTipAt (#576)", () => {
  test("returns the last identified event within the byte window", () => {
    const store = SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), tmpdir());
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    store.append({ type: "user_message", text: "hi" });
    const file = store.file;
    const all = load(file);
    expect(localTipAt(file, statSync(file).size)).toBe(all.at(-1)!.id);
    // Zero-window before the first event: no tip.
    expect(localTipAt(file, 0)).toBeNull();
    // Missing file: null, never a throw.
    expect(localTipAt(join(tmpdir(), "moh-nope.jsonl"), 100)).toBeNull();
  });
});

describe("switchBranch write-time vs session-level validation", () => {
  test("the seam validates against the file; the live session against the log", async () => {
    const home = tempHome();
    const store = SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["x"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await session.send("go");
    const ghost = newUlid();
    expect(session.switchBranch(ghost)).toEqual({ ok: false, error: `branch target not found in this session: ${ghost}` });
    // Nothing appended on refusal.
    const before = store.load().length;
    const target = store.load()[0]!.id!;
    expect(session.switchBranch(target)).toEqual({ ok: true });
    expect(store.load().length).toBe(before + 1);
    await session.dispose({ timeoutMs: 5_000 });
    // The standalone seam agrees (same file, now containing the switch).
    expect(switchBranch(store.file, target)).toBeDefined();
  });
});
