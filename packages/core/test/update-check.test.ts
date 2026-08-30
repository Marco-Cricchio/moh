/**
 * #273 / ADR-0014: the update check (core, mock-testable).
 */
import { describe, expect, test } from "bun:test";
import {
  checkForUpdate,
  compareSemver,
  isDevRun,
  readUpdateCache,
  updateCacheFile,
  updateDue,
  updateNoticeFor,
  writeUpdateCache,
  type UpdateCache,
  type UpdateCheckIo,
} from "../src/update-check";

const HOME = "/tmp/moh-home";

function ioWith(cache: string | null, fetchImpl?: UpdateCheckIo["fetch"], now = 1_000_000): UpdateCheckIo {
  return {
    read: () => cache ?? (() => { throw new Error("missing"); })(),
    write: () => {},
    fetch: fetchImpl,
    now: () => now,
  };
}

describe("compareSemver", () => {
  test("orders loose semver, v-prefix tolerated", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareSemver("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "v1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
  });
});

describe("updateNoticeFor", () => {
  test("newer stable → available", () => {
    expect(updateNoticeFor("0.1.0", "v0.2.0")).toEqual({ kind: "available", latestVersion: "0.2.0" });
  });
  test("running newer than latest stable → nonstable", () => {
    expect(updateNoticeFor("0.3.0", "0.2.0")).toEqual({ kind: "nonstable", latestVersion: "0.2.0" });
  });
  test("no notice when latest <= current equal, missing or malformed", () => {
    expect(updateNoticeFor("0.2.0", "0.2.0")).toBeNull();
    expect(updateNoticeFor("0.2.0", undefined)).toBeNull();
    expect(updateNoticeFor("0.2.0", "not-semver")).toBeNull();
  });
});

describe("readUpdateCache", () => {
  test("parses a well-formed cache", () => {
    const io = ioWith(JSON.stringify({ lastCheckedAt: 5, latestVersion: "0.2.0" }));
    expect(readUpdateCache(HOME, io)).toEqual({ lastCheckedAt: 5, latestVersion: "0.2.0" });
  });
  test("missing or corrupt cache reads as null", () => {
    expect(readUpdateCache(HOME, ioWith(null))).toBeNull();
    expect(readUpdateCache(HOME, ioWith("{nope"))).toBeNull();
    expect(readUpdateCache(HOME, ioWith(JSON.stringify({ latestVersion: "x" })))).toBeNull();
  });
});

describe("updateDue", () => {
  const cache: UpdateCache = { lastCheckedAt: 0, latestVersion: "0.2.0" };
  test("due when never checked or older than 24h", () => {
    expect(updateDue(null)).toBe(true);
    expect(updateDue(cache, 24 * 3600_000)).toBe(true);
  });
  test("not due within 24h", () => {
    expect(updateDue(cache, 24 * 3600_000 - 1)).toBe(false);
  });
});

describe("checkForUpdate", () => {
  test("ok response writes the cache and returns the version", async () => {
    const writes: [string, string][] = [];
    const io: UpdateCheckIo = {
      read: () => { throw new Error("missing"); },
      write: (f, d) => writes.push([f, d]),
      now: () => 12345,
      fetch: (async () => ({ ok: true, json: async () => ({ tag_name: "v0.2.0" }) })) as UpdateCheckIo["fetch"],
    };
    const latest = await checkForUpdate({ mohHome: HOME, io });
    expect(latest).toBe("0.2.0");
    const [file, data] = writes[0]!;
    expect(file).toBe(updateCacheFile(HOME));
    expect(JSON.parse(data)).toEqual({ lastCheckedAt: 12345, latestVersion: "0.2.0" });
  });
  test("network error / bad status / malformed body → null, cache untouched", async () => {
    const bad: UpdateCheckIo["fetch"][] = [
      (async () => { throw new Error("offline"); }) as UpdateCheckIo["fetch"],
      (async () => ({ ok: false, status: 404 })) as never,
      (async () => ({ ok: true, json: async () => "garbage" })) as never,
      (async () => ({ ok: true, json: async () => ({ tag_name: "nope" }) })) as never,
    ];
    for (const fetch of bad) {
      const io: UpdateCheckIo = { read: () => { throw new Error("missing"); }, write: () => { throw new Error("must not write"); }, fetch };
      expect(await checkForUpdate({ mohHome: HOME, io })).toBeNull();
    }
  });
});

describe("isDevRun", () => {
  test("repo checkout is dev, $bunfs is compiled", () => {
    expect(isDevRun("/repo/packages/core/src")).toBe(true);
    expect(isDevRun("/$bunfs/root/pkg/src")).toBe(false);
  });
});

describe("writeUpdateCache (#328)", () => {
  test("writes a fresh cache (same shape checkForUpdate writes)", () => {
    const writes: [string, string][] = [];
    writeUpdateCache(HOME, "0.7.1", { now: () => 777, write: (f, d) => writes.push([f, d]) });
    const [file, data] = writes[0]!;
    expect(file).toBe(updateCacheFile(HOME));
    expect(JSON.parse(data)).toEqual({ lastCheckedAt: 777, latestVersion: "0.7.1" });
  });
  test("write failure is silent", () => {
    expect(() => writeUpdateCache(HOME, "0.7.1", { now: () => 1, write: () => { throw new Error("disk full"); } })).not.toThrow();
  });
});
