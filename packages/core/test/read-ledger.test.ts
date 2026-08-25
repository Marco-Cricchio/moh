import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/index";
import type { ToolContext } from "../src/types";

const ctx = (cwd: string, turn = 1): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  onProgress: () => {},
  turn,
});

describe("read ledger — turn-scoped exploration economy (#196)", () => {
  test("an exact repeat read of an unchanged file returns a nudge, not the content again", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-read-ledger-"));
    writeFileSync(join(cwd, "a.ts"), "one\ntwo\nthree\n");
    const tools = builtinTools();
    const first = await tools.read!.execute({ path: "a.ts" }, ctx(cwd));
    expect(first).toContain("one");
    const second = await tools.read!.execute({ path: "a.ts" }, ctx(cwd));
    expect(second).toContain("earlier in this turn");
    expect(second).not.toContain("one\ntwo");
  });

  test("a new turn serves the file again (ledger is turn-scoped, not session-scoped)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-read-ledger-"));
    writeFileSync(join(cwd, "a.ts"), "one\ntwo\n");
    const tools = builtinTools();
    await tools.read!.execute({ path: "a.ts" }, ctx(cwd, 1));
    const nextTurn = await tools.read!.execute({ path: "a.ts" }, ctx(cwd, 2));
    expect(nextTurn).toContain("one");
  });

  test("a modified file is served again in full", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-read-ledger-"));
    writeFileSync(join(cwd, "a.ts"), "one\n");
    const tools = builtinTools();
    await tools.read!.execute({ path: "a.ts" }, ctx(cwd));
    writeFileSync(join(cwd, "a.ts"), "changed\n");
    const again = await tools.read!.execute({ path: "a.ts" }, ctx(cwd));
    expect(again).toContain("changed");
  });

  test("an mtime-only touch (same content) still nudges", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-read-ledger-"));
    writeFileSync(join(cwd, "a.ts"), "stable\n");
    const tools = builtinTools();
    await tools.read!.execute({ path: "a.ts" }, ctx(cwd));
    const later = new Date(Date.now() + 2000);
    utimesSync(join(cwd, "a.ts"), later, later);
    const again = await tools.read!.execute({ path: "a.ts" }, ctx(cwd));
    expect(again).toContain("already read");
  });

  test("a range already covered by an earlier read nudges; a new range is served", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-read-ledger-"));
    writeFileSync(join(cwd, "a.ts"), Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n"));
    const tools = builtinTools();
    await tools.read!.execute({ path: "a.ts", offset: 1, limit: 50 }, ctx(cwd));
    const covered = await tools.read!.execute({ path: "a.ts", offset: 10, limit: 10 }, ctx(cwd));
    expect(covered).toContain("already read");
    const fresh = await tools.read!.execute({ path: "a.ts", offset: 60, limit: 5 }, ctx(cwd));
    expect(fresh).toContain("line-60");
  });

  test("a truncated read is not counted: a narrower re-read is served without a nudge", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-read-ledger-"));
    const big = Array.from({ length: 20_000 }, (_, i) => `line-${i + 1} ${"x".repeat(10)}`).join("\n");
    writeFileSync(join(cwd, "big.ts"), big);
    const tools = builtinTools();
    const full = await tools.read!.execute({ path: "big.ts" }, ctx(cwd));
    expect(full).toContain("[truncated]");
    const narrow = await tools.read!.execute({ path: "big.ts", offset: 1, limit: 5 }, ctx(cwd));
    expect(narrow).toContain("line-1");
    expect(narrow).not.toContain("already read");
  });

  test("ledger state is per session (separate builtinTools() instances serve independently)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-read-ledger-"));
    writeFileSync(join(cwd, "a.ts"), "content\n");
    await builtinTools().read!.execute({ path: "a.ts" }, ctx(cwd));
    const other = await builtinTools().read!.execute({ path: "a.ts" }, ctx(cwd));
    expect(other).toContain("content");
  });
});
