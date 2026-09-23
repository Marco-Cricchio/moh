/**
 * End-to-end tests for scripts/install.sh (#269).
 *
 * Runs the real script against a local fake GitHub Release served by
 * Bun.serve, via the MOH_DOWNLOAD_BASE / MOH_INSTALL_DIR seams, in an
 * isolated HOME so nothing touches the developer machine.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { sha256File } from "./build";

const SCRIPT = join(import.meta.dir, "install.sh");
const PTY_RUN = join(import.meta.dir, "pty-run.py");
const python3 = Bun.which("python3");

/** Same platform mapping as scripts/install.sh — refuses to guess (no cross-arch fallback). */
function detectPlatform(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!os || !arch) {
    throw new Error(`test host platform unsupported: ${process.platform}/${process.arch}`);
  }
  return `${os}-${arch}`;
}
const PLATFORM = detectPlatform();

let home = "";
let installDir = "";
let servedBody = "";
let servedChecksum = "";
/** Fake `uname`/`id`/`mv` dirs created per test, removed in afterAll. */
const fakeBinDirs: string[] = [];
const binaryBody = `#!/bin/sh\necho "moh 0.1.0"\n`;
const badBody = `#!/bin/sh\necho "moh tampered"\n`;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const name = path.slice(1);
    if (name === "checksums.txt") return new Response(servedChecksum + "\n");
    if (name.startsWith("moh-")) return new Response(servedBody);
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  server.stop();
  for (const dir of fakeBinDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "moh-install-test-"));
  installDir = join(home, ".local/bin");
  serveBody(binaryBody);
});

function sha256Of(body: string): string {
  const p = join(home, "body");
  writeFileSync(p, body);
  return sha256File(p);
}

/** Serve `body` as the platform asset with its checksum line (or a mismatching one). */
function serveBody(body: string, checksumOf: string = body, platform: string = PLATFORM) {
  servedBody = body;
  servedChecksum = `${sha256Of(checksumOf)}  moh-${platform}`;
}

/**
 * A PATH directory holding a fake `uname`, so the script's platform detection
 * can be exercised for a host other than the one running the tests (#916).
 * `uname` is resolved through PATH (as in packages/cli/test/run-handoff.test.ts),
 * so no seam is added to the script itself.
 */
function fakeUname(os: string, arch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "moh-install-uname-"));
  fakeBinDirs.push(dir);
  const path = join(dir, "uname");
  writeFileSync(path, `#!/bin/sh\ncase "$1" in\n  -s) echo ${os} ;;\n  -m) echo ${arch} ;;\nesac\n`);
  chmodSync(path, 0o755);
  return dir;
}

/**
 * A PATH directory holding a fake `id` reporting `uid` (#917), so the root
 * branch is reachable without actually running the suite as root. Same
 * PATH-resolution pattern as `fakeUname`.
 */
function fakeId(uid: string): string {
  const dir = mkdtempSync(join(tmpdir(), "moh-install-id-"));
  fakeBinDirs.push(dir);
  const path = join(dir, "id");
  writeFileSync(path, `#!/bin/sh\necho ${uid}\n`);
  chmodSync(path, 0o755);
  return dir;
}

/**
 * A PATH directory holding a logging `mv` (#917): every call is appended to
 * `log` before the real `mv` runs, which is how the atomic-install test sees
 * *where* the binary was staged and renamed.
 */
function fakeMv(log: string): string {
  const dir = mkdtempSync(join(tmpdir(), "moh-install-mv-"));
  fakeBinDirs.push(dir);
  const real = Bun.which("mv");
  if (!real) throw new Error("no mv on PATH");
  const path = join(dir, "mv");
  writeFileSync(path, `#!/bin/sh\necho "$@" >> ${log}\nexec ${real} "$@"\n`);
  chmodSync(path, 0o755);
  return dir;
}

/** PATH with `dir` in front, so the fake `uname` wins over the real one. */
function pathWith(dir: string): string {
  return `${dir}:${process.env.PATH ?? ""}`;
}

/**
 * Async on purpose: Bun.spawnSync would block the event loop and deadlock
 * against the Bun.serve fake release in this same process (seen on Linux CI).
 */
async function runScript(extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["sh", SCRIPT], {
    env: { ...process.env, HOME: home, MOH_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}`, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * Runs the script through scripts/pty-run.py (#917), which decides whether
 * the child has a controlling terminal at all: the default mode attaches a
 * real pty (so `/dev/tty` is readable, and stdout/stderr arrive merged),
 * `noTty` starts a fresh session without one (pipes stay separate).
 */
async function runScriptTty(
  opts: { feed?: string; noTty?: boolean; env?: Record<string, string> } = {},
) {
  const args = [python3!, PTY_RUN];
  if (opts.noTty) args.push("--no-tty");
  if (opts.feed) args.push("--feed", Buffer.from(opts.feed).toString("base64"));
  args.push("--", "sh", SCRIPT);
  const proc = Bun.spawn(args, {
    env: {
      ...process.env,
      HOME: home,
      MOH_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}`,
      MOH_INSTALL_DIR: installDir,
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("install.sh (#269)", () => {
  test("installs the verified binary to MOH_INSTALL_DIR and runs --version", async () => {
    const r = await runScript({ MOH_INSTALL_DIR: installDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("checksum verified");
    expect(r.stdout).toContain(`installed moh → ${installDir}/moh`);
    expect(r.stdout).toContain("moh 0.1.0");
    expect(r.stdout).toContain("not on your PATH");
  });

  test("upgrade-over-itself: re-running replaces the binary in place", async () => {
    mkdirSync(installDir, { recursive: true });
    const old = join(installDir, "moh");
    writeFileSync(old, "#!/bin/sh\necho 'moh 0.0.1'\n");
    chmodSync(old, 0o755);
    const r = await runScript({ MOH_INSTALL_DIR: installDir });
    expect(r.exitCode).toBe(0);
    const out = Bun.spawnSync([old, "--version"], {});
    expect(String(out.stdout).trim()).toBe("moh 0.1.0");
  });

  test("checksum mismatch aborts with a clear error and installs nothing", async () => {
    serveBody(binaryBody, badBody);
    const r = await runScript({ MOH_INSTALL_DIR: installDir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("checksum mismatch");
    expect(existsSync(join(installDir, "moh"))).toBe(false);
  });

  test("missing checksum line for the platform aborts", async () => {
    servedBody = binaryBody;
    servedChecksum = `${sha256Of(binaryBody)}  moh-other-platform`;
    const r = await runScript({ MOH_INSTALL_DIR: installDir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("no checksum found");
  });

  test("download failure (no asset) aborts with the asset URL", async () => {
    const r = await runScript({
      MOH_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}/missing`,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("download failed");
    expect(r.stderr).toContain(`moh-${PLATFORM}`);
  });
});

describe("install.sh platform mapping (#916)", () => {
  test("maps Linux aarch64 → linux-arm64 and installs the arm64 asset", async () => {
    serveBody(binaryBody, binaryBody, "linux-arm64");
    const r = await runScript({ MOH_INSTALL_DIR: installDir, PATH: pathWith(fakeUname("Linux", "aarch64")) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("detected platform: linux-arm64");
    expect(r.stdout).toContain(`installed moh → ${installDir}/moh`);
  });

  test("accepts the arm64 spelling as well", async () => {
    serveBody(binaryBody, binaryBody, "linux-arm64");
    const r = await runScript({ MOH_INSTALL_DIR: installDir, PATH: pathWith(fakeUname("Linux", "arm64")) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("detected platform: linux-arm64");
  });

  test("refuses an unsupported architecture instead of falling back", async () => {
    const r = await runScript({ MOH_INSTALL_DIR: installDir, PATH: pathWith(fakeUname("Linux", "riscv64")) });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("unsupported platform: Linux riscv64");
  });
});

describe("install.sh WSL greeting (#917)", () => {
  test("detects WSL from WSL_DISTRO_NAME and prints both informational lines", async () => {
    const r = await runScript({ MOH_INSTALL_DIR: installDir, WSL_DISTRO_NAME: "Ubuntu" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("running inside WSL");
    expect(r.stdout).toContain("no native Windows build");
    expect(r.stdout).toContain("/mnt/c works, but is dramatically slower");
    // Informational, never blocking: the install still completes.
    expect(existsSync(join(installDir, "moh"))).toBe(true);
  });

  test("detects WSL from WSL_INTEROP alone", async () => {
    const r = await runScript({
      MOH_INSTALL_DIR: installDir,
      WSL_INTEROP: "/run/WSL/8_interop",
      MOH_PROC_VERSION_FILE: join(home, "absent"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("running inside WSL");
  });

  test("falls back to the /proc/version 'microsoft' marker", async () => {
    const procVersion = join(home, "proc-version");
    writeFileSync(procVersion, "Linux version 5.15.90.1-microsoft-standard-WSL2 (gcc) #1 SMP\n");
    const r = await runScript({
      MOH_INSTALL_DIR: installDir,
      WSL_DISTRO_NAME: "",
      WSL_INTEROP: "",
      MOH_PROC_VERSION_FILE: procVersion,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("running inside WSL");
  });

  test("stays silent on a plain Linux/macOS host", async () => {
    const procVersion = join(home, "proc-version");
    writeFileSync(procVersion, "Linux version 6.8.0-generic (gcc) #1 SMP\n");
    const r = await runScript({
      MOH_INSTALL_DIR: installDir,
      WSL_DISTRO_NAME: "",
      WSL_INTEROP: "",
      MOH_PROC_VERSION_FILE: procVersion,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("WSL");
  });
});

describe("install.sh root handling (#917)", () => {
  test.skipIf(!python3)("without a TTY: warns on stderr and proceeds", async () => {
    const r = await runScriptTty({ noTty: true, env: { PATH: pathWith(fakeId("0")) } });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("running as root");
    expect(r.stderr).toContain("no TTY to ask on — continuing");
    expect(existsSync(join(installDir, "moh"))).toBe(true);
  });

  test.skipIf(!python3)("with a TTY: asks on /dev/tty and proceeds on 'y'", async () => {
    const r = await runScriptTty({ feed: "y\n", env: { PATH: pathWith(fakeId("0")) } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Continue as root? [y/N]");
    expect(existsSync(join(installDir, "moh"))).toBe(true);
  });

  test.skipIf(!python3)("with a TTY: 'n' aborts with exit 1 and installs nothing", async () => {
    const r = await runScriptTty({ feed: "n\n", env: { PATH: pathWith(fakeId("0")) } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("aborted: you declined to install as root.");
    expect(existsSync(join(installDir, "moh"))).toBe(false);
  });

  test.skipIf(!python3)("with a TTY: an empty answer is a no", async () => {
    const r = await runScriptTty({ feed: "\n", env: { PATH: pathWith(fakeId("0")) } });
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(installDir, "moh"))).toBe(false);
  });

  test("as a normal user: no root warning at all", async () => {
    const r = await runScript({ MOH_INSTALL_DIR: installDir });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("running as root");
    expect(r.stdout).not.toContain("running as root");
  });
});

describe("install.sh smoke test before replacement (#917)", () => {
  test("a binary that cannot run aborts and leaves the previous install untouched", async () => {
    mkdirSync(installDir, { recursive: true });
    const old = join(installDir, "moh");
    writeFileSync(old, "#!/bin/sh\necho 'moh 0.0.1'\n");
    chmodSync(old, 0o755);
    serveBody("#!/bin/sh\nexit 127\n");
    const r = await runScript({ MOH_INSTALL_DIR: installDir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("cannot run on this system");
    expect(r.stderr).toContain("libc mismatch");
    expect(r.stderr).toContain("your existing moh is untouched");
    const out = Bun.spawnSync([old, "--version"], {});
    expect(String(out.stdout).trim()).toBe("moh 0.0.1");
  });

  test("a binary that runs but prints nothing is refused", async () => {
    serveBody("#!/bin/sh\nexit 0\n");
    const r = await runScript({ MOH_INSTALL_DIR: installDir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("printed nothing for --version");
    expect(existsSync(join(installDir, "moh"))).toBe(false);
  });
});

describe("install.sh atomic install (#917)", () => {
  test("stages the binary inside INSTALL_DIR and renames it within that directory", async () => {
    const log = join(home, "mv.log");
    const r = await runScript({ MOH_INSTALL_DIR: installDir, PATH: pathWith(fakeMv(log)) });
    expect(r.exitCode).toBe(0);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" "));
    const last = calls[calls.length - 1]!;
    expect(dirname(last[0]!)).toBe(installDir);
    expect(basename(last[0]!)).toMatch(/^\.moh\.tmp\.\d+$/);
    expect(last[1]).toBe(join(installDir, "moh"));
    // No staging leftovers next to the installed binary.
    expect(readdirSync(installDir)).toEqual(["moh"]);
  });
});

describe("install.sh PATH hint (#917)", () => {
  test("bash users are pointed at ~/.bashrc", async () => {
    const r = await runScript({ MOH_INSTALL_DIR: installDir, SHELL: "/bin/bash" });
    expect(r.stdout).toContain("not on your PATH");
    expect(r.stdout).toContain(">> ~/.bashrc");
  });

  test("zsh users are pointed at ~/.zshrc", async () => {
    const r = await runScript({ MOH_INSTALL_DIR: installDir, SHELL: "/usr/bin/zsh" });
    expect(r.stdout).toContain(">> ~/.zshrc");
  });

  test("an unknown or missing shell falls back to ~/.profile", async () => {
    const r = await runScript({ MOH_INSTALL_DIR: installDir, SHELL: "" });
    expect(r.stdout).toContain(">> ~/.profile");
  });

  test("no hint when INSTALL_DIR is already on PATH", async () => {
    const r = await runScript({ MOH_INSTALL_DIR: installDir, PATH: pathWith(installDir) });
    expect(r.stdout).not.toContain("not on your PATH");
  });
});
