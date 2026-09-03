/**
 * Explicit Session Handoff control (#439). Automatic publication never
 * writes to the tracker; `--notify-ticket` is the sole opt-in write path.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  HandoffRunner,
  createGistHandoffTransport,
  enrichHandoffWithWayfinder,
  loadMohConfig,
  notifyClaimedWayfinderTickets,
  readRawHandoff,
  resolveTracker,
  type HandoffTransport,
  type TrackerBackend,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const HANDOFF_USAGE = `usage: moh handoff [--notify-ticket] [--cwd <dir>]

Publishes the local session handoff when handoff.transport is "gist".

options:
  --notify-ticket  after a successful publish, comment only Wayfinder tickets
                   successfully claimed in this session (never implied)
  --cwd <dir>      project root (default: process.cwd())`;

export interface HandoffCommandOptions {
  argv: string[];
  cwd?: string;
  home?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  transport?: HandoffTransport;
  tracker?: TrackerBackend | null;
}

export async function handoffCommand(options: HandoffCommandOptions): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  let parsed;
  try {
    parsed = parseArgs(options.argv, { booleans: ["notify-ticket"], strings: ["cwd"] });
  } catch (error) {
    err.write(`moh handoff: ${error instanceof ArgError ? error.message : String(error)}\n`);
    return 2;
  }
  if (parsed.positionals.length) {
    err.write(`moh handoff: unexpected argument "${parsed.positionals[0]}"\n`);
    return 2;
  }
  const cwd = resolve(parsed.strings.cwd ?? options.cwd ?? process.cwd());
  let config;
  try {
    config = loadMohConfig(join(cwd, "moh.json"));
  } catch (error) {
    err.write(`moh handoff: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (config.handoff?.transport !== "gist") {
    err.write('moh handoff: handoff.transport must be "gist" in moh.json\n');
    return 2;
  }
  const artifact = readRawHandoff(HandoffRunner.artifactFile(cwd, join(options.home ?? homedir(), ".moh")));
  if (!artifact) {
    err.write("moh handoff: no local handoff artifact\n");
    return 1;
  }
  const tracker = options.tracker === undefined ? await resolveTracker({ cwd }) : options.tracker;
  const payload = await enrichHandoffWithWayfinder(artifact, tracker);
  const transport = options.transport ?? createGistHandoffTransport({ cwd, home: options.home });
  const published = await transport.publish(payload);
  if (!published.ok) {
    err.write(`moh handoff: publish failed (${published.error.reason}) — handoff kept local only\n`);
    return 1;
  }
  out.write(`handoff published: ${published.url}\n`);
  if (!parsed.booleans["notify-ticket"]) return 0;
  try {
    const notified = await notifyClaimedWayfinderTickets(payload, tracker, published.url);
    out.write(notified ? `notified ${notified} claimed Wayfinder ticket${notified === 1 ? "" : "s"}\n` : "no claimed Wayfinder tickets to notify\n");
    return 0;
  } catch (error) {
    err.write(`moh handoff: published, but ticket notification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
