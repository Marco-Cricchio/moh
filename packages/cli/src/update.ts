#!/usr/bin/env bun
/**
 * `moh update` (#274 / ADR-0014): self-update the running binary to the
 * latest stable GitHub Release — download, sha256-verify against
 * checksums.txt, atomic replace. Dev runs refuse; downgrades from
 * non-stable builds ask for confirmation.
 * #351: phase progress on the terminal — one line per phase committed with
 * ✓/✗, a spinner on the open line in TTY runs, plain milestone lines when
 * piped (see update-progress.ts).
 */
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performSelfUpdate, isDevRun } from "@moh/core";
import type { SelfUpdateIo, SelfUpdateProgress, SelfUpdateResult } from "@moh/core";
import { CLI_VERSION } from "./version";
import { UpdateProgress, interactiveStream } from "./update-progress";

export const UPDATE_USAGE = `usage: moh update [options]

Update the moh binary in place to the latest stable GitHub Release:
download the platform asset, verify its sha256 against the release's
checksums.txt, then atomically replace the running executable.

Downgrades from a non-stable build to the latest stable ask for
confirmation; pass --yes to skip (or to run non-interactively).

options:
  --yes   assume "yes" at the downgrade confirmation
  --help  show this help
`;

/** Exit code for each outcome. */
function exitCodeFor(status: SelfUpdateResult["status"]): number {
  switch (status) {
    case "updated":
    case "up-to-date":
      return 0;
    default:
      return 1;
  }
}

/** Human label for a progress phase (#351). */
function phaseLabel(phase: SelfUpdateProgress["phase"]): string {
  switch (phase) {
    case "checking":
      return "Checking for the latest release";
    case "downloading":
      return "Downloading the update";
    case "verifying":
      return "Verifying checksum";
    case "installing":
      return "Installing the new binary";
  }
}

/** `46.2 MB` style detail for the download commit line. */
function formatDetail(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export async function updateCommand(options: {
  argv: string[];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Interactive confirmation for downgrades; default: ask on stdin. */
  confirm?: (latestVersion: string) => Promise<boolean>;
  /** Default: isDevRun() — injectable for tests. */
  devRun?: boolean;
  /** Default: process.execPath — injectable for tests. */
  execPath?: string;
  /** Injectable fetch (test seam, forwarded to performSelfUpdate). */
  fetch?: SelfUpdateIo["fetch"];
  /** Injectable current version (test seam). */
  currentVersion?: string;
  /** Injectable platform (test seam). */
  platform?: "darwin-arm64" | "darwin-x64" | "linux-x64";
  /** moh home dir (test seam; default ~/.moh) — a successful update
   * refreshes the update-check cache there (#328). */
  mohHome?: string;
}): Promise<number> {
  const argv = options.argv.filter((a) => a !== "--yes" && a !== "--help" && a !== "-h");
  if (options.argv.includes("--help") || options.argv.includes("-h")) {
    (options.stdout ?? process.stdout).write(UPDATE_USAGE);
    return 0;
  }
  const unknown = argv.filter((a) => a.startsWith("-"));
  if (unknown.length) {
    (options.stderr ?? process.stderr).write(`moh update: unknown option ${unknown.join(" ")}\n\n${UPDATE_USAGE}`);
    return 2;
  }

  // Dev run (bun packages/cli/src/cli.ts): the executable is the Bun
  // interpreter, not moh — self-update is meaningless. Point at git.
  if (options.devRun ?? isDevRun()) {
    (options.stderr ?? process.stderr).write(
      `moh update only works on a compiled binary; this is a dev run.\nUpdate via git: pull the latest develop and rebuild (bun scripts/build.ts).\n`,
    );
    return 1;
  }

  const stream = options.stdout ?? process.stdout;
  const progress = new UpdateProgress({ stream, interactive: interactiveStream(stream) });

  const confirm = options.confirm ?? (async (latest: string) => {
    // The prompt must own the terminal: drop the spinner line while asking.
    progress.pause();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(`You are running moh ${CLI_VERSION}, which is newer than the latest stable (${latest}). Downgrade to ${latest}? [y/N] `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
      progress.resume();
    }
  });

  try {
    const result = await performSelfUpdate({
      currentVersion: options.currentVersion ?? CLI_VERSION,
      execPath: options.execPath ?? process.execPath,
      platform: options.platform,
      assumeYes: options.argv.includes("--yes"),
      confirmDowngrade: confirm,
      io: options.fetch ? { fetch: options.fetch } : undefined,
      mohHome: options.mohHome ?? join(homedir(), ".moh"),
      onProgress: (p: SelfUpdateProgress) => {
        // The second `downloading` event (receivedBytes > 0) is the body
        // fully received: commit the line with the byte count.
        if (p.phase === "downloading" && p.receivedBytes > 0) {
          progress.commit(true, formatDetail(p.receivedBytes));
        } else {
          progress.begin(phaseLabel(p.phase));
        }
      },
    });
    // Commit whichever phase was left open: ✓ when the phase itself
    // succeeded (the outcome is explained by the final message), ✗ when
    // the open phase is the one that failed.
    if (result.status === "updated" || result.status === "up-to-date" || result.status === "confirm-declined") {
      progress.commit(true);
    } else {
      progress.commit(false);
    }
    const out = result.status === "updated" ? options.stdout ?? process.stdout : options.stderr ?? process.stderr;
    out.write(result.message + "\n");
    return exitCodeFor(result.status);
  } finally {
    progress.end();
  }
}
