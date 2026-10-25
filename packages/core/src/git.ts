/**
 * The one `git` runner (#1427): every core call site spawns git through
 * here, keeping its own sync/async shape (C12, ADR-0024), its own stdio and
 * its own way of passing the directory. Nothing is trimmed and nothing is
 * caught except in the two origin probes.
 */

import { appendFileSync } from "node:fs";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface GitOptions {
  /** "-C": argv `git -C <cwd> …args`, no spawn cwd (a missing dir is a
   *  nonzero exit). "cwd": argv `git …args` with the spawn option `cwd`
   *  (a missing dir makes the spawn throw). */
  dir: "-C" | "cwd";
  /** "ignore" → `GitResult.stderr` is "". */
  stderr: "pipe" | "ignore";
  /** Forwarded to the spawn only when set; otherwise Bun's default. */
  stdin?: "ignore";
  /** Forwarded (with SIGKILL) only when set: the child is killed after this
   *  many ms and the call returns a null exit code. */
  timeoutMs?: number;
}

function spawnArgs(cwd: string | undefined, args: readonly string[], options: GitOptions) {
  const cmd = options.dir === "-C" ? ["git", "-C", cwd!, ...args] : ["git", ...args];
  const spawn = {
    ...(options.dir === "cwd" ? { cwd } : {}),
    stdout: "pipe" as const,
    stderr: options.stderr,
    ...(options.stdin ? { stdin: options.stdin } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs, killSignal: "SIGKILL" as const } : {}),
  };
  return { cmd, spawn };
}

/** Bun.spawnSync, no try/catch: throws exactly when Bun.spawnSync throws
 * (git missing, a missing `cwd:` dir). */
export function gitSync(cwd: string, args: readonly string[], options: GitOptions): GitResult {
  const { cmd, spawn } = spawnArgs(cwd, args, options);
  const probe = process.env.MOH_GIT_PROBE;
  if (probe) return probedSpawnSync(probe, cwd, args, cmd, spawn, options);
  const proc = Bun.spawnSync(cmd, spawn);
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: options.stderr === "pipe" ? proc.stderr!.toString() : "",
  };
}

/**
 * #1679 diagnostic, off unless `MOH_GIT_PROBE=<file>` is set: the same
 * `Bun.spawnSync` call, timed, with one JSON line appended per call (start,
 * duration, the child's pid, exit code, whether the timeout fired, and the
 * caller's frames when the call took over a second). The question it
 * answers: does a slow call return only after its child is long gone (a
 * `spawnSync` that does not return) or did git itself run that long? The
 * probe never changes the result or throws.
 */
const SLOW_CALL_MS = 1000;
function probedSpawnSync(
  file: string,
  cwd: string,
  args: readonly string[],
  cmd: string[],
  spawn: ReturnType<typeof spawnArgs>["spawn"],
  options: GitOptions,
): GitResult {
  const started = Date.now();
  const t0 = performance.now();
  let proc: ReturnType<typeof Bun.spawnSync> | undefined;
  let threw: unknown;
  try {
    proc = Bun.spawnSync(cmd, spawn);
  } catch (error) {
    threw = error;
  }
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  try {
    const line = {
      at: new Date(started).toISOString(),
      cwd,
      args,
      ms,
      pid: proc?.pid ?? null,
      exitCode: proc?.exitCode ?? null,
      signal: proc?.signalCode ?? null,
      timeoutMs: options.timeoutMs ?? null,
      threw: threw === undefined ? null : String(threw),
      ...(ms >= SLOW_CALL_MS ? { stack: (new Error().stack ?? "").split("\n").slice(2, 12).map((l) => l.trim()) } : {}),
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch {
    // diagnostic only
  }
  if (threw !== undefined || !proc) throw threw;
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout?.toString() ?? "",
    stderr: options.stderr === "pipe" ? proc.stderr?.toString() ?? "" : "",
  };
}

/**
 * Async twin. Deliberately NOT `async`: Bun.spawn runs before any await, so
 * a spawn failure throws synchronously, as Bun.spawn does; stream-read
 * errors reject the returned promise.
 */
export function git(cwd: string, args: readonly string[], options: GitOptions): Promise<GitResult>;
export function git(cwd: string | undefined, args: readonly string[], options: GitOptions & { dir: "cwd" }): Promise<GitResult>;
export function git(cwd: string | undefined, args: readonly string[], options: GitOptions): Promise<GitResult> {
  const { cmd, spawn } = spawnArgs(cwd, args, options);
  const proc = Bun.spawn(cmd, spawn);
  if (options.stderr === "pipe") {
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]).then(([stdout, stderr, exitCode]) => ({ exitCode, stdout, stderr }));
  }
  return Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([stdout, exitCode]) => ({ exitCode, stdout, stderr: "" }));
}

/**
 * Ceiling for the origin probes (#1679). `git remote get-url` answers in
 * ~10 ms; a probe that has not returned after this long is killed and read
 * as "no origin" instead of parking a synchronous `createSession` for 30 s+.
 * The cause of the observed hang is not established (a Bun.spawnSync that
 * never returns, or a git that blocks), so this bounds it rather than fixes it.
 */
const ORIGIN_PROBE_TIMEOUT_MS = 10_000;

/** `git -C <cwd> remote get-url origin`: the trimmed URL, or null on a
 * nonzero exit, a timeout, or a spawn that throws (git missing). */
export function originUrlSync(cwd: string, stderr: "pipe" | "ignore", timeoutMs = ORIGIN_PROBE_TIMEOUT_MS): string | null {
  let res: GitResult;
  try {
    res = gitSync(cwd, ["remote", "get-url", "origin"], { dir: "-C", stderr, timeoutMs });
  } catch {
    return null;
  }
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

/** Async twin of `originUrlSync` (stderr ignored). */
export async function originUrl(cwd: string, timeoutMs = ORIGIN_PROBE_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await git(cwd, ["remote", "get-url", "origin"], { dir: "-C", stderr: "ignore", timeoutMs });
    return res.exitCode === 0 ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}
