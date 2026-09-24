/**
 * #935 / ADR-0029 amendment: the moh-owned browser toolchain.
 *
 * The native browser tool (#774) needs `playwright-core` plus a Chromium
 * build. Before this module the contract was "install it yourself with
 * npm" — which cannot work for a compiled moh binary: a package installed
 * by `npm i -g` is not resolvable from inside a Bun single-file binary
 * unless the environment happens to expose it through `NODE_PATH`.
 *
 * So the core owns the whole toolchain story, in one place, for both
 * clients:
 *
 *  - **resolution** — explicit paths only: the project's own
 *    `node_modules` first (a user who installed playwright-core in the
 *    repo keeps working, unchanged), then the user-owned moh root at
 *    `<home>/.moh/browser-toolchain/node_modules`. Never a global npm
 *    root, never `NODE_PATH`.
 *  - **probing** — package presence + version, full Chromium presence,
 *    headless-shell presence, and actionable reasons. A headless launch
 *    needs the *shell*, not the full build (Playwright resolves
 *    `chromium-headless-shell` for `headless: true`), so the two are
 *    reported separately.
 *  - **installation** — the Bun runtime embedded in moh
 *    (`BUN_BE_BUN=1 <moh binary> install …`) downloads the package into
 *    the moh root and Playwright's own CLI downloads the browsers into
 *    Playwright's per-user cache. No npm, no system Bun, no package
 *    manager, no sudo unless the caller explicitly asks for system
 *    dependencies.
 *
 * Failure model: nothing ever throws at the client boundary. Probing
 * returns a typed status (never a session failure); installing returns an
 * explicit `{ ok: false, kind }`. An install never replaces a working
 * toolchain with a broken one: the download lands in a staging directory
 * and is promoted by a single atomic rename.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createLockFile, ownerIsGone, parseLockOwner, readLockFile, releaseLockFile } from "./memory-lock";

/** The npm package the browser tool drives Chromium through. */
export const PLAYWRIGHT_PACKAGE = "playwright-core";

/**
 * The one actionable instruction every surface shows when the toolchain
 * is missing (TUI warning, `moh run` stderr line, manual). The client
 * owns the surface, the core owns the sentence.
 */
export const BROWSER_SETUP_HINT = "run `moh browser install` (or Settings → Browser → Install)";

/** System dependency installation may ask for the administrator password. */
export const BROWSER_WITH_DEPS_NOTE =
  "installing system dependencies runs Playwright's dependency installer and may ask for your system administrator password";

/** Approximate download sizes, shown to the user before a download starts. */
export const HEADLESS_SHELL_DOWNLOAD_SIZE = "~200 MB";
export const FULL_CHROMIUM_DOWNLOAD_SIZE = "~500 MB";

/** The directory layer that makes the root swap atomic (see `promote`). */
const VERSIONS_DIRNAME = ".browser-toolchain-versions";
const LOCK_FILENAME = ".browser-toolchain.lock";

/** The playwright-core surface resolution needs. */
export interface PlaywrightModuleLike {
  chromium: {
    launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<unknown>;
    executablePath(): string;
  };
}

/** Where a resolved playwright-core came from. */
export type PlaywrightSource = "project" | "moh";

export interface ResolvedPlaywright {
  module: PlaywrightModuleLike;
  /** The resolved package directory (never a global npm root). */
  packageDir: string;
  version: string;
  source: PlaywrightSource;
}

/** Options shared by resolution, probing and installation. */
export interface BrowserToolchainOptions {
  /** Project root: its `node_modules` wins. Default `process.cwd()`. */
  cwd?: string;
  /** User home (default `homedir()`); the moh root lives under `<home>/.moh`. */
  home?: string;
  /** The mode the caller cares about: `ready` means a launch in this mode succeeds. Default true. */
  headless?: boolean;
  /** Test seam: a pre-built playwright-core module, skipping resolution. */
  playwright?: unknown;
  /** Test seam: module loader `(absolutePath) => module`. */
  loadModule?: (specifier: string) => unknown;
}

/** Availability of one Chromium build. */
export interface BrowserBuildStatus {
  /**
   * True when the build's executable exists. When Playwright's registry
   * cannot be read (see `probeBrowserBuilds`), the shell inherits the
   * full build's answer: Playwright installs the two together by default,
   * and a *probe* must never block a toolchain that would work.
   */
  available: boolean;
  /** The executable Playwright would launch. */
  path?: string;
  /** The browser version Playwright expects (from its registry). */
  version?: string;
}

/** The probe result every client renders. Never throws, never partial. */
export interface BrowserToolchainStatus {
  /** The moh-owned toolchain root (`<home>/.moh/browser-toolchain`). */
  root: string;
  package: {
    available: boolean;
    version?: string;
    packageDir?: string;
    source?: PlaywrightSource;
  };
  /** The full build — needed by `browser.headless: false` (headful). */
  chromium: BrowserBuildStatus;
  /** The headless shell — what the default headless mode launches. */
  chromiumHeadlessShell: BrowserBuildStatus;
  /** True when a session configured with the probed `headless` can launch. */
  ready: boolean;
  /** Actionable, user-facing sentences; empty when ready. */
  reasons: string[];
}

export interface BrowserToolchainProgress {
  phase: "start" | "package" | "browsers" | "deps" | "swap" | "done";
  message: string;
  /** A line streamed from the install subprocess, as it arrives. */
  line?: string;
}

/** One install subprocess: the embedded Bun runtime, given arguments. */
export interface BrowserToolchainCommand {
  args: string[];
  cwd: string;
  /** The install step this command belongs to (progress phase). */
  phase: "package" | "browsers" | "deps";
}

export interface BrowserToolchainCommandResult {
  code: number;
  /** The last lines of the subprocess output, for error reporting. */
  stderr: string;
}

/** Runs one install step, forwarding its output lines as they arrive. */
export type BrowserToolchainRunner = (
  command: BrowserToolchainCommand,
  onLine: (line: string) => void,
) => Promise<BrowserToolchainCommandResult>;

export interface BrowserToolchainInstallOptions extends BrowserToolchainOptions {
  /** Also download the full Chromium build (headful use). Never implicit. */
  withChromium?: boolean;
  /** Run Playwright's system dependency installer. Never implicit. */
  withDeps?: boolean;
  onProgress?: (event: BrowserToolchainProgress) => void;
  /** Test seam: how an install step runs. Default: the embedded Bun runtime. */
  run?: BrowserToolchainRunner;
}

export type BrowserToolchainInstallResult =
  | {
      ok: true;
      /** The resolved playwright-core version now installed in the moh root. */
      version: string;
      /** The Chromium builds present after the install, as the probe sees them. */
      builds: ("chromium" | "chromium-headless-shell")[];
      status: BrowserToolchainStatus;
    }
  | {
      ok: false;
      /** `busy`: another moh process holds the install lock. `failed`: the install itself. */
      kind: "busy" | "failed";
      message: string;
      /** The toolchain as it stands now (unchanged when nothing was promoted). */
      status: BrowserToolchainStatus;
    };

/** The moh-owned toolchain root: platform-neutral, derived from the home dir. */
export function browserToolchainRoot(home = homedir()): string {
  return join(home, ".moh", "browser-toolchain");
}

/** The paths one install touches, all derived from the home dir. */
function toolchainPaths(home: string): { mohHome: string; root: string; versions: string; lock: string } {
  const mohHome = join(home, ".moh");
  return {
    mohHome,
    root: browserToolchainRoot(home),
    versions: join(mohHome, VERSIONS_DIRNAME),
    lock: join(mohHome, LOCK_FILENAME),
  };
}

/**
 * #935: explicit resolution — the project's own installation first (the
 * nearest `node_modules` walking up from the project root, Node's own
 * algorithm), then the moh-owned root at `<home>/.moh/browser-toolchain`.
 *
 * Both branches are **existence-gated**: `require` is only ever called for
 * a path that is already known to exist. That is not defensive style, it
 * is the whole contract — `require("playwright-core")` with no local
 * install falls back to Bun's global install cache, so a compiled moh
 * binary could silently load whatever copy happens to sit there (a
 * different version, installed by an unrelated project). moh resolves what
 * the user actually has, or reports the toolchain as missing.
 */
export function resolvePlaywright(
  options: BrowserToolchainOptions = {},
): ResolvedPlaywright | { missing: string } {
  if (options.playwright !== undefined) {
    const injected = options.playwright;
    if (typeof injected === "object" && injected !== null && "missing" in injected) {
      return { missing: (injected as { missing: string }).missing };
    }
    const mod = unwrapModule(injected);
    if (!mod) return { missing: `${PLAYWRIGHT_PACKAGE} is installed but unusable` };
    return {
      module: mod,
      packageDir: (injected as { packageDir?: string }).packageDir ?? "",
      version: (injected as { version?: string }).version ?? "unknown",
      source: (injected as { source?: PlaywrightSource }).source ?? "moh",
    };
  }

  const load = options.loadModule ?? defaultLoadModule;
  const candidates: { dir: string; source: PlaywrightSource }[] = [];
  const project = findProjectPackage(options.cwd ?? process.cwd());
  if (project) candidates.push({ dir: project, source: "project" });
  const owned = join(browserToolchainRoot(options.home ?? homedir()), "node_modules", PLAYWRIGHT_PACKAGE);
  if (existsSync(join(owned, "package.json"))) candidates.push({ dir: owned, source: "moh" });

  for (const { dir, source } of candidates) {
    const loaded = tryLoad(load, dir);
    if (loaded.ok) return { ...loaded.value, source };
    // Present but unusable is a distinct diagnosis: telling the user to
    // install again would not fix a broken module tree.
    if (loaded.reason === "unusable") return { missing: `${PLAYWRIGHT_PACKAGE} is installed but unusable` };
  }
  return { missing: `${PLAYWRIGHT_PACKAGE} is not installed` };
}

/**
 * The nearest `node_modules/playwright-core` walking up from `cwd` (Node's
 * algorithm, implemented explicitly): a hoisted workspace install counts
 * as project-local, and no runtime lookup ever gets a chance to answer.
 */
function findProjectPackage(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const pkg = join(dir, "node_modules", PLAYWRIGHT_PACKAGE);
    if (existsSync(join(pkg, "package.json"))) return pkg;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The status plus the module it came from — one resolution per call. */
export interface BrowserToolchainProbeResult {
  status: BrowserToolchainStatus;
  resolved: ResolvedPlaywright | null;
}

/**
 * #935: the availability probe — never throws. `ready` is decided for the
 * mode the caller asked about: a headless launch needs the headless shell,
 * a headful one the full build.
 */
export function probeBrowserToolchain(options: BrowserToolchainOptions = {}): BrowserToolchainStatus {
  return probeBrowserToolchainWithModule(options).status;
}

/** `probeBrowserToolchain`, keeping the resolved module for the caller
 * that must load it (the core's browser session) — one resolution, one
 * `require`, one module identity per call. */
export function probeBrowserToolchainWithModule(options: BrowserToolchainOptions = {}): BrowserToolchainProbeResult {
  const root = browserToolchainRoot(options.home ?? homedir());
  const headless = options.headless ?? true;
  const resolved = resolvePlaywright(options);
  if ("missing" in resolved) {
    return {
      resolved: null,
      status: {
        root,
        package: { available: false },
        chromium: { available: false },
        chromiumHeadlessShell: { available: false },
        ready: false,
        reasons: [
          `${resolved.missing} — the browser tool needs ${PLAYWRIGHT_PACKAGE} plus a Chromium build; ${BROWSER_SETUP_HINT}`,
        ],
      },
    };
  }

  const builds = probeBrowserBuilds(resolved);
  const reasons: string[] = [];
  const wanted = headless ? builds.chromiumHeadlessShell : builds.chromium;
  if (!wanted.available) {
    reasons.push(
      headless
        ? `the Chromium headless shell is not installed — the browser tool runs headless by default; ${BROWSER_SETUP_HINT}`
        : `the full Chromium build is not installed (needed by browser.headless: false); ${BROWSER_SETUP_HINT}`,
    );
  }

  return {
    resolved,
    status: {
      root,
      package: {
        available: true,
        version: resolved.version,
        packageDir: resolved.packageDir,
        source: resolved.source,
      },
      chromium: builds.chromium,
      chromiumHeadlessShell: builds.chromiumHeadlessShell,
      ready: reasons.length === 0,
      reasons,
    },
  };
}

/**
 * #935: install (or refresh) the toolchain in the moh-owned root.
 *
 * Order: package, then the headless shell, then — only when asked — the
 * full Chromium build and/or Playwright's system dependencies. Nothing
 * touches the live root until the very end: the work happens in a staging
 * directory and is promoted by a single atomic rename, so a failed or
 * interrupted install leaves a previously working toolchain exactly as it
 * was.
 */
export async function installBrowserToolchain(
  options: BrowserToolchainInstallOptions = {},
): Promise<BrowserToolchainInstallResult> {
  const home = options.home ?? homedir();
  const paths = toolchainPaths(home);
  // The staging name is unique for the same reason the stamp is: two installs
  // inside one millisecond must not share (or delete) each other's directory.
  const staging = join(paths.versions, `.staging-${process.pid}-${Date.now()}-${++stampSeq}`);
  const probe = (): BrowserToolchainStatus =>
    probeBrowserToolchain({
      cwd: options.cwd,
      home,
      headless: options.headless,
      playwright: options.playwright,
      loadModule: options.loadModule,
    });
  const fail = (kind: "busy" | "failed", message: string): BrowserToolchainInstallResult => ({
    ok: false,
    kind,
    message,
    status: probe(),
  });
  const progress = (event: BrowserToolchainProgress) => options.onProgress?.(event);

  try {
    mkdirSync(paths.versions, { recursive: true, mode: 0o700 });
    if (!claimLock(paths.lock)) {
      return fail(
        "busy",
        `another moh process is installing the browser toolchain (${paths.lock}) — retry when it finishes`,
      );
    }
  } catch (e) {
    return fail("failed", `cannot prepare ${paths.mohHome}: ${message(e)}`);
  }

  try {
    // We hold the lock: any staging or version directory that is not the
    // live one belongs to an install that died.
    pruneVersions(paths.versions, liveVersion(paths.root));
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(staging, "package.json"),
      `${JSON.stringify({ name: "moh-browser-toolchain", private: true, version: "0.0.0" }, null, 2)}\n`,
    );

    const run = options.run ?? embeddedBunRunner();
    const runStep = async (phase: "package" | "browsers" | "deps", args: string[], text: string) => {
      progress({ phase, message: text });
      return await run({ args, cwd: staging, phase }, (line) => progress({ phase, message: text, line }));
    };

    // 1. The package, through the Bun runtime embedded in moh.
    progress({ phase: "start", message: `installing ${PLAYWRIGHT_PACKAGE} into ${paths.root}` });
    const pkg = await runStep("package", ["install", `${PLAYWRIGHT_PACKAGE}@latest`], `installing ${PLAYWRIGHT_PACKAGE}`);
    const installed = readInstalledPackage(join(staging, "node_modules", PLAYWRIGHT_PACKAGE));
    if (pkg.code !== 0 || !installed) {
      return fail(
        "failed",
        `installing ${PLAYWRIGHT_PACKAGE} failed${pkg.code === 0 ? " (the package did not appear)" : `: ${lastLine(pkg.stderr)}`}`,
      );
    }

    // 2. The browsers, through Playwright's own CLI — which is what keeps
    //    the download in Playwright's per-user cache (its canonical
    //    location, XDG and platform rules stay Playwright's business).
    //    `chromium` implies the headless shell too (Playwright's own
    //    default), so the full build is never a silent *extra* download.
    const cli = join(staging, "node_modules", PLAYWRIGHT_PACKAGE, "cli.js");
    const browserArgs = ["install", "--no-progress", options.withChromium ? "chromium" : "chromium-headless-shell"];
    const browsers = await runStep(
      "browsers",
      [cli, ...browserArgs],
      options.withChromium
        ? `downloading Chromium and the headless shell (${FULL_CHROMIUM_DOWNLOAD_SIZE})`
        : `downloading the Chromium headless shell (${HEADLESS_SHELL_DOWNLOAD_SIZE})`,
    );
    if (browsers.code !== 0) {
      return fail("failed", `downloading the Chromium build failed: ${lastLine(browsers.stderr)}`);
    }

    // 3. System dependencies: explicit only — it may ask for the admin password.
    if (options.withDeps) {
      progress({ phase: "deps", message: BROWSER_WITH_DEPS_NOTE });
      const deps = await runStep(
        "deps",
        [cli, "install-deps", options.withChromium ? "chromium" : "chromium-headless-shell"],
        BROWSER_WITH_DEPS_NOTE,
      );
      if (deps.code !== 0) {
        return fail(
          "failed",
          `installing system dependencies failed: ${lastLine(deps.stderr)} — install the Chromium system libraries manually (Playwright's docs list them per distribution) and retry`,
        );
      }
    }

    progress({ phase: "swap", message: `installing the toolchain into ${paths.root}` });
    promote(paths, staging);
    const status = probe();
    progress({ phase: "done", message: `browser toolchain ready (${PLAYWRIGHT_PACKAGE} ${installed.version})` });
    return { ok: true, version: installed.version, builds: installedBuilds(status), status };
  } catch (e) {
    return fail("failed", `browser toolchain install failed: ${message(e)}`);
  } finally {
    // Best-effort cleanup: a throw here would turn a reported outcome into
    // a rejected promise, which the seam never does.
    quietly(() => rmSync(staging, { recursive: true, force: true }));
    quietly(() => releaseLockFile(paths.lock));
  }
}

/** Bumped per promotion: a millisecond alone is not a unique name. */
let stampSeq = 0;

/**
 * #935: the atomic promotion.
 *
 * The toolchain lives in `<mohHome>/.browser-toolchain-versions/<stamp>`
 * and the root path is a *symlink* to one of those directories. Promotion
 * is therefore a single `rename` of a symlink over the previous symlink:
 * the root path is never absent, not even for the instant between two
 * renames — which is what makes an interrupted install harmless.
 */
function promote(paths: { mohHome: string; root: string; versions: string }, staging: string): void {
  // A millisecond is not a unique name: two installs inside one millisecond
  // (a fast runner, an immediate retry) computed the same stamp, and the
  // rename onto the existing version directory died with ENOTEMPTY — the
  // install reported a raw filesystem error instead of installing. The
  // counter makes the name unique per process, the clock per instant.
  const stamp = `v-${Date.now()}-${process.pid}-${++stampSeq}`;
  renameSync(staging, join(paths.versions, stamp));
  // A real directory at the root path: hand-made, or left by a pre-release
  // build. Move it into the versions directory once, then the symlink swap
  // owns the path for good.
  if (existsSync(paths.root) && !lstatSync(paths.root).isSymbolicLink()) {
    renameSync(paths.root, join(paths.versions, `.legacy-${Date.now()}-${process.pid}`));
  }
  const link = join(paths.mohHome, `.browser-toolchain.link-${process.pid}`);
  quietly(() => rmSync(link, { force: true }));
  // Relative target, and the link is created in the directory it will live
  // in, so the rename below cannot invalidate it.
  symlinkSync(join(VERSIONS_DIRNAME, stamp), link, "dir");
  renameSync(link, paths.root);
  pruneVersions(paths.versions, stamp);
}

/** The version directory the root currently points at, if any. */
function liveVersion(root: string): string | null {
  try {
    return basename(readlinkSync(root));
  } catch {
    // Not a symlink (nothing installed yet, or a legacy real directory).
    return null;
  }
}

/** Removes every version/staging directory except the live one (best-effort). */
function pruneVersions(versions: string, keep: string | null): void {
  quietly(() => {
    for (const entry of readdirSync(versions)) {
      if (entry === keep || entry === "." || entry === "..") continue;
      rmSync(join(versions, entry), { recursive: true, force: true });
    }
  });
}

/** The Chromium builds the probe can see right now. */
function installedBuilds(status: BrowserToolchainStatus): ("chromium" | "chromium-headless-shell")[] {
  const builds: ("chromium" | "chromium-headless-shell")[] = [];
  if (status.chromiumHeadlessShell.available) builds.push("chromium-headless-shell");
  if (status.chromium.available) builds.push("chromium");
  return builds;
}

/** The install subprocess runner: moh's own binary, in Bun-CLI mode. */
function embeddedBunRunner(): BrowserToolchainRunner {
  return async (command, onLine) => {
    // BUN_BE_BUN=1 makes the compiled moh binary behave as the Bun CLI it
    // embeds — the whole reason a fresh user needs no npm and no system Bun.
    const env = { ...process.env, BUN_BE_BUN: "1" };
    const proc = Bun.spawn([process.execPath, ...command.args], {
      cwd: command.cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const tail: string[] = [];
    // Both streams are drained (an unread pipe would block the child) and
    // both are forwarded: `bun install` reports on stderr, Playwright's
    // download progress on stdout.
    const [, , code] = await Promise.all([
      pumpLines(proc.stdout, onLine, tail),
      pumpLines(proc.stderr, onLine, tail),
      proc.exited,
    ]);
    return { code, stderr: tail.join("\n") };
  };
}

/** Forwards a child stream line by line, keeping the last lines for errors. */
async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  tail: string[],
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = (raw: string) => {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) return;
    tail.push(line);
    if (tail.length > 20) tail.shift();
    onLine(line);
  };
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      emit(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  emit(buffer);
}

/** Takes the install lock, reclaiming one whose owner is demonstrably gone. */
function claimLock(lock: string): boolean {
  if (createLockFile(lock)) return true;
  const owner = parseLockOwner(readLockFile(lock));
  // Ownership, never age: a 500 MB download on a slow line is a live
  // install, and evicting it would put two installers on one root.
  if (owner && !ownerIsGone(owner)) return false;
  quietly(() => rmSync(lock, { force: true }));
  return createLockFile(lock);
}

/**
 * Loads one module by its absolute path (never a bare specifier: no lookup,
 * no fallback). Returns the version from the package manifest when readable.
 */
function tryLoad(
  load: (specifier: string) => unknown,
  packageDir: string,
): { ok: true; value: { module: PlaywrightModuleLike; packageDir: string; version: string } } | { ok: false; reason: "absent" | "unusable" } {
  let loaded: unknown;
  try {
    loaded = load(packageDir);
  } catch {
    return { ok: false, reason: "absent" };
  }
  const mod = unwrapModule(loaded);
  if (!mod) return { ok: false, reason: "unusable" };
  let version = "unknown";
  try {
    const meta = load(join(packageDir, "package.json")) as { version?: string };
    version = meta.version ?? "unknown";
  } catch {
    /* the module loaded: a missing manifest only costs the version */
  }
  return { ok: true, value: { module: mod, packageDir: realPath(packageDir), version } };
}

/** The real path of a directory (macOS tmpdirs are symlinks); best-effort. */
function realPath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The real loader: `require` of an absolute path. */
function defaultLoadModule(specifier: string): unknown {
  const { createRequire } = require("node:module") as typeof import("node:module");
  return createRequire(import.meta.url)(specifier) as unknown;
}

function unwrapModule(loaded: unknown): PlaywrightModuleLike | null {
  const root = (loaded as { default?: unknown })?.default ?? loaded;
  // The injected test seam historically passes the `{ pw }` probe shape
  // (and `{ missing }` for the absent case, handled by the caller).
  for (const candidate of [root, (root as { pw?: unknown })?.pw]) {
    const chromium = (candidate as PlaywrightModuleLike | undefined)?.chromium;
    if (typeof chromium?.launchPersistentContext === "function") return candidate as PlaywrightModuleLike;
  }
  return null;
}

/**
 * #935: browser availability from Playwright's own registry (a declared
 * export of the package: `playwright-core/lib/coreBundle`), so the paths
 * and versions are exactly the ones a launch would use — including the
 * headless shell, which has no public accessor.
 *
 * If that internal shape ever moves, the probe falls back to the public
 * `executablePath()` for the full build and assumes the shell travels with
 * it: a working install must never be blocked by the *probe*.
 */
function probeBrowserBuilds(resolved: ResolvedPlaywright): {
  chromium: BrowserBuildStatus;
  chromiumHeadlessShell: BrowserBuildStatus;
} {
  const fromRegistry = registryBuilds(resolved);
  if (fromRegistry) return fromRegistry;
  const path = executablePath(resolved.module);
  const chromium: BrowserBuildStatus = path && existsSync(path) ? { available: true, path } : { available: false };
  return { chromium, chromiumHeadlessShell: { ...chromium } };
}

function registryBuilds(
  resolved: ResolvedPlaywright,
): { chromium: BrowserBuildStatus; chromiumHeadlessShell: BrowserBuildStatus } | null {
  if (!resolved.packageDir) return null;
  // The declared export first (a package specifier anchored inside the
  // package's own node_modules — deterministic, it resolves the sibling
  // package), the shipped file path as the fallback.
  const specs = [
    { specifier: `${PLAYWRIGHT_PACKAGE}/lib/coreBundle`, anchor: join(dirname(resolved.packageDir), "noop.js") },
    { specifier: join(resolved.packageDir, "lib", "coreBundle.js"), anchor: join(resolved.packageDir, "noop.js") },
  ];
  for (const { specifier, anchor } of specs) {
    try {
      const { createRequire } = require("node:module") as typeof import("node:module");
      const bundle = createRequire(anchor)(specifier) as {
        registry?: { registry?: { findExecutable(name: string): unknown } };
      };
      const registry = bundle?.registry?.registry;
      if (typeof registry?.findExecutable !== "function") continue;
      return {
        chromium: registryBuild(registry, "chromium"),
        chromiumHeadlessShell: registryBuild(registry, "chromium-headless-shell"),
      };
    } catch {
      continue;
    }
  }
  return null;
}

function registryBuild(registry: { findExecutable(name: string): unknown }, name: string): BrowserBuildStatus {
  const executable = registry.findExecutable(name) as
    | { executablePath?(): string | undefined; browserVersion?: string }
    | undefined;
  let path: string | undefined;
  try {
    path = executable?.executablePath?.();
  } catch {
    path = undefined;
  }
  if (!path) return { available: false };
  const version = executable?.browserVersion;
  return existsSync(path) ? { available: true, path, version } : { available: false, path, version };
}

function executablePath(mod: PlaywrightModuleLike): string {
  try {
    return mod.chromium.executablePath();
  } catch {
    return "";
  }
}

/** Reads an installed package's manifest — the version record for the toolchain. */
function readInstalledPackage(dir: string): { version: string } | null {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
    return { version: meta.version ?? "unknown" };
  } catch {
    return null;
  }
}

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : "no output";
}

/** Runs a cleanup step without ever letting it become the caller's error. */
function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    /* best-effort hygiene only */
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
