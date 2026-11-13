/**
 * Content-based memory lock (#399): the lock file records owner
 * identity (pid + machine id); staleness is decided from that
 * content, not mtime. A dead or foreign owner is
 * reclaimed without a spurious timeout; a live owner still enforces
 * exclusivity. Tests observe acquire/timeout/reclaim through memory
 * writes and the lock file's recorded content.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
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
    const identity = ownIdentity();
    expect(identity.pid).toBe(process.pid);
    expect(identity.machineId).toBe(machineId());
    expect(typeof identity.boot).toBe("number");
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
    plantLock(s, JSON.stringify({ ...identity, pid: deadPid, createdAt: Date.now() }));
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

  test("an earlier live holder remains exclusive for a later process with larger legacy uptime", async () => {
    const dir = tmpDir("two-processes");
    const lock = join(dir, ".lock");
    const modulePath = join(import.meta.dir, "../src/memory-lock.ts");
    const holderCode = `
      import { createLockFile, ownIdentity, setLockIdentityForTests } from ${JSON.stringify(modulePath)};
      import { uptime } from "node:os";
      setLockIdentityForTests(undefined, Math.ceil(uptime()));
      if (!createLockFile(process.argv[1])) process.exit(2);
      console.log(JSON.stringify(ownIdentity()));
      await new Response(Bun.stdin.stream()).text();
    `;
    const holder = Bun.spawn([process.execPath, "-e", holderCode, lock], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = holder.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      const owner = JSON.parse(new TextDecoder().decode(ready.value));
      const deadline = Date.now() + 3000;
      while (Math.ceil(uptime()) <= owner.boot && Date.now() < deadline) await Bun.sleep(10);
      expect(Math.ceil(uptime())).toBeGreaterThan(owner.boot);
      const contenderCode = `
        import { createLockFile, ownerIsGone, parseLockOwner, readLockFile, ownIdentity, setLockIdentityForTests } from ${JSON.stringify(modulePath)};
        import { uptime } from "node:os";
        setLockIdentityForTests(undefined, Math.ceil(uptime()));
        const owner = parseLockOwner(readLockFile(process.argv[1]));
        console.log(JSON.stringify({ boot: ownIdentity().boot, gone: ownerIsGone(owner), acquired: createLockFile(process.argv[1]) }));
      `;
      const contender = Bun.spawn([process.execPath, "-e", contenderCode, lock], { stdout: "pipe", stderr: "pipe" });
      const result = JSON.parse(await new Response(contender.stdout).text());
      expect(await contender.exited).toBe(0);
      expect(result.boot).toBeGreaterThan(owner.boot);
      expect(result.gone).toBe(false);
      expect(result.acquired).toBe(false);
      expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(holder.pid);
    } finally {
      holder.kill();
      await holder.exited;
    }
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

import { spawnSync } from "node:child_process";
import { ownerIsGone } from "../src/memory-lock";

describe("ownerIsGone (characterization, #1437)", () => {
  const owner = (over: Partial<Parameters<typeof ownerIsGone>[0]> = {}) => ({
    v: 1 as const,
    pid: LIVE_OTHER_PID,
    machineId: "machine-a",
    boot: 7,
    createdAt: 0,
    ...over,
  });

  test("a live pid on the same machine and boot is not gone", () => {
    setLockIdentityForTests("machine-a", 7);
    expect(ownerIsGone(owner())).toBe(false);
  });

  test("a foreign machine is always reclaimable", () => {
    setLockIdentityForTests("machine-a", 7);
    expect(ownerIsGone(owner({ machineId: "machine-b" }))).toBe(true);
  });

  test("smaller legacy uptime never makes a live same-machine pid reclaimable", () => {
    setLockIdentityForTests("machine-a", 7);
    expect(ownerIsGone(owner({ boot: 6 }))).toBe(false);
  });

  test("a dead pid on the same machine and boot is gone", () => {
    setLockIdentityForTests("machine-a", 7);
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(ownerIsGone(owner({ pid: dead! }))).toBe(true);
  });
});
