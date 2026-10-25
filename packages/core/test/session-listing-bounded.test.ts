import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  describe("persisted summary index (ADR-0082)", () => {
    const indexOf = (file: string) => join(dirname(file), ".summary-index.json");

    test("cold listing writes an owner-only index; a warm listing serves it and equals the oracle", () => {
      const { cwd, home } = fixture();
      const cold = listSessionSummaries(cwd, home);
      const idx = indexOf(cold[0]!.file);
      expect(existsSync(idx)).toBe(true);
      expect(statSync(idx).mode & 0o777).toBe(0o600);
      // Tamper one entry whose key still matches: a warm listing must serve the index, not the log.
      const raw = JSON.parse(readFileSync(idx, "utf8"));
      const name = Object.keys(raw.entries)[0]!;
      raw.entries[name].title = "from-index";
      raw.entries[name].displayName = null;
      writeFileSync(idx, JSON.stringify(raw));
      const warm = listSessionSummaries(cwd, home);
      expect(warm.find((r) => r.file.endsWith(name))!.title).toBe("from-index");
      for (const row of warm) {
        if (row.file.endsWith(name)) continue;
        const ref = reference(row.file);
        expect({ title: row.title, pinned: row.pinned, consumed: row.consumed }).toEqual({ title: ref.title, pinned: ref.pinned, consumed: ref.consumed });
      }
    });

    test("missing, corrupt and foreign-version indexes rebuild to the oracle", () => {
      const { cwd, home } = fixture();
      const idx = indexOf(listSessionSummaries(cwd, home)[0]!.file);
      for (const bad of ["{not json", JSON.stringify({ version: 99, entries: {} }), JSON.stringify({ version: 1, entries: { x: 1 } }), null]) {
        if (bad === null) rmSync(idx);
        else writeFileSync(idx, bad);
        for (const row of listSessionSummaries(cwd, home)) {
          expect(row.title).toBe(reference(row.file).title);
        }
        expect(JSON.parse(readFileSync(idx, "utf8")).version).toBe(1);
      }
    });

    test("an appended file is re-peeked; a deleted file's entry is dropped", () => {
      const { cwd, home } = fixture();
      const rows = listSessionSummaries(cwd, home);
      const idx = indexOf(rows[0]!.file);
      const target = rows.find((r) => r.title === "resumed")!;
      writeFileSync(target.file, readFileSync(target.file, "utf8") + j({ type: "user_message", text: "again" }) + "\n");
      expect(listSessionSummaries(cwd, home).find((r) => r.file === target.file)!.consumed).toBe(false);
      rmSync(target.file);
      listSessionSummaries(cwd, home);
      expect(Object.keys(JSON.parse(readFileSync(idx, "utf8")).entries)).not.toContain(target.file.split("/").pop());
    });
  });
});
