/**
 * Atomic file replacement: write a temp file, then `renameSync` it over the
 * target, so a reader sees the old or the new content, never a partial one.
 *
 * Every call site declares its own temp-file strategy (`temp`), file mode and
 * directory creation, because they differ on purpose (D6, #1386). The helper
 * is synchronous, never cleans up a temp file and never catches: a failed
 * write or rename leaves the temp behind and propagates to the caller.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface WriteFileAtomicOptions {
  /** Temp path for `file`. Required: no site shares a default name. */
  temp: (file: string) => string;
  /**
   * A number is the file mode; "preserve" keeps the target's current mode
   * (0o600 when it does not exist); omitted passes no mode (umask decides).
   */
  mode?: number | "preserve";
  /** Present: `mkdirSync(dirname(file), { recursive: true })`, with `mode` when given. */
  mkdir?: { mode?: number };
  /** Write the temp with `flag: "wx"` (fails when it already exists). */
  exclusive?: boolean;
}

/** `<file>.tmp-<pid>` */
export const tempPidSuffix = (file: string): string => `${file}.tmp-${process.pid}`;
/** `<file>.<pid>.tmp` */
export const tempPidInfix = (file: string): string => `${file}.${process.pid}.tmp`;
/** `<file>.<pid>.<uuid>.tmp` */
export const tempPidUuid = (file: string): string => `${file}.${process.pid}.${randomUUID()}.tmp`;

export function writeFileAtomic(file: string, data: string, options: WriteFileAtomicOptions): void {
  if (options.mkdir) {
    mkdirSync(dirname(file), {
      recursive: true,
      ...(options.mkdir.mode !== undefined ? { mode: options.mkdir.mode } : {}),
    });
  }
  let mode = options.mode;
  if (mode === "preserve") {
    mode = 0o600;
    try { mode = statSync(file).mode & 0o777; } catch { /* new file */ }
  }
  const tmp = options.temp(file);
  if (options.exclusive) writeFileSync(tmp, data, { flag: "wx", mode });
  else if (mode === undefined) writeFileSync(tmp, data);
  else writeFileSync(tmp, data, { mode });
  renameSync(tmp, file);
}
