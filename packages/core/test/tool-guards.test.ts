import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boundedTest, compileSearchRegex, openGuardedWriteFd, statIdentity, writeGuarded } from "../src/tool-guards.js";

describe("compileSearchRegex (#1262 ReDoS)", () => {
  test("compiles a normal pattern", () => {
    expect(compileSearchRegex("foo.*bar").test("xx fooyy bar")).toBe(true);
  });

  test("rejects an over-long pattern", () => {
    expect(() => compileSearchRegex("a".repeat(1_001))).toThrow(/pattern too long/);
    expect(() => compileSearchRegex("a".repeat(1_000))).not.toThrow();
  });

  test("names an invalid pattern instead of leaking a raw RegExp error", () => {
    expect(() => compileSearchRegex("a(")).toThrow(/invalid regex pattern/);
  });
});

describe("boundedTest (#1262 ReDoS)", () => {
  test("matches a line within the subject cap", () => {
    expect(boundedTest(compileSearchRegex("needle"), "a needle here")).toBe(true);
  });

  test("truncates the subject, bounding backtracking on a catastrophic pattern", () => {
    const evil = compileSearchRegex("(a+)+$");
    const line = "a".repeat(200_000) + "b";
    const start = performance.now();
    boundedTest(evil, line);
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("an end-anchored match past the subject cap is not found", () => {
    expect(boundedTest(compileSearchRegex("tail$"), "x".repeat(8_192) + "tail")).toBe(false);
    expect(boundedTest(compileSearchRegex("tail$"), "tail")).toBe(true);
  });
});

describe("guarded write fd (#1262 TOCTOU)", () => {
  const dir = mkdtempSync(join(tmpdir(), "moh-tool-guards-"));
  const target = join(dir, "file.txt");
  const other = join(dir, "other.txt");

  test("creates a new file exclusively when it did not exist at check time", () => {
    writeGuarded(target, null, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(() => writeGuarded(join(dir, "another.txt"), null, "x")).not.toThrow();
    const appeared = join(dir, "appeared.txt");
    writeFileSync(appeared, "raced");
    expect(() => writeGuarded(appeared, null, "clobber")).toThrow();
    expect(readFileSync(appeared, "utf8")).toBe("raced");
  });

  test("overwrites the file whose identity was checked", () => {
    const prior = statIdentity(target)!;
    writeGuarded(target, prior, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  test("refuses a rename swap between check and open", () => {
    writeFileSync(other, "other");
    const prior = statIdentity(target)!;
    const swapped = statIdentity(other)!;
    expect(() => writeGuarded(target, swapped, "x")).toThrow();
    expect(() => writeGuarded(target, prior, "third")).not.toThrow();
    expect(readFileSync(target, "utf8")).toBe("third");
  });

  test("refuses a symlink at the target path (O_NOFOLLOW)", () => {
    const outside = join(tmpdir(), "moh-tool-guards-outside.txt");
    writeFileSync(outside, "outside");
    const link = join(dir, "link.txt");
    symlinkSync(outside, link);
    expect(() => writeGuarded(link, null, "escape")).toThrow();
    expect(() => writeGuarded(link, statIdentity(link), "escape")).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("outside");
    rmSync(link);
  });

  test("openGuardedWriteFd closes the fd when the identity check fails", () => {
    const before = statIdentity(target)!;
    try {
      openGuardedWriteFd(target, { dev: before.dev + 1, ino: before.ino });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/changed between the containment check and the write/);
    }
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
