#!/usr/bin/env bun
/**
 * moh CLI entry point. Thin client over @moh/core (#31 covers `moh run`;
 * other subcommands land with their own tickets).
 */
import { runCommand, RUN_USAGE } from "./run";
import { mcpCommand, MCP_USAGE } from "./mcp";
import { initCommand } from "./init";
import { providerCommand, PROVIDER_USAGE } from "./provider";
import { updateCommand, UPDATE_USAGE } from "./update";
import { CLI_VERSION } from "./version";

const HELP = `moh — headless coding agent

usage: moh [command] [options]

With no command, moh opens the interactive TUI (resume from the home
screen; the mock provider works without credentials).

commands:
  tui      interactive session (same as bare moh)
  run      non-interactive session (see: moh run --help)
  mcp      manage MCP tool servers (see: moh mcp --help)
  init     scaffold agent docs (docs/agents/* + AGENTS.md)
  provider manage provider endpoints and auth (see: moh provider --help)
  update   self-update the binary to the latest stable release

options:
  --yolo     unrestricted tools: no permission prompts, no filesystem
             containment (launch-only; MCP consent still applies)
  --version  print version and exit
  --help     show this help
`;

/** Bare `moh` / `moh tui`: open the interactive TUI (#32). */
async function tuiCommand(yolo = false): Promise<number> {
  const { renderTui } = await import("@moh/tui");
  const { CLI_VERSION } = await import("./version");
  const instance = renderTui({
    cwd: process.cwd(),
    version: CLI_VERSION,
    ...(yolo ? { yolo } : {}),
  });
  await instance.waitUntilExit?.();
  // #341: exit is deliberate, so it must be bounded — tracked session
  // disposal gets a budget, then the process terminates explicitly.
  // Without this, Bun HTTP keep-alive sockets (provider traffic) hold the
  // event loop for seconds after the UI is gone and the shell prompt only
  // returns when they time out.
  const { finishExit } = await import("@moh/tui");
  return finishExit(2500, 0);
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    if (rest.length) {
      process.stderr.write("moh --version takes no arguments\n");
      return 2;
    }
    process.stdout.write(CLI_VERSION + "\n");
    return 0;
  }
  // #377: the old flag is removed, not aliased — fail loudly.
  if (argv.includes("--dangerously-bypass-permissions")) {
    process.stderr.write(
      "moh: --dangerously-bypass-permissions was removed; use --yolo\n",
    );
    return 2;
  }
  // #377: `moh --yolo` opens the TUI like bare `moh` does — the flag rides
  // on the no-command path instead of being mistaken for a subcommand.
  const yolo = argv.includes("--yolo");
  if (yolo && !["--yolo", "tui", "run", "help", "--help"].includes(command!)) {
    process.stderr.write(
      `moh: --yolo applies to the TUI launch; use "moh --yolo" or "moh tui --yolo"\n`,
    );
    return 2;
  }
  if (!command || command === "--yolo") {
    // `moh --yolo junk` is a usage error, not a silently ignored flag.
    if (argv.some((a, i) => i > 0 && a !== "--yolo")) {
      process.stderr.write(
        `moh: unexpected argument (bare moh opens the TUI; did you mean "moh run …"?)\n`,
      );
      return 2;
    }
    return tuiCommand(yolo);
  }
  if (command === "help" || command === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "tui") {
    if (rest.includes("--yolo")) {
      if (rest.length > 1) {
        process.stderr.write(`moh tui takes no arguments\n`);
        return 2;
      }
      return tuiCommand(true);
    }
    if (rest.length) {
      process.stderr.write(`moh tui takes no arguments\n`);
      return 2;
    }
    return tuiCommand(false);
  }
  if (command === "run") {
    if (rest.includes("--help") || rest.includes("-h")) {
      process.stdout.write(RUN_USAGE + "\n");
      return 0;
    }
    return runCommand({ argv: rest, home: process.env.HOME });
  }
  if (command === "mcp") {
    if (rest.includes("--help") || rest.includes("-h")) {
      process.stdout.write(MCP_USAGE + "\n");
      return 0;
    }
    return mcpCommand({ argv: rest });
  }
  if (command === "init") {
    if (rest.length) {
      process.stderr.write(`moh init takes no arguments\n`);
      return 2;
    }
    initCommand({ cwd: process.cwd() });
    return 0;
  }
  if (command === "provider") {
    if (rest.includes("--help") || rest.includes("-h")) {
      process.stdout.write(PROVIDER_USAGE + "\n");
      return 0;
    }
    return providerCommand({ argv: rest, cwd: process.cwd() });
  }
  if (command === "update") {
    if (rest.includes("--help") || rest.includes("-h")) {
      process.stdout.write(UPDATE_USAGE + "\n");
      return 0;
    }
    return updateCommand({ argv: rest });
  }
  process.stderr.write(`moh: unknown command "${command}"\n\n${HELP}`);
  return 2;
}

/** Runs the CLI and flushes pending output before returning the exit code. */
export async function runCli(): Promise<number> {
  const code = await main();
  // Await pending stdout/stderr flushes before exiting — without this,
  // short-lived runs lose piped output in compiled binaries.
  await new Promise<void>((res) => process.stdout.write("", () => res()));
  await new Promise<void>((res) => process.stderr.write("", () => res()));
  return code;
}

if (import.meta.main) process.exitCode = await runCli();
