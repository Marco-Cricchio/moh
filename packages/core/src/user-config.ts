/**
 * Guardian for `~/.moh/config` (issue #102 / ADR-0006): the single owner of
 * the user config file's identity and format invariants. Every read and
 * every write in the codebase goes through this module.
 *
 * - `userConfigFile(home)` is the one path constant; nothing else may
 *   hand-spell `.moh/config`.
 * - Writes are **preservation-mandatory**: `updateUserConfigFile` always
 *   does read-modify-write of the whole JSON object, so unrelated keys and
 *   unknown sections survive every write. No caller serializes the file
 *   itself.
 * - Writes are atomic within the process's reach: temp file + rename.
 *
 * Section schemas live with their domains (`mcpServers` in `mcp.ts`, TUI
 * chrome in the TUI); the guardian is agnostic about sections it does not
 * know and tolerant of unknown ones.
 */
import { chmodSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic, tempPidSuffix } from "./fs-atomic";

/** The whole file, as JSON: known sections plus unknown ones, verbatim. */
export type UserConfigData = Record<string, unknown>;

/** `~/.moh/config` (or `<home>/.moh/config` when home is injected). */
export function userConfigFile(home?: string): string {
  return join(home ?? homedir(), ".moh", "config");
}

/**
 * Reads the file as a JSON object. Missing, empty or corrupt files read as
 * `{}` — user chrome never hard-fails a session.
 */
export function readUserConfigFile(
  file: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): UserConfigData {
  let raw: string;
  try {
    raw = read(file);
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as UserConfigData) : {};
  } catch {
    return {};
  }
}

/**
 * Read-modify-write of the whole file through the guardian. `mutate`
 * receives the current content (unknown sections included) and may change
 * it in place; unrelated keys it does not touch survive. The write is
 * temp-file + rename, so a reader never sees a half-written file.
 */
export function updateUserConfigFile(
  file: string,
  mutate: (data: UserConfigData) => void,
): void {
  const data = readUserConfigFile(file);
  mutate(data);
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
    mkdir: { mode: 0o700 },
    temp: tempPidSuffix,
  });
  // Key-bearing file hygiene (issue #129): 0600 whenever the path is real.
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort: the file may have been removed since the write
  }
}
