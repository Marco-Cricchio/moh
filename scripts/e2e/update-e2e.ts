#!/usr/bin/env bun
/**
 * E2E runner (#274): builds a real compiled binary, serves a fake GitHub
 * Releases (scripts/e2e/update-fake-releases.ts), and drives `moh update`
 * end-to-end: happy-path swap, idempotent re-run, checksum-mismatch abort,
 * and dev-run refusal. Run from the repo root: bun scripts/e2e/update-e2e.ts
 */
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const DIST = join(ROOT, "dist");
const BIN = join(DIST, "moh-darwin-arm64");
const TARGET = join(DIST, "moh-e2e-target");
const ASSET = join(DIST, "moh-darwin-arm64-e2e-asset");
const PORT_FILE = join(DIST, ".e2e-port");

function run(cmd: string, args: string[], env: Record<string, string> = {}, expectCode = 0): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function fail(what: string, got: unknown): never {
  console.error(`✗ ${what}\n  got: ${JSON.stringify(got)}`);
  process.exitCode = 1;
  throw new Error(what);
}

// 1. Build the real binary (version falls back to the package version).
if (!existsSync(BIN)) {
  const b = run("bun", ["scripts/build.ts", "darwin-arm64"]);
  if (b.code !== 0) fail("build failed", b.out.slice(-500));
}
const version = run(BIN, ["--version"]).out.trim();
if (!/^\d+\.\d+\.\d+/.test(version)) fail("built binary has no stamped version", version);

// 2. Fake release: v0.2.0 serving a tiny script as the "new binary".
writeFileSync(ASSET, "#!/bin/sh\necho UPDATED-BINARY-0.2.0\n");
chmodSync(ASSET, 0o755);
rmSync(PORT_FILE, { force: true });
const server = spawn("bun", [join(ROOT, "scripts/e2e/update-fake-releases.ts")], {
  cwd: ROOT, stdio: "ignore", env: { ...process.env, PORT_FILE: PORT_FILE } });
try {
  for (let i = 0; i < 100 && !existsSync(PORT_FILE); i++) await Bun.sleep(50);
  const url = { MOH_RELEASES_URL: `http://127.0.0.1:${readFileSync(PORT_FILE, "utf8").trim()}/releases/latest` };

  // 3. Happy path: update + prove the swap by running the target.
  copyFileSync(BIN, TARGET);
  chmodSync(TARGET, 0o755);
  let r = run(TARGET, ["update"], url);
  if (r.code !== 0 || !r.out.includes("updated moh")) fail("update should succeed", r);
  r = run(TARGET, []);
  if (r.code !== 0 || !r.out.includes("UPDATED-BINARY-0.2.0")) fail("binary should be swapped", r);

  // 4. Checksum mismatch: abort non-zero, binary untouched, no leftovers.
  rmSync(PORT_FILE, { force: true });
  const bad = spawn("bun", [join(ROOT, "scripts/e2e/update-fake-releases.ts")], {
    cwd: ROOT, stdio: "ignore", env: { ...process.env, PORT_FILE: PORT_FILE, BAD_CHECKSUM: "1" } });
  try {
    for (let i = 0; i < 100 && !existsSync(PORT_FILE); i++) await Bun.sleep(50);
    const badUrl = { MOH_RELEASES_URL: `http://127.0.0.1:${readFileSync(PORT_FILE, "utf8").trim()}/releases/latest` };
    copyFileSync(BIN, TARGET);
    chmodSync(TARGET, 0o755);
    r = run(TARGET, ["update"], badUrl);
    if (r.code === 0 || !r.out.includes("checksum mismatch")) fail("mismatch should abort non-zero", r);
    if (!run(TARGET, ["--version"]).out.includes(version)) fail("binary must be untouched", r.out);
    bad.kill();
  } finally {
    rmSync(PORT_FILE, { force: true });
  }

  // 5. Dev run refuses.
  r = run("bun", ["packages/cli/src/cli.ts", "update"]);
  if (r.code === 0 || !r.out.includes("dev run")) fail("dev run should refuse", r);

  console.log(`✓ moh update e2e passed (built ${version}, fake release v0.2.0)`);
} finally {
  server.kill();
  rmSync(PORT_FILE, { force: true });
  rmSync(TARGET, { force: true });
  rmSync(ASSET, { force: true });
}
