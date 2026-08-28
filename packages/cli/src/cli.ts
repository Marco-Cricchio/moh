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
  tui    interactive session (same as bare moh)
  run    non-interactive session (see: moh run --help)
  mcp    manage MCP tool servers (see: moh mcp --help)
  init   scaffold agent docs (docs/agents/* + AGENTS.md)
  provider manage provider endpoints and auth (see: moh provider --help)
  update  self-update the binary to the latest stable release

options:
  --version  print version and exit
  --help     show this help
`;

/** Bare `moh` / `moh tui`: open the interactive TUI (#32). */
async function tuiCommand(): Promise<number> {
  const { renderTui } = await import("@moh/tui");
  const instance = renderTui({ cwd: process.cwd() });
  await instance.waitUntilExit?.();
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    if (rest.length) {
      process.stderr.write("moh --version takes no arguments\n");
      return 2;
    }
    process.stdout.write(CLI_VERSION + "\n");
    return 0;
  }
  if (!command || command === "help" || command === "--help") {
    if (!command) return tuiCommand();
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "tui") {
    if (rest.length) {
      process.stderr.write(`moh tui takes no arguments\n`);
      return 2;
    }
    return tuiCommand();
  }
  if (command === "run") {
    if (rest.includes("--help") || rest.includes("-h")) {
      process.stdout.write(RUN_USAGE + "\n");
      return 0;
    }
    return runCommand({ argv: rest });
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
