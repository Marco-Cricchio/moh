/**
 * `moh sessions` (#477): session management subcommands. First cut: the
 * rename command — `moh sessions rename <file|id> <name>` appends the
 * `session_renamed` chrome event via the core's `renameSession` (empty
 * name = reset to the derived title). No flags on `moh run`.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { deleteSession, listSessionSummaries, renameSession } from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const SESSIONS_USAGE = `usage: moh sessions rename <file|id> <name> [--cwd <dir>]
       moh sessions delete <file|id> [--yes] [--cwd <dir>]

Renames a session: the display name shows in the TUI home picker and
overrides the derived first-message title. An empty name resets to the
derived title. Display names never touch file names or slugs.

  file|id   the session JSONL path, or a session id from \`moh run --list\`
  name      the new display name (empty string resets)
  --cwd     project root the session belongs to (default: process.cwd())

delete moves the session's JSONL file into the trash
(~/.moh/trash/projects/<slug>/ — restorable via \`moh trash restore\`; 30-day
retention by default). Refuses when the session is currently open. Without
--yes it asks for confirmation on stdin (y/N, default No).`;

/** Resolves a session file from a raw path or a session id within the project. */
export function resolveSessionFile(ref: string, cwd: string, home?: string): string | null {
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
  if (sub !== "rename" && sub !== "delete") {
    err.write(`moh sessions: unknown command "${sub}"\n\n${SESSIONS_USAGE}\n`);
    return 2;
  }
  const isDelete = sub === "delete";
  let parsed;
  try {
    parsed = parseArgs(rest, { strings: ["cwd"], booleans: isDelete ? ["yes"] : [] });
  } catch (e) {
    if (e instanceof ArgError) {
      err.write(`moh sessions ${sub}: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const positional = parsed.positionals;
  if (positional.length < 1) {
    err.write(`moh sessions ${sub}: <file|id> is required\n`);
    return 2;
  }
  const cwd = parsed.strings["cwd"] ? resolve(parsed.strings["cwd"]) : process.cwd();
  const effectiveHome = home ?? homedir();
  const file = resolveSessionFile(positional[0], cwd, effectiveHome);
  if (!file) {
    err.write(`moh sessions ${sub}: no session "${positional[0]}" found for this project\n`);
    return 2;
  }
  if (isDelete) {
    // Confirmation (update.ts convention): --yes skips the prompt; the
    // default answer is No.
    if (!parsed.booleans["yes"]) {
      process.stdout.write(`delete ${file}? (y/N) `);
      const answer = await readStdinLine();
      if (answer.trim().toLowerCase() !== "y") {
        process.stdout.write("aborted\n");
        return 0;
      }
    }
    try {
      deleteSession(file, cwd, effectiveHome);
    } catch (e) {
      err.write(`moh sessions delete: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    process.stdout.write(`deleted: ${file} (restorable via \`moh trash restore\`)\n`);
    return 0;
  }
  // The name may be quoted-empty ("") = reset; join the rest so names with
  // spaces work unquoted too.
  const name = positional.slice(1).join(" ");
  try {
    renameSession(file, name);
  } catch (e) {
    err.write(`moh sessions rename: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  process.stdout.write(name ? `renamed: ${file} → ${name}\n` : `renamed (reset): ${file}\n`);
  return 0;
}

/** One line from stdin (confirmation prompt). Empty/closed stdin = No. */
function readStdinLine(): Promise<string> {
  return new Promise((resolvePromise) => {
    let buf = "";
    const onReadable = () => {
      let chunk: string | Buffer;
      while ((chunk = process.stdin.read()) !== null) buf += String(chunk);
      if (buf.includes("\n")) {
        cleanup();
        resolvePromise(buf.slice(0, buf.indexOf("\n")));
      }
    };
    const onEnd = () => {
      cleanup();
      resolvePromise(buf);
    };
    function cleanup() {
      process.stdin.removeListener("readable", onReadable);
      process.stdin.removeListener("end", onEnd);
    }
    process.stdin.on("readable", onReadable);
    process.stdin.on("end", onEnd);
  });
}
