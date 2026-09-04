/**
 * `moh trash` (#478): the session trash — its own concept, not an operation
 * on live sessions. `list` shows trashed sessions with the days left before
 * the lazy prune removes them; `restore <file|id>` moves a file back into
 * its project directory (refusing an id collision — no silent overwrite).
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  listTrashedSessions,
  restoreSession,
  type TrashedSessionSummary,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";
import { resolveSessionFile } from "./sessions";

export const TRASH_USAGE = `usage: moh trash <command> [--cwd <dir>]

The session trash: deleted sessions rest at
~/.moh/trash/projects/<slug>/ for a retention window (default 30 days,
configurable) before the lazy prune removes them.

commands:
  list                  show trashed sessions (id, title, age, days left)
  restore <file|id>     move a trashed session back into its project directory

  --cwd                 project root the session belongs to (default: process.cwd())`;

export async function trashCommand({
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
    err.write(TRASH_USAGE + "\n");
    return sub ? 0 : 2;
  }
  if (sub !== "list" && sub !== "restore") {
    err.write(`moh trash: unknown command "${sub}"\n\n${TRASH_USAGE}\n`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs(rest, { strings: ["cwd"], booleans: [] });
  } catch (e) {
    if (e instanceof ArgError) {
      err.write(`moh trash ${sub}: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const cwd = parsed.strings["cwd"] ? resolve(parsed.strings["cwd"]) : process.cwd();
  const effectiveHome = home ?? homedir();

  if (sub === "list") {
    const entries = listTrashedSessions(cwd, effectiveHome);
    if (entries.length === 0) {
      process.stdout.write("trash is empty\n");
      return 0;
    }
    for (const t of entries) process.stdout.write(renderTrashEntry(t) + "\n");
    return 0;
  }

  // restore
  const ref = parsed.positionals[0];
  if (!ref) {
    err.write("moh trash restore: <file|id> is required\n");
    return 2;
  }
  const entries = listTrashedSessions(cwd, effectiveHome);
  const asPath = resolve(ref);
  const entry =
    entries.find((t) => t.file === asPath) ?? entries.find((t) => t.id === ref);
  if (!entry) {
    err.write(`moh trash restore: no trashed session "${ref}" found for this project\n`);
    return 2;
  }
  try {
    const restored = restoreSession(entry.file, cwd, effectiveHome);
    process.stdout.write(`restored: ${restored}\n`);
  } catch (e) {
    err.write(`moh trash restore: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  return 0;
}

function renderTrashEntry(t: TrashedSessionSummary): string {
  const age = new Date(t.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
  return `${t.id}  ${age} UTC  ${t.daysRemaining}d left  ${t.title}`;
}

export { resolveSessionFile };
