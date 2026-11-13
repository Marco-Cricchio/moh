/**
 * Content-based memory lock ownership (#399): a lock file records who
 * holds it (pid + machine identifier; legacy boot metadata), and staleness is decided
 * from that content rather than filesystem mtime — a lock left by a
 * crashed process or another machine never blocks memory writes, while
 * a live same-machine owner still enforces exclusivity.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

/** Lock file payload; `v` gates forward-compatible parsing. */
interface LockOwner {
  v: 1;
  pid: number;
  machineId: string;
  /** Legacy v1 metadata; never evidence that a live PID is stale. */
  boot: number;
  createdAt: number;
}

let cachedMachineId: string | undefined;
let cachedBootCount: number | undefined;

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

/** Legacy v1 payload field. Uptime is not a boot identity: two live
 * processes can observe different values. New locks use zero; old numeric
 * values remain readable but never authorize reclaiming a live owner. */
export function bootCount(): number {
  return cachedBootCount ?? 0;
}

/** Test seam: pin the machine identity and boot count observed by the lock. */
export function setLockIdentityForTests(id: string | undefined, boot?: number): void {
  cachedMachineId = id;
  if (boot !== undefined) cachedBootCount = boot;
}

/** `kill(pid, 0)` liveness probe; false for dead/recycled-away pids. */
function isProcessAlive(pid: number): boolean {
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
      return {
        v: 1,
        pid: parsed.pid,
        machineId: parsed.machineId,
        boot: typeof parsed.boot === "number" ? parsed.boot : 0,
        createdAt: parsed.createdAt ?? 0,
      };
    }
  } catch {
    // not JSON: treated as malformed below
  }
  return undefined;
}

/** The identity this process writes into a lock file it creates. */
export function ownIdentity(): Omit<LockOwner, "createdAt"> {
  return { v: 1, pid: process.pid, machineId: machineId(), boot: bootCount() };
}

/** True when the recorded owner can no longer be holding the lock. */
export function ownerIsGone(owner: LockOwner): boolean {
  // Foreign machine in a shared home: liveness is unverifiable and the
  // acceptance contract (#399) says a foreign owner never blocks — reclaim.
  if (owner.machineId !== machineId()) return true;
  // Same machine: only a confirmed dead PID permits reclamation. A live
  // recycled PID can conservatively block a legacy lock; uptime cannot
  // distinguish it from a legitimate holder started earlier this boot.
  return !isProcessAlive(owner.pid);
}

/**
 * Creates the lock file exclusively and writes the owner payload.
 * Returns false when another process won the race (file exists).
 */
export function createLockFile(path: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ ...ownIdentity(), createdAt: Date.now() }));
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

/**
 * Removes the lock only when it still records this process as owner —
 * a reclaim winner must not delete a newer holder's lock file.
 */
export function releaseLockFile(path: string): void {
  try {
    const owner = parseLockOwner(readLockFile(path));
    if (owner && owner.pid === process.pid && owner.machineId === machineId() && owner.boot === bootCount()) {
      unlinkSync(path);
    }
  } catch {
    // unreadable or gone: nothing to do
  }
}
