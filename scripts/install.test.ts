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

function runScript(extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync(["sh", SCRIPT], {
    env: { ...process.env, HOME: home, MOH_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}`, ...extraEnv },
  });
}

function text(buf: Buffer | string): string {
  return typeof buf === "string" ? buf : buf.toString();
}

describe("install.sh (#269)", () => {
  test("installs the verified binary to MOH_INSTALL_DIR and runs --version", () => {
    const r = runScript({ MOH_INSTALL_DIR: installDir });
    expect(r.exitCode).toBe(0);
    expect(text(r.stdout)).toContain("checksum verified");
    expect(text(r.stdout)).toContain(`installed moh → ${installDir}/moh`);
    expect(text(r.stdout)).toContain("moh 0.1.0");
    expect(text(r.stdout)).toContain("not on your PATH");
  });

  test("upgrade-over-itself: re-running replaces the binary in place", () => {
    mkdirSync(installDir, { recursive: true });
    const old = join(installDir, "moh");
    writeFileSync(old, "#!/bin/sh\necho 'moh 0.0.1'\n");
    chmodSync(old, 0o755);
    const r = runScript({ MOH_INSTALL_DIR: installDir });
    expect(r.exitCode).toBe(0);
    const out = Bun.spawnSync([old, "--version"], {});
    expect(text(out.stdout).trim()).toBe("moh 0.1.0");
  });

  test("checksum mismatch aborts with a clear error and installs nothing", () => {
    serveBody(binaryBody, badBody);
    const r = runScript({ MOH_INSTALL_DIR: installDir });
    expect(r.exitCode).not.toBe(0);
    expect(text(r.stderr)).toContain("checksum mismatch");
    expect(existsSync(join(installDir, "moh"))).toBe(false);
  });

  test("missing checksum line for the platform aborts", () => {
    servedBody = binaryBody;
    servedChecksum = `${sha256Of(binaryBody)}  moh-other-platform`;
    const r = runScript({ MOH_INSTALL_DIR: installDir });
    expect(r.exitCode).not.toBe(0);
    expect(text(r.stderr)).toContain("no checksum found");
  });

  test("download failure (no asset) aborts with the asset URL", () => {
    const r = runScript({
      MOH_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}/missing`,
    });
    expect(r.exitCode).not.toBe(0);
    expect(text(r.stderr)).toContain("download failed");
    expect(text(r.stderr)).toContain(`moh-${PLATFORM}`);
  });
});
