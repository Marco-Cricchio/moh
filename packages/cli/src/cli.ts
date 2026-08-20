#!/usr/bin/env bun
/**
 * moh CLI entry point. Thin client over @moh/core (#31 covers `moh run`;
 * other subcommands land with their own tickets).
 */
import { runCommand, RUN_USAGE } from "./run";

const HELP = `moh — headless coding agent

usage: moh [command] [options]

With no command, moh opens the interactive TUI (resume from the home
screen; the mock provider works without credentials).

commands:
  tui    interactive session (same as bare moh)
  run    non-interactive session (see: moh run --help)
`;

/** Bare `moh` / `moh tui`: open the interactive TUI (#32). */
async function tuiCommand(): Promise<number> {
  const { renderTui } = await import("@moh/tui");
  const instance = renderTui({ cwd: process.cwd() });
  await instance.waitUntilExit?.();
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
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
  process.stderr.write(`moh: unknown command "${command}"\n\n${HELP}`);
  return 2;
}

process.exit(await main());
