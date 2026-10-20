import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempPidInfix, tempPidSuffix, tempPidUuid, writeFileAtomic } from "../src/fs-atomic";

let previousUmask = 0;
beforeAll(() => {
  previousUmask = process.umask(0o027);
});
afterAll(() => {
  process.umask(previousUmask);
});

const dir = (): string => mkdtempSync(join(tmpdir(), "moh-fs-atomic-"));
const mode = (p: string): number => statSync(p).mode & 0o777;

describe("writeFileAtomic", () => {
  test("the three name generators", () => {
    expect(tempPidSuffix("/a/f")).toBe(`/a/f.tmp-${process.pid}`);
    expect(tempPidInfix("/a/f")).toBe(`/a/f.${process.pid}.tmp`);
    expect(tempPidUuid("/a/f")).toMatch(new RegExp(`^/a/f\\.${process.pid}\\.[0-9a-f-]{36}\\.tmp$`));
    expect(tempPidUuid("/a/f")).not.toBe(tempPidUuid("/a/f"));
  });

  test("a numeric mode is the file mode; the directory gets its own mode", () => {
    const d = join(dir(), "sub");
    writeFileAtomic(join(d, "f"), "x", { mode: 0o600, mkdir: { mode: 0o700 }, temp: tempPidInfix });
    expect(mode(join(d, "f"))).toBe(0o600);
    expect(mode(d)).toBe(0o700);
    expect(readdirSync(d)).toEqual(["f"]);
  });

  test("mkdir without a mode leaves the umask default; no mkdir option creates nothing", () => {
    const base = dir();
    writeFileAtomic(join(base, "a", "f"), "x", { mkdir: {}, temp: tempPidInfix });
    expect(mode(join(base, "a"))).toBe(0o750);
    expect(() => writeFileAtomic(join(base, "b", "f"), "x", { temp: tempPidInfix })).toThrow();
    expect(existsSync(join(base, "b"))).toBe(false);
  });

  test("an omitted mode lets the umask decide", () => {
    const f = join(dir(), "f");
    writeFileAtomic(f, "x", { temp: tempPidInfix });
    expect(mode(f)).toBe(0o640);
  });

  test('"preserve" keeps the existing mode and falls back to 0600', () => {
    const base = dir();
    const f = join(base, "f");
    writeFileAtomic(f, "1", { mode: "preserve", temp: tempPidInfix });
    expect(mode(f)).toBe(0o600);
    chmodSync(f, 0o640);
    writeFileAtomic(f, "2", { mode: "preserve", temp: tempPidInfix });
    expect(mode(f)).toBe(0o640);
    expect(readFileSync(f, "utf8")).toBe("2");
  });

  test("exclusive fails when the temp exists and leaves it and the target alone", () => {
    const base = dir();
    const f = join(base, "f");
    writeFileSync(f, "old");
    writeFileSync(join(base, "taken"), "squat");
    expect(() => writeFileAtomic(f, "new", { mode: 0o600, temp: () => join(base, "taken"), exclusive: true })).toThrow();
    expect(readFileSync(join(base, "taken"), "utf8")).toBe("squat");
    expect(readFileSync(f, "utf8")).toBe("old");
    writeFileAtomic(f, "new", { mode: 0o600, temp: () => join(base, "fresh"), exclusive: true });
    expect(readFileSync(f, "utf8")).toBe("new");
    expect(existsSync(join(base, "fresh"))).toBe(false);
  });

  test("an injected writer replaces the file write; the rename still happens", () => {
    const base = dir();
    const f = join(base, "f");
    const seen: string[] = [];
    writeFileAtomic(f, "d", {
      temp: tempPidSuffix,
      write: (tmp, data) => {
        seen.push(tmp);
        writeFileSync(tmp, data);
      },
    });
    expect(seen).toEqual([`${f}.tmp-${process.pid}`]);
    expect(readFileSync(f, "utf8")).toBe("d");
  });

  test("a failed rename leaves the temp behind and throws", () => {
    const base = dir();
    const f = join(base, "f");
    mkdirSync(f);
    writeFileSync(join(f, "keep"), "x");
    expect(() => writeFileAtomic(f, "d", { temp: tempPidInfix })).toThrow();
    expect(readFileSync(`${f}.${process.pid}.tmp`, "utf8")).toBe("d");
  });
});
