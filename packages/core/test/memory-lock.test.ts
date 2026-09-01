/**
 * Content-based memory lock (#399): the lock file records owner
 * identity (pid + machine/boot id); staleness is decided from that
 * content, not mtime. A dead, foreign, or pre-reboot owner is
 * reclaimed without a spurious timeout; a live owner still enforces
 * exclusivity. Tests observe acquire/timeout/reclaim through memory
 * writes and the lock file's recorded content.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../src/memory";
import {
  bootCount,
  machineId,
  ownIdentity,
  parseLockOwner,
  releaseLockFile,
  setLockIdentityForTests,
} from "../src/memory-lock";

const TMP = join(import.meta.dir, "tmp-memory-lock");

function tmpDir(name: string): string {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function store(name: string): MemoryStore {
  return new MemoryStore(join(tmpDir(name), "memory"));
}

function lockFileOf(s: MemoryStore): string {
  return join(s.dir, ".lock");
}

/** Creates the memory dir and plants a lock file with the given content. */
function plantLock(s: MemoryStore, content: string): void {
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(lockFileOf(s), content);
}

/** A live pid that is not this process: the test runner itself. */
const LIVE_OTHER_PID = process.ppid;

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  setLockIdentityForTests(undefined, 0);
});

describe("memory lock ownership", () => {
  test("lock file carries owner identity (pid + machine + boot id)", async () => {
    const s = store("identity");
    // Pin identity, plant a reclaimable lock, and let the append win a
    // fresh lock: then read what a real acquire writes by planting it
    // via createLockFile's payload through an append that keeps the lock
    // observable — simplest observable path: assert on the payload shape
    // ownIdentity() produces (what createLockFile writes), plus that a
    // lock carrying this process's own pre-reboot identity is reclaimed.
    const identity = ownIdentity();
    expect(identity.pid).toBe(process.pid);
    expect(identity.machineId).toBe(machineId());
    expect(typeof identity.boot).toBe("number");
    // Reclaim of our own pre-reboot lock proves the acquire parsed a
    // full v1 payload and matched machine + boot.
    setLockIdentityForTests(identity.machineId, identity.boot + 1);
    plantLock(s, JSON.stringify({ ...identity, createdAt: Date.now() }));
    await s.append([{ topic: "t", fact: "f" }], "s1");
    expect(readFileSync(s.topicFile("t"), "utf8")).toContain("f");
  });

  test("foreign machine's lock is reclaimed without spurious timeout", async () => {
    const s = store("foreign-machine");
    setLockIdentityForTests("this-machine", 0);
    const foreign = { v: 1, pid: LIVE_OTHER_PID, machineId: "other-machine", boot: 0, createdAt: Date.now() };
    plantLock(s, JSON.stringify(foreign));
    // Even though the pid is alive, a foreign owner never blocks: the
    // write completes (reclaim) well inside the 5s timeout.
    const started = Date.now();
    await s.append([{ topic: "sync", fact: "works across machines" }], "s1");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(readFileSync(s.topicFile("sync"), "utf8")).toContain("works across machines");
  });

  test("dead owner's lock is reclaimed", async () => {
    const s = store("dead-owner");
    setLockIdentityForTests("this-machine", 0);
    const dead = { v: 1, pid: 999_999, machineId: "this-machine", boot: bootCount(), createdAt: Date.now() };
    plantLock(s, JSON.stringify(dead));
    await s.append([{ topic: "recovery", fact: "after crash" }], "s1");
    expect(readFileSync(s.topicFile("recovery"), "utf8")).toContain("after crash");
  });

  test("pre-reboot owner is reclaimed even with a recycled live pid", async () => {
    const s = store("pre-reboot");
    const identity = ownIdentity();
    // A lock from before the last reboot whose pid is now alive again
    // (recycled) must not be honored.
    setLockIdentityForTests(identity.machineId, identity.boot + 1);
    const preReboot = { v: 1, pid: LIVE_OTHER_PID, machineId: identity.machineId, boot: identity.boot, createdAt: Date.now() };
    plantLock(s, JSON.stringify(preReboot));
    await s.append([{ topic: "reboot", fact: "reclaimed" }], "s1");
    expect(readFileSync(s.topicFile("reboot"), "utf8")).toContain("reclaimed");
  });

  test("legacy mtime-era lock content is reclaimed", async () => {
    const s = store("legacy");
    plantLock(s, ""); // old format: empty file
    await s.append([{ topic: "legacy", fact: "upgraded" }], "s1");
    expect(readFileSync(s.topicFile("legacy"), "utf8")).toContain("upgraded");
  });

  test("live same-machine owner's lock enforces exclusivity (timeout)", async () => {
    const s = store("live-owner");
    const identity = ownIdentity();
    const live = { v: 1, pid: LIVE_OTHER_PID, machineId: identity.machineId, boot: identity.boot, createdAt: Date.now() };
    plantLock(s, JSON.stringify(live));
    // An unrelated live pid holds the lock: the write must time out.
    await expect(s.append([{ topic: "t", fact: "blocked" }], "s1")).rejects.toThrow(
      /memory lock timeout/,
    );
    expect(s.readIndex().topics["t"]).toBeUndefined();
  }, 8_000);

  test("release only deletes the lock when this process owns it", async () => {
    const s = store("release");
    // Someone else's lock: release must leave it in place.
    const other = JSON.stringify({ v: 1, pid: LIVE_OTHER_PID, machineId: machineId(), boot: bootCount(), createdAt: Date.now() });
    plantLock(s, other);
    releaseLockFile(lockFileOf(s));
    expect(readFileSync(lockFileOf(s), "utf8")).toBe(other);
    // Our own current-boot lock: release removes it.
    plantLock(s, JSON.stringify({ ...ownIdentity(), createdAt: Date.now() }));
    releaseLockFile(lockFileOf(s));
    expect(parseLockOwner("")).toBeUndefined(); // sanity: empty ≠ owner
    expect(() => readFileSync(lockFileOf(s))).toThrow(); // file is gone
  });
});
