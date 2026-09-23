/**
 * `moh browser` (#936): status and setup for the optional browser tool's
 * toolchain (#774, ADR-0029; the seam is #935). A deliberately thin
 * client: it renders what the core probe reports, decides which optional
 * pieces to fetch, and calls the core installer. It never resolves a
 * module, probes a path, or runs an install step of its own — that logic
 * has exactly one home (ADR-0004 amendment, #935).
 *
 * The command exists so the diagnostic surfaces can name a real door: the
 * `browser_unavailable` warning in the TUI and the one stderr line of
 * `moh run` both point here (the core's own `BROWSER_SETUP_HINT` sentence).
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  installBrowserToolchain,
  probeBrowserToolchain,
  type BrowserToolchainInstallOptions,
  type BrowserToolchainInstallResult,
  type BrowserToolchainOptions,
  type BrowserToolchainStatus,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";
import { UpdateProgress, interactiveStream } from "./update-progress";

/** The download sizes mirror `HEADLESS_SHELL_DOWNLOAD_SIZE` /
 * `FULL_CHROMIUM_DOWNLOAD_SIZE` in the core seam as literals: the manual
 * generator extracts this const verbatim, so it carries no interpolation. */
export const BROWSER_USAGE = `usage: moh browser [status|install] [options]

The native browser tool (#774, ADR-0029) is opt-in and needs an optional
toolchain: playwright-core plus a Chromium build. moh owns it — setup runs
on the Bun runtime embedded in the binary (no npm, no system Bun, no
sudo), installs the package into ~/.moh/browser-toolchain and leaves
Chromium in Playwright's own per-user cache. A playwright-core installed
in the project's node_modules is used as-is and takes precedence.

  status    what is available and what is missing (default). Exit code 0
            when a headless launch would work, 1 otherwise
  install   install or refresh playwright-core and the Chromium headless
            shell (~200 MB — the piece a headless launch needs)

options:
  --with-chromium  with install: also download the full Chromium build
                   (~500 MB, needed by browser.headless: false)
  --with-deps      with install: also run Playwright's system dependency
                   installer; it may ask for your system administrator
                   password
  --cwd <dir>      project root (default: process.cwd())
  --help           show this help
`;

export interface BrowserCommandOptions {
  argv: string[];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Project root whose `node_modules` wins (default: process.cwd()). */
  cwd?: string;
  /** User home; the moh-owned toolchain lives under `<home>/.moh` (#935). */
  home?: string;
  /** Test seam: the core probe (default `probeBrowserToolchain`). */
  probe?: (options: BrowserToolchainOptions) => BrowserToolchainStatus;
  /** Test seam: the core installer (default `installBrowserToolchain`). */
  install?: (options: BrowserToolchainInstallOptions) => Promise<BrowserToolchainInstallResult>;
}

/** Resolves `--cwd` to an absolute project root (as `usage`/`compact` do:
 * the core's project-local resolution walks up from an absolute path). */
function resolveCwd(raw: string | undefined, fallback: string | undefined): string {
  const value = raw ?? fallback ?? process.cwd();
  return isAbsolute(value) ? value : resolve(value);
}

function sourceLabel(source: BrowserToolchainStatus["package"]["source"]): string {
  return source === "project" ? "project node_modules" : "moh toolchain";
}

function buildLabel(build: { available: boolean; version?: string }): string {
  if (!build.available) return "missing";
  return build.version ? `ready · ${build.version}` : "ready";
}

/** Writes the status report — one row per component, the verdict, and the
 * core's own actionable reasons when the toolchain is not usable — and
 * returns the exit code (0 = a headless launch would work, 1 = it would
 * not): a report is a question with an answer, and scripts read it from
 * the code. */
function reportStatus(status: BrowserToolchainStatus, out: NodeJS.WritableStream): number {
  const row = (label: string, value: string) => `  ${label.padEnd(24)}${value}\n`;
  out.write(`browser toolchain · ${status.root}\n\n`);
  out.write(
    row(
      "playwright-core",
      status.package.available
        ? `${status.package.version ?? "unknown"} · ${sourceLabel(status.package.source)}`
        : "missing",
    ),
  );
  out.write(row("chromium headless shell", buildLabel(status.chromiumHeadlessShell)));
  out.write(row("chromium (full build)", buildLabel(status.chromium)));
  out.write(`\n  ready for a headless launch: ${status.ready ? "yes" : "no"}\n`);
  if (status.reasons.length > 0) {
    out.write("\n  missing:\n");
    for (const reason of status.reasons) out.write(`    · ${reason}\n`);
  } else if (!status.chromium.available) {
    // Headless is usable: the full build is a separate, explicit choice.
    out.write(
      "\n  note: browser.headless: false needs the full Chromium build (~500 MB) — moh browser install --with-chromium\n",
    );
  }
  return status.ready ? 0 : 1;
}

/** The install report: one progress line per core phase, then the outcome.
 * The installer's own message is the actionable one — it names the failing
 * step and, for system dependencies, the manual next step. */
async function runInstall(options: {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  cwd: string;
  home: string;
  withChromium: boolean;
  withDeps: boolean;
  install: NonNullable<BrowserCommandOptions["install"]>;
}): Promise<number> {
  const progress = new UpdateProgress({ stream: options.out, interactive: interactiveStream(options.out) });
  let phase: string | null = null;
  let result: BrowserToolchainInstallResult;
  try {
    result = await options.install({
      cwd: options.cwd,
      home: options.home,
      withChromium: options.withChromium,
      withDeps: options.withDeps,
      onProgress: (event) => {
        // One line per phase: the subprocess lines inside a phase (package
        // manager output, downloader chatter) are the open line's detail,
        // not extra rows.
        if (event.phase === phase) return;
        phase = event.phase;
        progress.begin(event.message);
      },
    });
    progress.commit(result.ok);
  } finally {
    progress.end();
  }
  if (!result.ok) {
    options.err.write(`moh browser install: ${result.message}\n`);
    return 1;
  }
  return 0;
}

export async function browserCommand(options: BrowserCommandOptions): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  if (options.argv.includes("--help") || options.argv.includes("-h")) {
    out.write(BROWSER_USAGE);
    return 0;
  }
  const argv = options.argv.filter((a) => a !== "--help" && a !== "-h");
  let parsed;
  try {
    parsed = parseArgs(argv, { strings: ["cwd"], booleans: ["with-chromium", "with-deps"] });
  } catch (e) {
    if (e instanceof ArgError) {
      err.write(`moh browser: ${e.message}\n\n${BROWSER_USAGE}`);
      return 2;
    }
    throw e;
  }
  // `moh browser` with no subcommand reports status: the question a user
  // who typed the command is almost always asking.
  const sub = parsed.positionals[0] ?? "status";
  if (sub !== "status" && sub !== "install") {
    err.write(`moh browser: unknown subcommand "${sub}" (expected status|install)\n\n${BROWSER_USAGE}`);
    return 2;
  }
  if (parsed.positionals.length > 1) {
    err.write(`moh browser ${sub}: unexpected argument "${parsed.positionals[1]}"\n\n${BROWSER_USAGE}`);
    return 2;
  }
  const withChromium = parsed.booleans["with-chromium"] === true;
  const withDeps = parsed.booleans["with-deps"] === true;
  if (sub === "status" && (withChromium || withDeps)) {
    err.write("moh browser status: --with-chromium and --with-deps apply to install\n");
    return 2;
  }
  const cwd = resolveCwd(parsed.strings["cwd"], options.cwd);
  const home = options.home ?? homedir();
  if (sub === "status") return reportStatus((options.probe ?? probeBrowserToolchain)({ cwd, home }), out);
  return runInstall({
    out,
    err,
    cwd,
    home,
    withChromium,
    withDeps,
    install: options.install ?? installBrowserToolchain,
  });
}
