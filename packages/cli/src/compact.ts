/**
 * `moh compact` (#466): forced context compaction of a closed session
 * file. Opens the JSONL for appending, runs the same CompactionRunner
 * the auto trigger and the TUI `/compact` use, and closes the file —
 * no turn, no `session_resumed` (compacting never consumes; ADR-0022).
 *
 * The heavy lifting is the core's single assembly path
 * (`sessionFromConfig`, ADR-0005): this is a thin headless caller.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { sessionFromConfig, SessionStore, listSessionSummaries } from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const COMPACT_USAGE = `usage: moh compact [--session <file>] [--cwd <dir>]

Compacts a session's context in place: appends a compaction marker
(a summary of the older turns plus a pointer), keeping the last 10
turns verbatim. The log is append-only — nothing is ever deleted.

  --session <file>   the session JSONL to compact
                     (default: the project's most recent session)
  --cwd <dir>        project root the session belongs to
                     (default: process.cwd())

Compacting never consumes a session: it can still be suggested and
resumed as usual afterwards.`;

export async function compactCommand({
  argv,
  home,
  err,
}: {
  argv: string[];
  home?: string;
  err: { write(s: string): void };
}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv, { strings: ["session", "cwd"], booleans: [] });
  } catch (e) {
    if (e instanceof ArgError) {
      err.write(`moh compact: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const cwd = parsed.strings["cwd"] ? resolve(parsed.strings["cwd"]) : process.cwd();

  // Explicit `--session` wins; without it, the project's most recent
  // session (same discovery `moh run --resume` uses).
  let sessionFile = parsed.strings["session"];
  if (!sessionFile) {
    const recent = listSessionSummaries(cwd, home).find((s) => s.title !== "(unreadable session)");
    if (!recent) {
      err.write("moh compact: --session <file> is required (no session found for this project)\n");
      return 2;
    }
    sessionFile = recent.file;
  }

  let store: SessionStore;
  try {
    store = SessionStore.open(resolve(sessionFile));
  } catch (e) {
    err.write(`moh compact: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  // Single assembly path; headless fail-fast consent (no seams needed —
  // compaction itself makes no tool calls).
  const assembled = sessionFromConfig({
    cwd,
    ...(home ? { home } : {}),
    overrides: { store, resumeConsume: false },
  });
  if ("error" in assembled) {
    err.write(`moh compact: cannot open session (${assembled.error.kind}): ${assembled.error.message}\n`);
    return 2;
  }
  try {
    const result = await assembled.session.compact();
    if (!result.ok) {
      err.write(`moh compact: ${result.error}\n`);
      return 1;
    }
    process.stdout.write(
      `compacted: summary appended (upTo ${result.upTo}); ${result.tailTurns} turns kept verbatim (~${result.tokensAfter} of ~${result.tokensBefore} input tokens) — ${store.file}\n`,
    );
    return 0;
  } finally {
    await assembled.session.dispose().catch(() => {});
  }
}
