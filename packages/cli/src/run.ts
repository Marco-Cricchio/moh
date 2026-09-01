/**
 * `moh run` (#31): non-interactive end-to-end session. Never prompts:
 * permission decisions come from `--allow`/`--deny` flags over moh.json
 * defaults, and unpermitted tool calls fail fast as structured denials.
 * Every event streams to stdout as one JSON line and lands in the
 * session JSONL log. Assembly goes through the core's single path
 * (`sessionFromConfig`, ADR-0005): this is a thin headless caller.
 */
import { resolve as pathResolve } from "node:path";
import {
  MockProvider,
  RuleError,
  SessionStore,
  overridesFromFlags,
  sessionFromConfig,
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
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export async function runCommand(options: RunOptions): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  // -p is the only short flag; normalize before parsing.
  const argv = options.argv.map((a) => (a === "-p" ? "--prompt" : a));
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
  const prompt = parsed.strings["prompt"] ?? parsed.positionals.join(" ").trim();
  if (!prompt) {
    err.write("moh run: no prompt given (positional or --prompt)\n");
    return 2;
  }
  const cwd = pathResolve(parsed.strings["cwd"] ?? options.cwd ?? process.cwd());

  let cliOverrides;
  try {
    cliOverrides = overridesFromFlags(parsed.lists["allow"] ?? [], parsed.lists["deny"] ?? []);
  } catch (e) {
    err.write(`moh run: ${e instanceof RuleError || e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  let cassetteProvider;
  try {
    if (parsed.strings["cassette"])
      cassetteProvider = MockProvider.cassette(pathResolve(cwd, parsed.strings["cassette"]));
  } catch (e) {
    err.write(`moh run: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  let resumeStore: SessionStore | undefined;
  try {
    if (parsed.strings["session"]) {
      let existing = SessionStore.open(pathResolve(cwd, parsed.strings["session"]));
      if (parsed.booleans["fork"]) existing = existing.fork();
      resumeStore = existing;
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
    ...(parsed.strings["provider"] ? { providerRef: parsed.strings["provider"] } : {}),
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
  if (result.status === "error") {
    err.write(`moh run: turn failed (${result.reason}): ${result.message}\n`);
    return 1;
  }
  if (result.status === "cancelled") return 130;
  return 0;
}
