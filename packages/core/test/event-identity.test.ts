/**
 * #575: end-to-end event identity — a real (mock-provider) session
 * appends only identity-stamped events to the file; the parent chain is
 * linear on still-linear sessions; legacy linear logs replay unchanged.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createSession, MockProvider } from "../src/index";
import { SessionStore, replayMessages } from "../src/session-store";
import { isUlid } from "../src/session/ulid";
import type { AgentEvent, Message } from "../src/types";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "moh-identity-"));
}

describe("event identity end-to-end (#575)", () => {
  test("every persisted event carries a ULID id; the parent chain follows the head", async () => {
    const home = tempHome();
    const store = SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["hello"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await session.send("hi");
    const events = store.load();
    expect(events.length).toBeGreaterThan(2);
    for (const event of events) {
      expect(event.id, `${event.type} has an id`).toBeDefined();
      expect(isUlid(event.id!)).toBe(true);
    }
    // Linear session: each event's parent is the previous event's id.
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.parentId, `event ${i} (${events[i]!.type})`).toBe(events[i - 1]!.id);
    }
    // No per-writer counters, no positional identity: ids are unique.
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    await session.dispose();
  });

  test("a legacy linear log (no ids) replays unchanged and reads as the degenerate tree", () => {
    const legacy: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "v" },
      { type: "user_message", text: "hi" },
      { type: "assistant_delta", text: "hello" },
      { type: "done" },
    ];
    const messages = replayMessages(legacy);
    expect(messages.map((m) => ({ role: m.role, text: m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") }))).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
  });

  test("old readers degrade linearly: a v2 log replays through identity-blind projection", () => {
    // Same log as above but with stamped identity — an old reader that
    // ignores unknown fields replays the exact same conversation.
    const stamped: AgentEvent[] = [
      { type: "session_start", schemaVersion: 2, promptVersion: "v", id: "01ABCDEFGHJKMNPQRSTVWXYZ000" },
      { type: "user_message", text: "hi", id: "01ABCDEFGHJKMNPQRSTVWXYZ001", parentId: "01ABCDEFGHJKMNPQRSTVWXYZ000" },
      { type: "assistant_delta", text: "hello", id: "01ABCDEFGHJKMNPQRSTVWXYZ002", parentId: "01ABCDEFGHJKMNPQRSTVWXYZ001" },
      { type: "done", id: "01ABCDEFGHJKMNPQRSTVWXYZ003", parentId: "01ABCDEFGHJKMNPQRSTVWXYZ002" },
    ];
    expect(replayMessages(stamped).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("resume re-appends session_start chained onto the loaded log's head", async () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    const first = createSession({
      provider: MockProvider.scripted([{ deltas: ["one"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await first.send("hello");
    await first.dispose();

    const resumeEvents = store.load();
    const second = createSession({
      provider: MockProvider.scripted([{ deltas: ["two"], finish: "stop" }]),
      resume: { events: resumeEvents },
      sink: (e) => store.append(e),
    });
    await second.send("again");
    const all = store.load();
    // The turn's first new event chains onto the pre-resume head.
    expect(all.length).toBeGreaterThan(resumeEvents.length);
    expect(all[resumeEvents.length]!.parentId).toBe(all[resumeEvents.length - 1]!.id);
    await second.dispose();
  });
});
