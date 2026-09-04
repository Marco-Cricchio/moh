/**
 * `moh sessions` (#477): session management subcommands. First cut: the
 * rename command — `moh sessions rename <file|id> <name>` appends the
 * `session_renamed` chrome event via the core's `renameSession` (empty
 * name = reset to the derived title). No flags on `moh run`.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { listSessionSummaries, renameSession } from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const SESSIONS_USAGE = `usage: moh sessions rename <file|id> <name> [--cwd <dir>]

Renames a session: the display name shows in the TUI home picker and
overrides the derived first-message title. An empty name resets to the
derived title. Display names never touch file names or slugs.

  file|id   the session JSONL path, or a session id from \`moh run --list\`
  name      the new display name (empty string resets)
  --cwd     project root the session belongs to (default: process.cwd())`;

/** Resolves a session file from a raw path or a session id within the project. */
function resolveSessionFile(ref: string, cwd: string, home?: string): string | null {
  // A filesystem path (absolute or relative) wins when the file exists.
  const asPath = resolve(ref);
  try {
    const summaries = listSessionSummaries(cwd, home);
    const byPath = summaries.find((s) => s.file === asPath);
    if (byPath) return byPath.file;
    const byId = summaries.find((s) => s.id === ref);
    if (byId) return byId.file;
  } catch {
    // fall through to the null return
  }
  return null;
}

export async function sessionsCommand({
  argv,
  home,
  err,
}: {
  argv: string[];
  home?: string;
  err: { write(s: string): void };
}): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    err.write(SESSIONS_USAGE + "\n");
    return sub ? 0 : 2;
  }
  if (sub !== "rename") {
    err.write(`moh sessions: unknown command "${sub}"\n\n${SESSIONS_USAGE}\n`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs(rest, { strings: ["cwd"], booleans: [] });
  } catch (e) {
    if (e instanceof ArgError) {
      err.write(`moh sessions rename: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const positional = parsed.positionals;
  if (positional.length < 1) {
    err.write("moh sessions rename: <file|id> is required\n");
    return 2;
  }
  // The name may be quoted-empty ("") = reset; join the rest so names with
  // spaces work unquoted too.
  const name = positional.slice(1).join(" ");
  const cwd = parsed.strings["cwd"] ? resolve(parsed.strings["cwd"]) : process.cwd();
  const file = resolveSessionFile(positional[0], cwd, home ?? homedir());
  if (!file) {
    err.write(`moh sessions rename: no session "${positional[0]}" found for this project\n`);
    return 2;
  }
  try {
    renameSession(file, name);
  } catch (e) {
    err.write(`moh sessions rename: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  process.stdout.write(name ? `renamed: ${file} → ${name}\n` : `renamed (reset): ${file}\n`);
  return 0;
}
