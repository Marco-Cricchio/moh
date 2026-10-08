import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** #1262 (ReDoS): the grep tool compiles a model-supplied pattern. JS has
 * no regex timeout, so the bound comes from input caps instead: the
 * pattern's own length, and the subject each test runs against. */
export const MAX_PATTERN_LENGTH = 1_000;
export const MAX_SUBJECT_LENGTH = 8_192;

export function compileSearchRegex(pattern: string): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`regex pattern too long (${pattern.length} chars; max ${MAX_PATTERN_LENGTH})`);
  }
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function boundedTest(re: RegExp, line: string): boolean {
  const subject = line.length > MAX_SUBJECT_LENGTH ? line.slice(0, MAX_SUBJECT_LENGTH) : line;
  return re.test(subject);
}

/** #1262 (TOCTOU): `resolvedInRoot` realpaths the target, but the write
 * happened later, through a fresh open that follows symlinks — a path
 * swapped to an outside symlink between check and use escaped the root.
 * The close: open the fd with `O_NOFOLLOW` and pin it to the identity
 * observed at check time. */
export type FileIdentity = { dev: number; ino: number };

export function statIdentity(path: string): FileIdentity | null {
  try {
    const st = statSync(path);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

/**
 * Opens `abs` for writing under the containment check's observation.
 * `prior` is the identity captured when the path was resolved: non-null
 * for a file that existed (the fd must land on that exact file — a
 * symlink swap fails with ELOOP, a rename swap fails the identity
 * match), null for a planned new file (opened exclusively — a path that
 * appeared meanwhile is refused, never truncated).
 */
export function openGuardedWriteFd(abs: string, prior: FileIdentity | null): number {
  const flags = fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | (prior === null ? fsConstants.O_CREAT | fsConstants.O_EXCL : fsConstants.O_TRUNC);
  const fd = openSync(abs, flags, 0o666);
  try {
    if (prior !== null) {
      const st = fstatSync(fd);
      if (st.dev !== prior.dev || st.ino !== prior.ino) {
        throw new Error(`target changed between the containment check and the write: ${abs}`);
      }
    }
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/** Writes through a guarded fd and always closes it. Returns bytes written. */
export function writeGuarded(abs: string, prior: FileIdentity | null, data: string): number {
  if (prior === null) mkdirSync(dirname(abs), { recursive: true });
  const fd = openGuardedWriteFd(abs, prior);
  try {
    return writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}
