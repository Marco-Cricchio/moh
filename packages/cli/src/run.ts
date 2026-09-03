/**
 * `moh run` (#31): non-interactive end-to-end session. Never prompts:
 * permission decisions come from `--allow`/`--deny` flags over moh.json
 * defaults, and unpermitted tool calls fail fast as structured denials.
 * Every event streams to stdout as one JSON line and lands in the
 * session JSONL log. Assembly goes through the core's single path
 * (`sessionFromConfig`, ADR-0005): this is a thin headless caller.
 */
import { resolve as pathResolve, join } from "node:path";
import { homedir } from "node:os";
import {
  MockProvider,
  RuleError,
  SessionStore,
  createGistHandoffTransport,
  HandoffRunner,
  enrichHandoffWithWayfinder,
  listSessionSummaries,
  loadMohConfig,
  overridesFromFlags,
  publishHandoffAtExit,
  sessionFromConfig,
  resolveTracker,
  transportActive,
  type AgentEvent,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const RUN_USAGE = `usage: moh run [options] [prompt...]

Runs one non-interactive turn. Events stream to stdout as JSON lines and
are persisted to the session JSONL log (~/.moh/projects/<slug>/<id>.jsonl).

options:
  -p, --prompt <text>        the prompt (alternative to the positional form)
  --allow <rule>             grant a permission rule (repeatable)
  --deny <rule>              deny a permission rule (repeatable)
  --session <file>           resume an existing session JSONL (append)
  --resume [query]           resume a session of this project by discovery (#401):
                            a query filters and the best match is opened; with no
                            query the sessions are listed (newest first) to pick
                            from (a query may be a session id or title text)
  --fork                     with --session: copy history into a new session file
  --provider <ref>           "mock", a custom id, or endpoint/model-id (moh.json)
  --cassette <file>          run the mock provider from a JSON cassette (e2e/evals)
  --auto-accept              auto-accept every permission prompt
  --yolo                     no permission prompts, unrestricted filesystem (launch-only)
  --cwd <dir>                project root (default: process.cwd())

rules: "bash", "bash:git status", "write:src/**", "edit:docs/**" — same
grammar as moh.json permissions.overrides; CLI flags win on top of them.

notes:
  - exit code 0 means the turn completed (denied tools are structured
    denial events the model sees, not failures); 1 = turn error, 130 =
    cancelled, 2 = usage error.
  - resuming with --session does not carry --allow/--deny rules forward:
    re-pass them on every run (runtime "always" rules from the log are
    restored automatically).`;

export interface RunOptions {
  argv: string[];
  cwd?: string;
  /** Isolated home for tests; defaults to the real user home. */
  home?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Case-insensitive containment match over id and title, best first (#401). */
function matchSessions(
  sessions: ReturnType<typeof listSessionSummaries>,
  query: string,
): { summary: (typeof sessions)[number]; score: number }[] {
  const q = query.toLowerCase();
  return sessions
    .map((summary) => {
      const id = summary.id.toLowerCase();
      const title = summary.title.toLowerCase();
      // Score: exact id > id prefix > title start > title containment.
      let score = 0;
      if (id === q) score = 4;
      else if (id.startsWith(q)) score = 3;
      else if (title.startsWith(q)) score = 2;
      else if (title.includes(q)) score = 1;
      return { summary, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.summary.mtimeMs - a.summary.mtimeMs);
}

export async function runCommand(options: RunOptions): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  // #401: `--resume` may be followed by its query as a positional, so it
  // cannot use the plain string-flag form. Scan the raw argv: a value that
  // is not a known flag is the query; `--resume <flag>` / `--resume=`
  // mean resume-with-listing.
  let resumeQuery: string | undefined;
  let sawResume = false;
  const argv: string[] = [];
  for (let i = 0; i < options.argv.length; i += 1) {
    const a = options.argv[i]!;
    if (a === "--resume" || a.startsWith("--resume=")) {
      sawResume = true;
      resumeQuery = a.startsWith("--resume=")
        ? a.slice("--resume=".length)
        : undefined;
      const next = options.argv[i + 1];
      if (
        resumeQuery === undefined &&
        next !== undefined &&
        !next.startsWith("-") &&
        next !== ""
      ) {
        resumeQuery = next;
        i += 1;
      }
      continue;
    }
    // -p is the only short flag; normalize before parsing.
    argv.push(a === "-p" ? "--prompt" : a);
  }
  if (resumeQuery === "") resumeQuery = undefined; // `--resume=`: list mode
  let parsed;
  try {
    parsed = parseArgs(argv, {
      strings: ["prompt", "session", "provider", "cassette", "cwd"],
      lists: ["allow", "deny"],
      booleans: ["auto-accept", "fork", "yolo"],
    });
  } catch (e) {
    err.write(e instanceof ArgError ? `moh run: ${e.message}\n` : String(e));
    return 2;
  }
  const positionalPrompt = parsed.positionals.join(" ").trim();
  if (resumeQuery !== undefined && positionalPrompt) {
    err.write(
      "moh run: --resume <query> cannot be combined with a positional prompt (use --prompt)\n",
    );
    return 2;
  }
  const prompt = parsed.strings["prompt"] ?? positionalPrompt;
  let resumeFile: string | undefined;
  const cwd = pathResolve(
    parsed.strings["cwd"] ?? options.cwd ?? process.cwd(),
  );

  // #401: exclusive resume forms fail fast, before any discovery/output.
  if (sawResume && parsed.strings["session"]) {
    err.write("moh run: --session and --resume are mutually exclusive\n");
    return 2;
  }
  // `--fork` is only meaningful with an explicit `--session`; forking a
  // discovered session would surprise: reject instead of silently ignoring.
  if (sawResume && parsed.booleans["fork"]) {
    err.write(
      "moh run: --fork applies to --session <file>; to fork a discovered session, list with --resume and pass its file to --session --fork\n",
    );
    return 2;
  }

  // #401 headless session discovery. `--resume` reuses the core's listing
  // (same seam as the TUI home): with a query it filters and opens the
  // best match; with no query it lists and exits (a prompt may still be
  // given via --prompt, which then runs against the latest session — the
  // bare `moh run --resume` listing is the no-prompt discovery form).
  if (sawResume) {
    const sessions = listSessionSummaries(cwd, options.home ?? homedir());
    if (resumeQuery === undefined) {
      if (prompt) {
        // `--resume --prompt ...`: the latest session continues; listing
        // is not wanted.
        const latest = sessions[0];
        if (!latest) {
          err.write(
            "moh run: --resume: no previous session for this project; starting fresh is the default (omit --resume)\n",
          );
          return 1;
        }
        resumeFile = latest.file;
      } else {
        if (sessions.length === 0) {
          err.write("moh run: no previous session for this project\n");
          return 1;
        }
        for (const s of sessions) out.write(`${s.id}  ${s.title}\n`);
        return 0;
      }
    } else {
      const scored = matchSessions(sessions, resumeQuery);
      if (scored.length === 0) {
        err.write(`moh run: --resume: no session matches "${resumeQuery}"\n`);
        if (sessions.length > 0) {
          err.write("sessions of this project (newest first):\n");
          for (const s of sessions) err.write(`  ${s.id}  ${s.title}\n`);
        }
        return 1;
      }
      if (prompt) {
        resumeFile = scored[0]!.summary.file;
      } else {
        // Best match shown, nothing to run: the user asked for discovery.
        const s = scored[0]!.summary;
        out.write(`${s.id}  ${s.title}\n`);
        if (scored.length > 1) {
          out.write(
            `(${scored.length - 1} more match${scored.length > 2 ? "es" : ""}; refine the query to disambiguate)\n`,
          );
        }
        return 0;
      }
    }
  }
  if (!prompt) {
    err.write("moh run: no prompt given (positional or --prompt)\n");
    return 2;
  }

  let cliOverrides;
  try {
    cliOverrides = overridesFromFlags(
      parsed.lists["allow"] ?? [],
      parsed.lists["deny"] ?? [],
    );
  } catch (e) {
    err.write(
      `moh run: ${e instanceof RuleError || e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }

  let cassetteProvider;
  try {
    if (parsed.strings["cassette"])
      cassetteProvider = MockProvider.cassette(
        pathResolve(cwd, parsed.strings["cassette"]),
      );
  } catch (e) {
    err.write(`moh run: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  let resumeStore: SessionStore | undefined;
  try {
    if (parsed.strings["session"]) {
      let existing = SessionStore.open(
        pathResolve(cwd, parsed.strings["session"]),
      );
      if (parsed.booleans["fork"]) existing = existing.fork();
      resumeStore = existing;
    } else if (resumeFile) {
      resumeStore = SessionStore.open(resumeFile);
    }
  } catch (e) {
    err.write(`moh run: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  // Single assembly path (#100): the builder owns moh.json reading, the
  // MCP merge, provider resolution and session wiring. Headless: no
  // consent seams — project MCP servers and "ask" calls fail fast.
  const assembled = sessionFromConfig({
    cwd,
    ...(cassetteProvider ? { provider: cassetteProvider } : {}),
    ...(parsed.strings["provider"]
      ? { providerRef: parsed.strings["provider"] }
      : {}),
    overrides: {
      permissionFlags: cliOverrides,
      permissions: {
        mode: parsed.booleans["auto-accept"] ? "auto-accept" : "normal",
        unrestrictedTools: parsed.booleans["yolo"] || undefined,
      },
      sink: (event: AgentEvent) => {
        // #400 single-writer guard: the file grew from elsewhere between
        // appends — the JSON stream carries the event, and the human gets
        // one stderr line (stdout stays pure JSONL).
        if (event.type === "session_file_growth") {
          err.write(
            `moh run: warning: session file grew from elsewhere (${event.expectedBytes} → ${event.actualBytes} bytes); concurrent use of one session file is unsupported — fork the session to recover\n`,
          );
        }
        out.write(JSON.stringify(event) + "\n");
      },
      // A fresh store is created by the builder (after config/provider
      // validation, so a broken config leaves no orphan session file).
      ...(resumeStore ? { store: resumeStore } : {}),
      // #437: a successful agent-run `git push` publishes the most recent
      // crash-safe artifact without delaying or changing the bash result.
      onGitPush: () => {
        try {
          if (!transportActive(loadMohConfig(pathResolve(cwd, "moh.json")).handoff)) return;
          setTimeout(() => {
            void publishHandoffAtExit({
              artifactFile: HandoffRunner.artifactFile(cwd, join(options.home ?? homedir(), ".moh")),
              transport: createGistHandoffTransport({ cwd, home: options.home }),
            }).then((published) => {
              if (!published.ok) err.write(`moh run: warning: handoff publish failed (${published.error.reason}) — handoff kept local only\n`);
            });
          }, 0).unref?.();
        } catch {
          // Client transport wiring must never affect the tool call.
        }
      },
    },
  });
  if ("error" in assembled) {
    err.write(`moh run: ${assembled.error.message}\n`);
    return 2;
  }
  const session = assembled.session;

  const onSignal = () => {
    session.abort();
  };
  process.on("SIGINT", onSignal);
  let result;
  try {
    result = await session.send(prompt);
  } finally {
    process.off("SIGINT", onSignal);
    await session.dispose();
  }
  // Session handoff exit publish (#433, T2 #435): when moh.json sets
  // handoff.transport to "gist", publish the raw artifact (#434) through
  // the gist transport. Fail-silent with one stderr warning (stdout
  // stays pure JSONL); the artifact always stays local (story 15).
  try {
    const handoffOn = loadMohConfig(pathResolve(cwd, "moh.json")).handoff?.transport === "gist";
    if (handoffOn) {
      const published = await publishHandoffAtExit({
        artifactFile: HandoffRunner.artifactFile(cwd, join(options.home ?? homedir(), ".moh")),
        transport: createGistHandoffTransport({ cwd, home: options.home }),
        enrich: async (payload) => enrichHandoffWithWayfinder(payload, await resolveTracker({ cwd })),
      });
      if (!published.ok) err.write(`moh run: warning: handoff publish failed (${published.error.reason}) — handoff kept local only\n`);
    }
  } catch {
    // Transport wiring must never fail the run.
  }
  if (result.status === "error") {
    err.write(`moh run: turn failed (${result.reason}): ${result.message}\n`);
    return 1;
  }
  if (result.status === "cancelled") return 130;
  return 0;
}
