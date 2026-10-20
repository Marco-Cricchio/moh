/**
 * One bounded JSONL diagnostic log (#1426, S3.4): read tolerantly, let the
 * caller update the entries, cap, write atomically. Shared by the
 * provider-test trace and the context-refusal trace; each keeps its own
 * file name, entry shape, key and cap. The redact miss report stays apart
 * on purpose (it stops reading at a torn line, keeps raw objects and has no
 * read-side cap).
 *
 * Throws when the write fails: a diagnostic caller catches, so the log never
 * blocks what it records.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic, tempPidSuffix } from "./fs-atomic";

interface BoundedLogOptions<T> {
  /** Entries kept: the last `max` on read, and the cap on write. */
  max: number;
  /** Turns one parsed line into an entry; `undefined` drops the line. */
  validate: (parsed: unknown) => T | undefined;
  /** Returns the entries to keep from the ones read (append, merge in place). */
  update: (entries: T[]) => T[];
  /**
   * Past the cap: omitted keeps the last `max` in order; `"recency"` keeps
   * the `max` newest by `last` (descending) and only past the cap.
   */
  evict?: "recency";
}

function readEntries<T>(file: string, max: number, validate: (parsed: unknown) => T | undefined): T[] {
  if (!existsSync(file)) return [];
  try {
    const entries: T[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = validate(JSON.parse(trimmed));
        if (entry !== undefined) entries.push(entry);
      } catch {
        // A torn or hand-edited line is skipped, never fatal: this file is
        // a diagnostic, and losing one line cannot lose a turn.
      }
    }
    return entries.slice(-max);
  } catch {
    return [];
  }
}

export function boundedLog<T>(file: string, options: BoundedLogOptions<T>): void {
  const { max, validate, update, evict } = options;
  const entries = update(readEntries(file, max, validate));
  const kept = evict === "recency"
    ? entries.length > max
      ? [...entries].sort((a, b) => {
        const left = (a as { last: string }).last;
        const right = (b as { last: string }).last;
        return left < right ? 1 : left > right ? -1 : 0;
      }).slice(0, max)
      : entries
    : entries.slice(-max);
  const body = kept.map((entry) => JSON.stringify(entry)).join("\n");
  writeFileAtomic(file, body ? `${body}\n` : "", { mode: 0o600, mkdir: { mode: 0o700 }, temp: tempPidSuffix });
}
