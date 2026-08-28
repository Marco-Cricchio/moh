/**
 * End-to-end tests for scripts/install.sh (#269).
 *
 * Runs the real script against a local fake GitHub Release served by
 * Bun.serve, via the MOH_DOWNLOAD_BASE / MOH_INSTALL_DIR seams, in an
 * isolated HOME so nothing touches the developer machine.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256File } from "./build";

const SCRIPT = join(import.meta.dir, "install.sh");

/** Same platform mapping as scripts/install.sh — refuses to guess (no linux-arm64 → x64 fallback). */
function detectPlatform(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!os || !arch || `${os}-${arch}` === "linux-arm64") {
    throw new Error(`test host platform unsupported: ${process.platform}/${process.arch}`);
  }
  return `${os}-${arch}`;
}
const PLATFORM = detectPlatform();

let home = "";
let installDir = "";
let servedBody = "";
let servedChecksum = "";
const binaryBody = `#!/bin/sh\necho "moh 0.1.0"\n`;
const badBody = `#!/bin/sh\necho "moh tampered"\n`;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const name = path.slice(1);
    if (name === "checksums.txt") return new Response(servedChecksum + "\n");
    if (name === `moh-${PLATFORM}`) return new Response(servedBody);
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => server.stop());

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
function serveBody(body: string, checksumOf: string = body) {
  servedBody = body;
  servedChecksum = `${sha256Of(checksumOf)}  moh-${PLATFORM}`;
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
