/**
 * Content-based memory lock ownership (#399): a lock file records who
 * holds it (pid + machine/boot identifier), and staleness is decided
 * from that content rather than filesystem mtime — a lock left by a
 * crashed process or another machine never blocks memory writes, while
 * a live same-machine owner still enforces exclusivity.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

/** Lock file payload; `v` gates forward-compatible parsing. */
export interface LockOwner {
  v: 1;
  pid: number;
  machineId: string;
  createdAt: number;
}

let cachedMachineId: string | undefined;

/**
 * Stable per-machine identifier (cached per process). Linux:
 * `/etc/machine-id` (or the dbus copy); macOS: the IOPlatformUUID.
 * Falls back to the hostname — best-effort, like the lock itself.
 */
export function machineId(): string {
  if (cachedMachineId !== undefined) return cachedMachineId;
  let id = "";
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      id = readFileSync(p, "utf8").trim();
      if (id) break;
    } catch {
      // try the next source
    }
  }
  if (!id && process.platform === "darwin") {
    try {
      const out = execFileSync(
        "ioreg",
        ["-rd1", "-c", "IOPlatformExpertDevice"],
        { encoding: "utf8", timeout: 2_000 },
      );
      id = (/IOPlatformUUID\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? "").trim();
    } catch {
      // best-effort: hostname fallback below
    }
  }
  cachedMachineId = id || hostname();
  return cachedMachineId;
}

/** Test seam: pin the machine identity observed by the lock. */
export function setMachineIdForTests(id: string | undefined): void {
  cachedMachineId = id;
}

/** `kill(pid, 0)` liveness probe; false for dead/recycled-away pids. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parses lock content; `undefined` for missing/malformed payloads. */
export function parseLockOwner(raw: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (parsed?.v === 1 && typeof parsed.pid === "number" && typeof parsed.machineId === "string") {
      return { v: 1, pid: parsed.pid, machineId: parsed.machineId, createdAt: parsed.createdAt ?? 0 };
    }
  } catch {
    // not JSON: treated as malformed below
  }
  return undefined;
}

/** True when the recorded owner can no longer be holding the lock. */
export function ownerIsGone(owner: LockOwner, myMachineId: string, isPidAlive = isProcessAlive): boolean {
  // Foreign machine in a shared home: liveness is unverifiable and the
  // acceptance contract (#399) says a foreign owner never blocks — reclaim.
  if (owner.machineId !== myMachineId) return true;
  // Same machine: dead pid (or our own recycled pid) means stale.
  return !isPidAlive(owner.pid) || owner.pid === process.pid;
}

/**
 * Creates the lock file exclusively and writes the owner payload.
 * Returns false when another process won the race (file exists).
 */
export function createLockFile(path: string, myMachineId = machineId()): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      const payload: LockOwner = { v: 1, pid: process.pid, machineId: myMachineId, createdAt: Date.now() };
      writeSync(fd, JSON.stringify(payload));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** Reads raw lock content; empty string when missing/unreadable. */
export function readLockFile(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Removes the lock; a missing file (reclaim race) is fine. */
export function removeLockFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone: nothing to do
  }
}
