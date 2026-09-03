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
  exportHandoffFile,
  importHandoffFile,
  loadMohConfig,
  notifyClaimedWayfinderTickets,
  readRawHandoff,
  resolveTracker,
  type HandoffTransport,
  type TrackerBackend,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const HANDOFF_USAGE = `usage: moh handoff [--notify-ticket] [--cwd <dir>]
       moh handoff export <file> [--cwd <dir>]
       moh handoff import <file> [--cwd <dir>]

With no subcommand: publishes the local session handoff when
handoff.transport is "gist".

export/import (#440) are the manual file fallback — for machines with
no gh, offline transfers, or removable media:
  export <file>    write the local handoff artifact (with the same
                   read-only Wayfinder enrichment as a publish) to <file>
  import <file>    validate a received export and register it for this
                   project; the newest of gist/import/local is then
                   offered at the next startup

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
    const [subcommand] = parsed.positionals;
    if (subcommand !== "export" && subcommand !== "import") {
      err.write(`moh handoff: unexpected argument "${parsed.positionals[0]}"\n`);
      return 2;
    }
  }
  const cwd = resolve(parsed.strings.cwd ?? options.cwd ?? process.cwd());
  if (parsed.positionals.length) {
    return handoffFileCommand(parsed.positionals[0] as "export" | "import", parsed.positionals.slice(1), options, out, err, cwd);
  }
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

/**
 * `moh handoff export|import <file>` (T7 #440): the manual file
 * fallback. Subcommand handling happens before the publish-only
 * `handoff.transport: "gist"` requirement: the fallback exists exactly
 * for machines where the gist transport is unavailable (no gh, offline
 * transfers, private repos with transport "none").
 */
async function handoffFileCommand(
  subcommand: "export" | "import",
  rest: string[],
  options: HandoffCommandOptions,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
  cwd: string,
): Promise<number> {
  const file = rest[0];
  if (!file || rest.length > 1) {
    err.write(`moh handoff ${subcommand}: exactly one <file> argument is required\n`);
    return 2;
  }
  if (subcommand === "export") {
    const tracker = await resolveTracker({ cwd }).catch(() => null);
    const result = await exportHandoffFile({
      cwd,
      home: options.home,
      out: resolve(file),
      enrich: (payload) => enrichHandoffWithWayfinder(payload, tracker),
    });
    if (!result.ok) {
      err.write(
        result.error.reason === "no-artifact"
          ? "moh handoff export: no local handoff artifact\n"
          : `moh handoff export: failed (${result.error.reason === "failed" ? result.error.message : result.error.reason})\n`,
      );
      return 1;
    }
    out.write(`handoff exported: ${result.path}\n`);
    return 0;
  }
  const result = await importHandoffFile({ cwd, home: options.home, file: resolve(file) });
  if (!result.ok) {
    err.write(
      result.error.reason === "missing"
        ? `moh handoff import: no such file: ${resolve(file)}\n`
        : result.error.reason === "invalid"
          ? `moh handoff import: ${resolve(file)} is not a valid handoff export\n`
          : `moh handoff import: failed (${result.error.reason === "failed" ? result.error.message : result.error.reason})\n`,
    );
    return 1;
  }
  out.write(`handoff imported: it will be offered at the next startup if newer than local work\n`);
  return 0;
}
