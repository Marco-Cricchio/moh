/**
 * `moh run` (#31): non-interactive end-to-end session. Never prompts:
 * permission decisions come from `--allow`/`--deny` flags over moh.json
 * defaults, and unpermitted tool calls fail fast as structured denials.
 * Every event streams to stdout as one JSON line and lands in the
 * session JSONL log. Works zero-config with the mock provider.
 */
import { resolve as pathResolve } from "node:path";
import {
  MockProvider,
  SessionStore,
  builtinTools,
  createSession,
  declaredMcpServers,
  declaredUserMcpServers,
  loadMohConfig,
  resolveProvider,
  resolveProviderRef,
  defaultRegistry,
  type AgentEvent,
  type PermissionOverrides,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";
import { RuleError, mergeOverrides, overridesFromFlags } from "./permission-flags";

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
  --dangerously-bypass-permissions   skip all permission checks
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
      booleans: ["auto-accept", "fork", "dangerously-bypass-permissions"],
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

  let config, cliOverrides: PermissionOverrides;
  try {
    config = loadMohConfig(pathResolve(cwd, "moh.json"));
    cliOverrides = overridesFromFlags(parsed.lists["allow"] ?? [], parsed.lists["deny"] ?? []);
  } catch (e) {
    err.write(`moh run: ${e instanceof RuleError || e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const overrides = mergeOverrides(config.permissions?.overrides, cliOverrides);

  let provider;
  try {
    if (parsed.strings["cassette"]) provider = MockProvider.cassette(pathResolve(cwd, parsed.strings["cassette"]));
    else if (parsed.strings["provider"]) {
      provider = resolveProviderRef(parsed.strings["provider"], defaultRegistry.freeze(), config.endpoints ?? []);
    } else provider = resolveProvider(config);
  } catch (e) {
    err.write(`moh run: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  let store: SessionStore;
  let resumeEvents: AgentEvent[] | undefined;
  try {
    if (parsed.strings["session"]) {
      let existing = SessionStore.open(pathResolve(cwd, parsed.strings["session"]));
      if (parsed.booleans["fork"]) existing = existing.fork();
      resumeEvents = existing.load();
      store = existing;
    } else {
      store = SessionStore.create(cwd);
    }
  } catch (e) {
    err.write(`moh run: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  // MCP (#15): project (moh.json) + user (~/.moh/config, trusted) servers,
  // started lazily on the first turn. Headless runs never prompt: project
  // servers are consent-denied and logged; user servers start without asking.
  const mcpServers = [...declaredMcpServers(config), ...declaredUserMcpServers()];

  const session = createSession({
    provider,
    tools: builtinTools(),
    cwd,
    ...(mcpServers.length ? { mcp: { servers: mcpServers } } : {}),
    resume: resumeEvents?.length ? { events: resumeEvents } : undefined,
    permissions: {
      overrides,
      mode: parsed.booleans["auto-accept"] ? "auto-accept" : "normal",
      bypassPermissions: parsed.booleans["dangerously-bypass-permissions"] || undefined,
    },
    sink: (event) => {
      store.append(event);
      out.write(JSON.stringify(event) + "\n");
    },
  });

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
