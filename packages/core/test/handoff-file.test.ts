import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HandoffRunner,
  buildRawHandoff,
  exportHandoffFile,
  importedHandoffFile,
  importHandoffFile,
  readImportedHandoff,
  type AgentEvent,
  type RawHandoff,
} from "@moh/core";

function tmpRoot(): { root: string; cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "moh-handoff-file-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, cwd, home };
}

function fixtureHandoff(sessionId = "session-abc", updatedAt = new Date()): RawHandoff {
  const anchor = { branch: "main", head: "a".repeat(40), dirty: false } as const;
  return {
    ...buildRawHandoff([] as AgentEvent[], sessionId, 3, "/nowhere", updatedAt, anchor),
    files: ["src/a.ts"],
    tests: ["bun test src/a.test.ts"],
  };
}

describe("exportHandoffFile (#440)", () => {
  test("writes the enriched artifact as JSON and returns the path", async () => {
    const { cwd, home } = tmpRoot();
    const artifact = join(home, ".moh", "projects", "project", "handoff.json");
    mkdirSync(join(artifact, ".."), { recursive: true });
    writeFileSync(artifact, JSON.stringify(fixtureHandoff()));
    const out = join(home, "bridge.json");
    const result = await exportHandoffFile({
      cwd,
      home,
      out,
      read: () => fixtureHandoff("session-abc"),
      enrich: async (p) => ({ ...p, turns: 9 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(out);
    const written = JSON.parse(readFileSync(out, "utf8")) as RawHandoff;
    expect(written.kind).toBe("raw");
    expect(written.sessionId).toBe("session-abc");
    expect(written.turns).toBe(9);
  });

  test("fails with no-artifact when nothing local exists", async () => {
    const { cwd, home } = tmpRoot();
    const result = await exportHandoffFile({ cwd, home, out: join(home, "x.json") });
    expect(result).toEqual({ ok: false, error: { reason: "no-artifact" } });
  });
});

describe("importHandoffFile (#440)", () => {
  test("imports a valid export and parks the waypoint", async () => {
    const { cwd, home } = tmpRoot();
    const file = join(home, "bridge.json");
    writeFileSync(file, JSON.stringify(fixtureHandoff()));
    const result = await importHandoffFile({ cwd, home, file });
    expect(result.ok).toBe(true);
    const parked = readImportedHandoff(cwd, home);
    expect(parked?.sessionId).toBe("session-abc");
    expect(importedHandoffFile(cwd, home)).toContain(join(".moh", "projects"));
  });

  test("rejects a corrupt or non-raw file and leaves no waypoint", async () => {
    const { cwd, home } = tmpRoot();
    const file = join(home, "bad.json");
    writeFileSync(file, "not json");
    expect(await importHandoffFile({ cwd, home, file })).toEqual({
      ok: false,
      error: { reason: "invalid" },
    });
    expect(readImportedHandoff(cwd, home)).toBeUndefined();
  });

  test("a missing file reports missing", async () => {
    const { cwd, home } = tmpRoot();
    expect(await importHandoffFile({ cwd, home, file: join(home, "nope.json") })).toEqual({
      ok: false,
      error: { reason: "missing" },
    });
  });

  test("declines a payload authored by another gh user (#451)", async () => {
    const { cwd, home } = tmpRoot();
    const file = join(home, "bridge.json");
    writeFileSync(file, JSON.stringify({ ...fixtureHandoff(), author: "someone-else" }));
    const result = await importHandoffFile({ cwd, home, file, expectedAuthor: "me" });
    expect(result).toEqual({ ok: false, error: { reason: "foreign-author", author: "someone-else" } });
    expect(readImportedHandoff(cwd, home)).toBeUndefined();
  });

  test("accepts a payload authored by the logged-in user, and a v1 payload without author", async () => {
    const { cwd, home } = tmpRoot();
    const file = join(home, "bridge.json");
    writeFileSync(file, JSON.stringify({ ...fixtureHandoff(), author: "me" }));
    expect((await importHandoffFile({ cwd, home, file, expectedAuthor: "me" })).ok).toBe(true);
    const v1 = join(home, "v1.json");
    writeFileSync(v1, JSON.stringify({ ...fixtureHandoff("session-v1"), version: 1 }));
    const result = await importHandoffFile({ cwd, home, file: v1, expectedAuthor: "me" });
    expect(result.ok).toBe(true);
    expect(readImportedHandoff(cwd, home)?.sessionId).toBe("session-v1");
  });
});
