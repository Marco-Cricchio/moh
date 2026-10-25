import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, activePath, hasRecentSession, listSessionSummaries, listSessionSummariesAsync } from "../src/session-store";
import type { AgentEvent } from "../src/index";

/** Reference: the pre-#1710 full-parse projection, kept verbatim as the oracle. */
function reference(file: string) {
  const events: AgentEvent[] = [];
  let title: string | null = null;
  let displayName: string | null = null;
  let pinned = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let event: AgentEvent;
    try {
      event = JSON.parse(line) as AgentEvent;
    } catch {
      break;
    }
    if (event.type === "user_message" && title === null) {
      const text = event.text.replace(/\s+/g, " ").trim();
      title = text.length > 60 ? text.slice(0, 57) + "…" : text || "(empty session)";
    }
    if (event.type === "session_renamed") displayName = event.name === "" ? null : event.name;
    if (event.type === "session_pinned") pinned = event.pinned;
    events.push(event);
  }
  const path = activePath(events);
  let lastTurn = -1;
  let lastResumed = -1;
  path.forEach((e, i) => {
    if (e.type === "user_message" || e.type === "done" || e.type === "error" || e.type === "cancelled") lastTurn = i;
    if (e.type === "session_resumed") lastResumed = i;
  });
  const derived = title ?? "(empty session)";
  return { title: displayName ?? derived, derivedTitle: derived, pinned, consumed: lastResumed > lastTurn };
}

const j = (e: object) => JSON.stringify(e);
const blob = "x".repeat(200_000);

function fixture(): { cwd: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "moh-list-"));
  const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
  const mk = (lines: string[]) => {
    const s = SessionStore.create(cwd, home);
    writeFileSync(s.file, lines.join("\n") + "\n");
    return s.file;
  };
  // many bulky plain sessions (multi-MB each)
  for (let i = 0; i < 6; i++) {
    const lines = [j({ type: "session_start", id: "a0" })];
    for (let k = 0; k < 20; k++) lines.push(j({ type: "user_message", text: `hello ${i} ${blob}`, id: `u${k}`, parentId: k === 0 ? "a0" : `d${k - 1}` }), j({ type: "done", id: `d${k}`, parentId: `u${k}` }));
    mk(lines);
  }
  mk([j({ type: "user_message", text: "  renamed\n one " }), j({ type: "session_renamed", name: "Name" }), j({ type: "session_pinned", pinned: true })]);
  mk([j({ type: "user_message", text: "r" }), j({ type: "session_renamed", name: "Name" }), j({ type: "session_renamed", name: "" })]);
  mk([j({ type: "user_message", text: "resumed" }), j({ type: "done" }), j({ type: "session_resumed" })]);
  mk([j({ type: "user_message", text: "resumed then worked" }), j({ type: "session_resumed" }), j({ type: "user_message", text: "more" })]);
  mk([j({ type: "user_message", text: "corrupt" }), "{bad json", j({ type: "session_resumed" })]);
  mk([j({ type: "user_message", text: "tail" }), j({ type: "session_resumed" })]);
  // branch abandonment (#577): turn on an abandoned branch does not consume the head
  mk([
    j({ type: "session_start", id: "r" }),
    j({ type: "user_message", text: "root", id: "u1", parentId: "r" }),
    j({ type: "done", id: "d1", parentId: "u1" }),
    j({ type: "session_resumed", id: "s1", parentId: "d1" }),
    j({ type: "user_message", text: "abandoned", id: "u2", parentId: "d1" }),
    j({ type: "branch_switched", to: "s1", id: "b1", parentId: "u2" }),
  ]);
  mk([]);
  return { cwd, home };
}

describe("bounded session listing (#1710)", () => {
  test("equals the full-parse reference projection (sync, async, memoized)", async () => {
    const { cwd, home } = fixture();
    const check = (rows: ReturnType<typeof listSessionSummaries>) => {
      expect(rows.length).toBe(14);
      for (const row of rows) {
        const ref = reference(row.file);
        expect({ title: row.title, derivedTitle: row.derivedTitle, pinned: row.pinned, consumed: row.consumed }).toEqual(ref);
      }
    };
    check(listSessionSummaries(cwd, home));
    check(await listSessionSummariesAsync(cwd, home, 0));
    check(listSessionSummaries(cwd, home)); // memo hit
    const rows = listSessionSummaries(cwd, home);
    expect(rows.some((r) => r.consumed)).toBe(true);
    expect(rows.some((r) => !r.consumed)).toBe(true);
  });

  test("memo invalidates when a file changes", () => {
    const { cwd, home } = fixture();
    const before = listSessionSummaries(cwd, home);
    const target = before.find((r) => r.title === "resumed")!;
    expect(target.consumed).toBe(true);
    writeFileSync(target.file, readFileSync(target.file, "utf8") + j({ type: "user_message", text: "again" }) + "\n");
    expect(listSessionSummaries(cwd, home).find((r) => r.file === target.file)!.consumed).toBe(false);
  });

  test("hasRecentSession reads mtimes only", () => {
    const { cwd, home } = fixture();
    expect(hasRecentSession(cwd, home)).toBe(true);
    const old = new Date(Date.now() - 3600_000);
    for (const r of listSessionSummaries(cwd, home)) utimesSync(r.file, old, old);
    expect(hasRecentSession(cwd, home)).toBe(false);
    expect(hasRecentSession(mkdtempSync(join(tmpdir(), "moh-none-")), home)).toBe(false);
  });
});
