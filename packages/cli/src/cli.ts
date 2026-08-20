#!/usr/bin/env bun
/**
 * moh CLI entry point. Thin client over @moh/core (#31 covers `moh run`;
 * other subcommands land with their own tickets).
 */
import { runCommand, RUN_USAGE } from "./run";

const HELP = `moh — headless coding agent

usage: moh <command> [options]

commands:
  run    non-interactive session (see: moh run --help)
`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(HELP);
    return command ? 0 : 2;
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
