/**
 * `moh sessions` (#477, #582): session management subcommands — rename,
 * delete, and the session-tree trio (`tree` renders the topology view as
 * text, `switch` appends a `branch_switched`, `bookmark` appends a
 * `tree_bookmarked`; empty name = clear). All ride the same
 * `resolveSessionFile` seam and the core's file-based writers
 * (`switchBranch`/`bookmarkNode`) and reader (`sessionTree`).
 * No flags on `moh run` — `--resume` reopens at head automatically.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  bookmarkNode,
  deleteSession,
  isSessionOpen,
  listSessionSummaries,
  parseLineRef,
  renameSession,
  resolveEventRef,
  SessionStore,
  sessionTree,
  switchBranch,
  type AgentEvent,
  type TreeView,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const SESSIONS_USAGE = `usage: moh sessions rename <file|id> <name> [--cwd <dir>]
       moh sessions delete <file|id> [--yes] [--cwd <dir>]
       moh sessions tree <file|id> [--cwd <dir>]
       moh sessions switch <file|id> <node|bookmark-name> [--cwd <dir>]
       moh sessions bookmark <file|id> <node> [name] [--cwd <dir>]

Renames a session: the display name shows in the TUI home picker and
overrides the derived first-message title. An empty name resets to the
derived title. Display names never touch file names or slugs.

  file|id   the session JSONL path, or a session id from \`moh run --list\`
  name      the new display name (empty string resets)
  --cwd     project root the session belongs to (default: process.cwd())

delete moves the session's JSONL file into the trash
(~/.moh/trash/projects/<slug>/ — restorable via \`moh trash restore\`; 30-day
retention by default). Refuses when the session is currently open. Without
--yes it asks for confirmation on stdin (y/N, default No).

tree renders the session's tree topology as text: one row per turn or
chrome event, depth-indented, \`●\` on the active path, \`○\` off it,
\`◆ name\` bookmarked, \`← head\` on the current head.

switch moves the head by appending a branch_switched event: the next
turn continues from that node and subsequent appends split into a new
branch. Refuses when the session is currently open — switching under a
live writer belongs to the TUI.

bookmark names a node (a turn or an earlier event) for humans; with an
empty (or blank) name it clears the node's bookmark.

  file|id   the session JSONL path, or a session id from \`moh run --list\`
  name      the new display name (empty string resets)
  node      an event id (ULID), a \`line:N\` bridge, or a bookmark name
  --cwd     project root the session belongs to (default: process.cwd())`;

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
  if (!["rename", "delete", "tree", "switch", "bookmark"].includes(sub)) {
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
  if (sub === "tree") return sessionsTree(file, err);
  if (sub === "switch") {
    if (positional.length < 2) {
      err.write(`moh sessions switch: <node|bookmark-name> is required\n`);
      return 2;
    }
    return sessionsSwitch(file, positional[1]!, err);
  }
  if (sub === "bookmark") {
    if (positional.length < 2) {
      err.write(`moh sessions bookmark: <node> is required\n`);
      return 2;
    }
    // join the rest so names with spaces work unquoted too; "" clears.
    const name = positional.slice(2).join(" ");
    return sessionsBookmark(file, positional[1]!, positional.length > 2 ? name : undefined, err);
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

// ---------------------------------------------------------------------------
// Session tree CLI (#582)
// ---------------------------------------------------------------------------

/** CLI exit code convention: 0 ok, 2 usage/runtime error (err surface). */
const CLI_ERROR = 2;

/** Resolves a node reference to a log event, or null when it dangles. */
function resolveNode(file: string, ref: string): AgentEvent | null {
  let store: ReturnType<typeof SessionStore.open> | null = null;
  try {
    store = SessionStore.open(file);
    return resolveEventRef(ref, store.load());
  } catch {
    return null;
  } finally {
    store?.dispose();
  }
}

/** Collects the node ids whose bookmark name matches (case-sensitive). */
function bookmarkMatches(view: TreeView, name: string): string[] {
  return view.nodes.filter((n) => n.bookmark?.name === name).map((n) => n.id);
}

/** `moh sessions tree` — renders the topology view as text. */
function sessionsTree(file: string, err: { write(s: string): void }): number {
  const view = sessionTree(file);
  if ("error" in view) {
    err.write(`moh sessions tree: ${view.error}\n`);
    return CLI_ERROR;
  }
  process.stdout.write(renderTree(view));
  return 0;
}

/** One text row per node: indent by depth, ●/○ path, ◆ bookmark, ← head. */
export function renderTree(view: TreeView): string {
  const lines = view.nodes.map((n) => {
    const indent = "  ".repeat(n.depth);
    const path = n.onActivePath ? "●" : "○";
    const bookmark = n.bookmark ? ` ◆${n.bookmark.name ? ` ${n.bookmark.name}` : ""}` : "";
    const head = n.id === view.headId ? " ← head" : "";
    return `${indent}${path} ${n.label}${bookmark}${head}`;
  });
  return lines.join("\n") + "\n";
}

/**
 * `moh sessions switch` — appends a `branch_switched` after resolving the
 * target: a ULID, `line:N`, or a bookmark name (ambiguous → error listing
 * matches; unknown → error). Refuses a session currently open in this
 * process — switching under a live writer belongs to the TUI (#400).
 */
function sessionsSwitch(file: string, ref: string, err: { write(s: string): void }): number {
  const target = resolveCliNodeRef(file, ref, err);
  if (target === null) return CLI_ERROR;
  // Spec §5: switching under a live writer belongs to the TUI (which
  // goes through its own session instance) — the CLI refuses an open
  // session, same registry as delete (#478).
  if (isSessionOpen(file)) {
    err.write(
      `moh sessions switch: session is currently open: ${file.replace(/.*\//, "")} — switching under a live writer belongs to the TUI\n`,
    );
    return CLI_ERROR;
  }
  try {
    switchBranch(file, target);
  } catch (e) {
    err.write(`moh sessions switch: ${e instanceof Error ? e.message : String(e)}\n`);
    return CLI_ERROR;
  }
  process.stdout.write(`switched: head → ${target}\n`);
  return 0;
}

/**
 * `moh sessions bookmark` — appends a `tree_bookmarked`. Name omitted =
 * unnamed bookmark; empty/blank name = clear (the core's last-wins
 * reset). Same node-reference grammar as switch.
 */
function sessionsBookmark(
  file: string,
  ref: string,
  name: string | undefined,
  err: { write(s: string): void },
): number {
  const target = resolveCliNodeRef(file, ref, err);
  if (target === null) return CLI_ERROR;
  try {
    bookmarkNode(file, target, name);
  } catch (e) {
    err.write(`moh sessions bookmark: ${e instanceof Error ? e.message : String(e)}\n`);
    return CLI_ERROR;
  }
  if (name !== undefined && name.trim() === "") process.stdout.write(`cleared bookmark on ${target}\n`);
  else process.stdout.write(`bookmarked: ${target}${name ? ` ◆ ${name}` : ""}\n`);
  return 0;
}

/**
 * Resolves the CLI's `node|bookmark-name` argument: a ULID / `line:N`
 * first (the core grammar), else a bookmark name looked up in the tree
 * projection. A resolved `line:N` bridge is canonicalized to the
 * referenced event's ULID when it has one, so bookmarks written by ref
 * stay attached to the turn node in the projection (a `line:N` value in
 * `to` would never match the node's id). Bookmark names that collide
 * with a valid ULID/line ref are unreachable by design (names are human
 * words; the id grammar wins).
 */
function resolveCliNodeRef(file: string, ref: string, err: { write(s: string): void }): string | null {
  if (parseLineRef(ref) !== null) {
    const event = resolveNode(file, ref);
    if (event === null) {
      err.write(`moh sessions: target event not found in session: ${ref}\n`);
      return null;
    }
    return event.id ?? ref;
  }
  const view = sessionTree(file);
  if ("error" in view) {
    err.write(`moh sessions: ${view.error}\n`);
    return null;
  }
  const matches = bookmarkMatches(view, ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    err.write(
      `moh sessions: ambiguous bookmark "${ref}" matches ${matches.length} nodes:\n` +
        matches.map((m) => `  ${m}`).join("\n") +
        `\n`,
    );
    return null;
  }
  // Not a bookmark name: fall through to the raw ref (a ULID) so the
  // core writer's validation reports dangling ids with its own message.
  if (resolveNode(file, ref) === null) {
    err.write(`moh sessions: no node or bookmark "${ref}" in session\n`);
    return null;
  }
  return ref;
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
