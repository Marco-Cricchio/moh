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
import { bundledExtensionSources } from "@moh/tui/bundled-extensions";

export const COMPACT_USAGE = `usage: moh compact [--session <file>] [--cwd <dir>]

Compacts a session's context in place: appends a compaction marker
(a summary of the older turns plus a pointer), keeping a contiguous
verbatim tail — the last turn whole while it fits the model's window,
the turns before it while they stay under ~25% of it. The log is
append-only — nothing is ever deleted.

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
    // #826: the bundled first-party extensions this client ships.
    bundledExtensions: bundledExtensionSources(home, { consentSeamAvailable: false }),
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
      // #949: name the exits when the producer refused structurally —
      // a new turn makes older work foldable; a larger window raises
      // the ceiling.
      err.write(
        "hint: a new turn makes older work foldable; a model with a larger window raises the ceiling (moh run --model)\n",
      );
      return 1;
    }
    // #949: the tail in tokens, not an ambiguous turn count; say when
    // the tail begins inside the oldest kept turn (partial).
    process.stdout.write(
      `compacted: summary appended (upToId ${result.upToId ?? result.upTo}); tail kept verbatim: ~${result.tokensAfter} of ~${result.tokensBefore} input tokens${result.partial ? " (starts inside the oldest kept turn)" : ""} — ${store.file}\n`,
    );
    return 0;
  } finally {
    await assembled.session.dispose().catch(() => {});
  }
}
