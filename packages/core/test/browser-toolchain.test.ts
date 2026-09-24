/**
 * #935 / ADR-0029 amendment: the moh-owned browser toolchain seam.
 *
 * Everything here runs against real files in a temp home: resolution,
 * probing and installation go through the same code paths a compiled
 * binary uses (existence-gated absolute `require`, real `existsSync`,
 * Playwright's registry reached through the package's declared
 * `lib/coreBundle` export, a real lock file, a real atomic swap). The
 * playwright-core used by the tests is a stub package on disk — no test
 * needs the real dependency, a real Chromium, or the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_SETUP_HINT,
  browserToolchainRoot,
  installBrowserToolchain,
  probeBrowserToolchain,
  resolvePlaywright,
  type BrowserToolchainCommand,
  type BrowserToolchainCommandResult,
  type BrowserToolchainRunner,
} from "../src/browser-toolchain";
import { ownIdentity } from "../src/memory-lock";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const REAL_PLAYWRIGHT = join(REPO_ROOT, "node_modules", "playwright-core");
const VERSIONS_DIR = ".browser-toolchain-versions";
const LOCK_FILE = ".browser-toolchain.lock";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "moh-toolchain-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A well-formed lock payload for this machine, owned by a pid of our choosing. */
function lockPayload(pid: number): string {
  return JSON.stringify({ ...ownIdentity(), pid, createdAt: Date.now() });
}

/**
 * Writes a playwright-core stub: a real package tree with a manifest, a
 * module exposing `chromium`, and a `lib/coreBundle` registry (the export
 * Playwright itself ships) reporting browser paths under `<root>/.browsers`.
 */
function writeStubPackage(root: string, version = "1.63.0"): string {
  const pkgDir = join(root, "node_modules", "playwright-core");
  mkdirSync(join(pkgDir, "lib"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: "playwright-core",
        version,
        main: "index.js",
        exports: {
          ".": "./index.js",
          "./package.json": "./package.json",
          "./lib/coreBundle": "./lib/coreBundle.js",
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(pkgDir, "index.js"),
    `const { join } = require("node:path");
const browsers = join(__dirname, "..", "..", ".browsers");
module.exports = {
  chromium: {
    executablePath: () => join(browsers, "chromium"),
    launchPersistentContext: async () => ({ newPage: async () => ({}), close: async () => {} }),
  },
};
`,
  );
  writeFileSync(
    join(pkgDir, "lib", "coreBundle.js"),
    `const { join } = require("node:path");
const browsers = join(__dirname, "..", "..", "..", ".browsers");
module.exports = {
  registry: {
    registry: {
      findExecutable: (name) => ({
        executablePath: () => join(browsers, name),
        browserVersion: "153.0.8010.12",
      }),
    },
  },
};
`,
  );
  return pkgDir;
}

/** Marks one browser build as present (the "installed" side of the stub). */
function writeBuild(root: string, build: "chromium" | "chromium-headless-shell"): void {
  mkdirSync(join(root, ".browsers"), { recursive: true });
  writeFileSync(join(root, ".browsers", build), "#!/bin/sh\n");
}

/** An install runner that materializes the stub package + the browsers. */
function fakeRunner(options: { failOn?: "package" | "browsers" | "deps" } = {}) {
  const commands: BrowserToolchainCommand[] = [];
  const run: BrowserToolchainRunner = async (command) => {
    commands.push(command);
    if (options.failOn === command.phase) return { code: 1, stderr: `boom in ${command.phase}\n` };
    if (command.phase === "package") writeStubPackage(command.cwd, "1.63.0");
    if (command.phase === "browsers") {
      const builds: ("chromium" | "chromium-headless-shell")[] = command.args.includes("chromium")
        ? ["chromium", "chromium-headless-shell"]
        : ["chromium-headless-shell"];
      for (const build of builds) writeBuild(command.cwd, build);
    }
    return { code: 0, stderr: "" };
  };
  return { run, commands, phase: (p: string) => commands.find((c) => c.phase === p) };
}

/** Installs the stub toolchain into `home` (the "previously working" state). */
async function installOnce(home: string, project: string) {
  const result = await installBrowserToolchain({ cwd: project, home, run: fakeRunner().run });
  if (!result.ok) throw new Error(`fixture install failed: ${result.message}`);
  return result;
}

describe("#935 browserToolchainRoot", () => {
  test("is the platform-neutral moh-owned root under the home dir", () => {
    expect(browserToolchainRoot("/home/moh")).toBe(join("/home/moh", ".moh", "browser-toolchain"));
  });
});

describe("#935 resolvePlaywright: explicit resolution order", () => {
  test("a project-local install wins over the moh-owned root", () => {
    const project = tempDir();
    const home = tempDir();
    writeStubPackage(project, "1.60.0");
    writeStubPackage(browserToolchainRoot(home), "1.63.0");
    const resolved = resolvePlaywright({ cwd: project, home });
    expect("missing" in resolved).toBe(false);
    if ("missing" in resolved) return;
    expect(resolved.source).toBe("project");
    expect(resolved.version).toBe("1.60.0");
    // The resolver reports the real path (macOS tmpdirs are symlinks).
    expect(resolved.packageDir).toBe(realpathSync(join(project, "node_modules", "playwright-core")));
  });

  test("the moh-owned root is used when the project has none", () => {
    const project = tempDir();
    const home = tempDir();
    const root = browserToolchainRoot(home);
    writeStubPackage(root, "1.63.0");
    const resolved = resolvePlaywright({ cwd: project, home });
    expect("missing" in resolved).toBe(false);
    if ("missing" in resolved) return;
    expect(resolved.source).toBe("moh");
    expect(resolved.version).toBe("1.63.0");
    expect(resolved.packageDir).toBe(realpathSync(join(root, "node_modules", "playwright-core")));
  });

  test("a hoisted install above the project root counts as project-local", () => {
    const repo = tempDir();
    const project = join(repo, "packages", "app");
    const home = tempDir();
    mkdirSync(project, { recursive: true });
    writeStubPackage(repo, "1.60.0");
    writeStubPackage(browserToolchainRoot(home), "1.63.0");
    const resolved = resolvePlaywright({ cwd: project, home });
    expect("missing" in resolved).toBe(false);
    if ("missing" in resolved) return;
    expect(resolved.source).toBe("project");
    expect(resolved.version).toBe("1.60.0");
  });

  test("resolution is explicit: a NODE_PATH tree is never consulted", () => {
    const project = tempDir();
    const home = tempDir();
    const elsewhere = tempDir();
    const previous = process.env.NODE_PATH;
    try {
      writeStubPackage(elsewhere, "9.9.9");
      process.env.NODE_PATH = join(elsewhere, "node_modules");
      const resolved = resolvePlaywright({ cwd: project, home });
      expect("missing" in resolved).toBe(true);
      if ("missing" in resolved) expect(resolved.missing).toContain("not installed");
    } finally {
      if (previous === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = previous;
    }
  });

  test("resolution is existence-gated: the loader is never asked for a bare specifier", () => {
    // The hazard this pins: `require("playwright-core")` with no local
    // install answers from Bun's global install cache, so a compiled
    // binary could load a version nobody installed for it. A loader that
    // would happily answer for ANY specifier must never be reached when
    // no package exists on disk.
    const project = tempDir();
    const home = tempDir();
    const asked: string[] = [];
    const resolved = resolvePlaywright({
      cwd: project,
      home,
      loadModule: (specifier) => {
        asked.push(specifier);
        return { chromium: { launchPersistentContext: () => {}, executablePath: () => "/anywhere" } };
      },
    });
    expect("missing" in resolved).toBe(true);
    expect(asked).toEqual([]);
  });

  test("the loader receives absolute paths only (no lookup, no fallback)", () => {
    const project = tempDir();
    const home = tempDir();
    const asked: string[] = [];
    const pkgDir = writeStubPackage(project, "1.63.0");
    const resolved = resolvePlaywright({
      cwd: project,
      home,
      loadModule: (specifier) => {
        asked.push(specifier);
        return createRequire(import.meta.url)(specifier);
      },
    });
    expect("missing" in resolved).toBe(false);
    expect(asked).toEqual([pkgDir, join(pkgDir, "package.json")]);
  });

  test("absent everywhere: a reason naming the package", () => {
    const resolved = resolvePlaywright({ cwd: tempDir(), home: tempDir() });
    expect("missing" in resolved).toBe(true);
    if ("missing" in resolved) expect(resolved.missing).toBe("playwright-core is not installed");
  });

  test("a package without the chromium launch seam is unusable, not absent", () => {
    const project = tempDir();
    const pkgDir = join(project, "node_modules", "playwright-core");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "playwright-core", version: "1.63.0" }));
    writeFileSync(join(pkgDir, "index.js"), "module.exports = { chromium: {} };\n");
    const resolved = resolvePlaywright({ cwd: project, home: tempDir() });
    expect("missing" in resolved).toBe(true);
    if ("missing" in resolved) expect(resolved.missing).toContain("installed but unusable");
  });

  // The compiled-binary acceptance path, against the real package when the
  // development tree has it (CI installs no optional peer).
  const realPresent = existsSync(REAL_PLAYWRIGHT);
  test.skipIf(!realPresent)("the real playwright-core resolves and probes from an explicit path", () => {
    const home = tempDir();
    const resolved = resolvePlaywright({ cwd: REPO_ROOT, home });
    expect("missing" in resolved).toBe(false);
    if ("missing" in resolved) return;
    expect(resolved.source).toBe("project");
    expect(resolved.version).toBe(
      (JSON.parse(readFileSync(join(REAL_PLAYWRIGHT, "package.json"), "utf8")) as { version: string }).version,
    );
    const status = probeBrowserToolchain({ cwd: REPO_ROOT, home });
    expect(status.package.available).toBe(true);
    // The registry (not the executablePath fallback) is what answered: only
    // it can name the headless shell, which is a separate download.
    expect(status.chromiumHeadlessShell.path ?? "").toContain("chromium_headless_shell");
  });
});

describe("#935 probeBrowserToolchain", () => {
  test("no package: not ready, with the actionable setup sentence", () => {
    const home = tempDir();
    const status = probeBrowserToolchain({ cwd: tempDir(), home });
    expect(status.ready).toBe(false);
    expect(status.package.available).toBe(false);
    expect(status.chromium.available).toBe(false);
    expect(status.chromiumHeadlessShell.available).toBe(false);
    expect(status.reasons[0]).toContain(BROWSER_SETUP_HINT);
    expect(status.root).toBe(browserToolchainRoot(home));
  });

  test("package + headless shell: ready, versions and source reported", () => {
    const project = tempDir();
    writeStubPackage(project, "1.63.0");
    writeBuild(project, "chromium-headless-shell");
    const status = probeBrowserToolchain({ cwd: project, home: tempDir() });
    expect(status.ready).toBe(true);
    expect(status.reasons).toEqual([]);
    expect(status.package).toMatchObject({ available: true, version: "1.63.0", source: "project" });
    expect(status.chromiumHeadlessShell).toMatchObject({ available: true, version: "153.0.8010.12" });
    expect(status.chromium.available).toBe(false);
  });

  test("a headless session needs the shell, not the full build", () => {
    const project = tempDir();
    const home = tempDir();
    writeStubPackage(project);
    writeBuild(project, "chromium");
    const headless = probeBrowserToolchain({ cwd: project, home });
    expect(headless.ready).toBe(false);
    expect(headless.reasons[0]).toContain("headless shell");
    const headful = probeBrowserToolchain({ cwd: project, home, headless: false });
    expect(headful.ready).toBe(true);
  });

  test("a headful session without the full build names the full build", () => {
    const project = tempDir();
    writeStubPackage(project);
    writeBuild(project, "chromium-headless-shell");
    const status = probeBrowserToolchain({ cwd: project, home: tempDir(), headless: false });
    expect(status.ready).toBe(false);
    expect(status.reasons[0]).toContain("full Chromium build");
    expect(status.reasons[0]).toContain("browser.headless: false");
  });

  test("an injected module with no package dir falls back to the public executablePath", () => {
    // The registry fallback: it can only see the full build, and it assumes
    // the shell travels with it (Playwright installs them together) — the
    // point is that a probe never blocks a toolchain that would work.
    const executable = join(tempDir(), "chrome");
    writeFileSync(executable, "");
    const status = probeBrowserToolchain({
      cwd: tempDir(),
      home: tempDir(),
      playwright: {
        chromium: { executablePath: () => executable, launchPersistentContext: async () => ({}) },
      },
    });
    expect(status.package.available).toBe(true);
    expect(status.chromium).toEqual({ available: true, path: executable });
    expect(status.chromiumHeadlessShell).toEqual({ available: true, path: executable });
    expect(status.ready).toBe(true);
  });
});

describe("#935 installBrowserToolchain", () => {
  test("installs the package and the headless shell through injected I/O", async () => {
    const project = tempDir();
    const home = tempDir();
    const runner = fakeRunner();
    const progress: string[] = [];
    const result = await installBrowserToolchain({
      cwd: project,
      home,
      run: runner.run,
      onProgress: (event) => progress.push(event.phase),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe("1.63.0");
    expect(result.builds).toEqual(["chromium-headless-shell"]);
    expect(result.status.ready).toBe(true);
    // The package step runs the embedded runtime's installer, never npm.
    expect(runner.phase("package")?.args).toEqual(["install", "playwright-core@latest"]);
    // The headless shell only: the full Chromium build is never implicit.
    const browsers = runner.phase("browsers")!;
    expect(browsers.args).toContain("chromium-headless-shell");
    expect(browsers.args).not.toContain("chromium");
    expect(runner.phase("deps")).toBeUndefined();
    expect(progress).toEqual(["start", "package", "browsers", "swap", "done"]);
    expect(existsSync(join(browserToolchainRoot(home), "node_modules", "playwright-core", "package.json"))).toBe(true);
    expect(existsSync(join(home, ".moh", LOCK_FILE))).toBe(false);
    expect(readdirSync(join(home, ".moh", VERSIONS_DIR))).toHaveLength(1);
  });

  test("the promotion is one atomic symlink swap, and the old version is pruned", async () => {
    const project = tempDir();
    const home = tempDir();
    const root = browserToolchainRoot(home);
    await installOnce(home, project);
    // The canonical path is a symlink into the versions directory, so it is
    // never absent — not even for the instant between two renames.
    expect(lstatSync(root).isSymbolicLink()).toBe(true);
    const first = readlinkSync(root);
    expect(first).toContain(VERSIONS_DIR);
    await installOnce(home, project);
    const second = readlinkSync(root);
    expect(second).not.toBe(first);
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(join(home, ".moh", VERSIONS_DIR))).toHaveLength(1);
  });

  test("progress forwards the install subprocess output as it arrives", async () => {
    const project = tempDir();
    const home = tempDir();
    const lines: string[] = [];
    const run: BrowserToolchainRunner = async (command, onLine) => {
      if (command.phase === "package") writeStubPackage(command.cwd, "1.63.0");
      if (command.phase === "browsers") writeBuild(command.cwd, "chromium-headless-shell");
      onLine(`working on ${command.phase}`);
      return { code: 0, stderr: "" };
    };
    const result = await installBrowserToolchain({
      cwd: project,
      home,
      run,
      onProgress: (event) => {
        if (event.line) lines.push(event.line);
      },
    });
    expect(result.ok).toBe(true);
    expect(lines).toEqual(["working on package", "working on browsers"]);
  });

  test("withChromium asks for the full build as an explicit option", async () => {
    const project = tempDir();
    const home = tempDir();
    const runner = fakeRunner();
    const result = await installBrowserToolchain({
      cwd: project,
      home,
      headless: false,
      withChromium: true,
      run: runner.run,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(runner.phase("browsers")?.args).toContain("chromium");
    expect(result.builds).toEqual(["chromium-headless-shell", "chromium"]);
    // The status answers the mode the caller asked about (headful here).
    expect(result.status.ready).toBe(true);
    expect(result.status.chromium.available).toBe(true);
  });

  test("a failed install preserves the previously working toolchain", async () => {
    const project = tempDir();
    const home = tempDir();
    const root = browserToolchainRoot(home);
    await installOnce(home, project);
    const live = readlinkSync(root);
    const version = (JSON.parse(
      readFileSync(join(root, "node_modules", "playwright-core", "package.json"), "utf8"),
    ) as { version: string }).version;

    const result = await installBrowserToolchain({
      cwd: project,
      home,
      run: fakeRunner({ failOn: "browsers" }).run,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("failed");
    expect(result.message).toContain("downloading the Chromium build failed");
    // Nothing was promoted: the old version is still live and still ready.
    expect(readlinkSync(root)).toBe(live);
    expect(
      (JSON.parse(readFileSync(join(root, "node_modules", "playwright-core", "package.json"), "utf8")) as {
        version: string;
      }).version,
    ).toBe(version);
    expect(result.status.ready).toBe(true);
    expect(existsSync(join(home, ".moh", LOCK_FILE))).toBe(false);
    expect(readdirSync(join(home, ".moh", VERSIONS_DIR))).toHaveLength(1);
  });

  test("a failed package step reports the cause and leaves no toolchain", async () => {
    const project = tempDir();
    const home = tempDir();
    const result = await installBrowserToolchain({
      cwd: project,
      home,
      run: fakeRunner({ failOn: "package" }).run,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("installing playwright-core failed");
    expect(result.message).toContain("boom in package");
    expect(existsSync(browserToolchainRoot(home))).toBe(false);
    expect(result.status.ready).toBe(false);
  });

  test("system dependencies are explicit only, and a failure explains the manual step", async () => {
    const project = tempDir();
    const home = tempDir();
    const runner = fakeRunner({ failOn: "deps" });
    const result = await installBrowserToolchain({ cwd: project, home, withDeps: true, run: runner.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(runner.phase("deps")?.args).toContain("install-deps");
    expect(result.message).toContain("system dependencies failed");
    expect(result.message).toContain("manually");
  });

  test("a concurrent install is refused while the lock is held", async () => {
    const project = tempDir();
    const home = tempDir();
    const mohHome = join(home, ".moh");
    mkdirSync(mohHome, { recursive: true });
    writeFileSync(join(mohHome, LOCK_FILE), lockPayload(process.pid));
    const runner = fakeRunner();
    const result = await installBrowserToolchain({ cwd: project, home, run: runner.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("busy");
    expect(result.message).toContain("another moh process");
    expect(runner.commands).toEqual([]);
    expect(existsSync(browserToolchainRoot(home))).toBe(false);
    // A live owner's lock is left alone.
    expect(existsSync(join(mohHome, LOCK_FILE))).toBe(true);
  });

  test("an abandoned lock (dead owner) is broken and the install proceeds", async () => {
    const project = tempDir();
    const home = tempDir();
    const mohHome = join(home, ".moh");
    mkdirSync(mohHome, { recursive: true });
    // A pid that cannot be alive, on this machine and boot: the owner is gone.
    writeFileSync(join(mohHome, LOCK_FILE), lockPayload(999_999_999));
    const runner = fakeRunner();
    const result = await installBrowserToolchain({ cwd: project, home, run: runner.run });
    expect(result.ok).toBe(true);
    expect(runner.phase("package")).toBeDefined();
    expect(existsSync(join(mohHome, LOCK_FILE))).toBe(false);
  });

  test("an interrupted install leaves the live toolchain usable", async () => {
    // The state a killed install leaves behind: a live toolchain, a
    // half-written staging directory, and a lock whose owner is gone.
    const project = tempDir();
    const home = tempDir();
    const mohHome = join(home, ".moh");
    await installOnce(home, project);
    const live = readlinkSync(browserToolchainRoot(home));
    mkdirSync(join(mohHome, VERSIONS_DIR, ".staging-999-1", "node_modules"), { recursive: true });
    writeFileSync(join(mohHome, LOCK_FILE), lockPayload(999_999_999));

    // Until a new install completes, the toolchain the user had still works.
    expect(probeBrowserToolchain({ cwd: project, home }).ready).toBe(true);
    const result = await installBrowserToolchain({ cwd: project, home, run: fakeRunner().run });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.ready).toBe(true);
    expect(readlinkSync(browserToolchainRoot(home))).not.toBe(live);
    expect(readdirSync(join(mohHome, VERSIONS_DIR))).toHaveLength(1);
  });

  test("an abandoned staging directory from a crashed install is pruned", async () => {
    const project = tempDir();
    const home = tempDir();
    const versions = join(home, ".moh", VERSIONS_DIR);
    const stale = join(versions, ".staging-4242-1");
    mkdirSync(stale, { recursive: true });
    const result = await installBrowserToolchain({ cwd: project, home, run: fakeRunner().run });
    expect(result.ok).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(versions)).toHaveLength(1);
  });
});
